/**
 * Shared, in-memory approval bridge for connector actions initiated by pi.
 *
 * The bridge exposes display metadata only. Connector credentials and raw
 * arguments must remain behind the connector boundary; callers identify the
 * exact proposed call with argumentsHash.
 */

import { randomUUID } from "node:crypto";

export interface ExternalActionRequest {
  requestId: string;
  sessionId: string;
  connector: string;
  workspace?: string;
  toolName: string;
  target?: string;
  summary: string;
  argumentsHash: string;
  createdAt: number;
  timeoutMs: number;
}

export interface ExternalActionRequestInput {
  connector: string;
  workspace?: string;
  toolName: string;
  target?: string;
  summary: string;
  argumentsHash: string;
}

export type ApprovalTerminalStatus = "approved" | "denied" | "timeout" | "cancelled";
export type ApprovalResponseStatus = "approved" | "denied" | "stale" | "rejected";

export interface ApprovalResponse {
  status: ApprovalResponseStatus;
  reason?: string;
}

export interface ApprovalTerminalEvent {
  requestId: string;
  sessionId: string;
  status: ApprovalTerminalStatus;
}

export interface ApprovalRequestOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface ActionApprovalBridge {
  attachClient(sessionId: string, clientId: string): () => void;
  hasClient(sessionId: string): boolean;
  requestApproval(
    sessionId: string,
    input: ExternalActionRequestInput,
    options?: ApprovalRequestOptions,
  ): Promise<ApprovalTerminalStatus>;
  respondForSession(
    sessionId: string,
    requestId: string,
    argumentsHash: string,
    approved: boolean,
  ): ApprovalResponse;
  cancelRequest(requestId: string, reason?: string): boolean;
  cancelSession(sessionId: string, reason?: string): void;
  onRequest(callback: (request: ExternalActionRequest) => void): () => void;
  onTerminal(callback: (event: ApprovalTerminalEvent) => void): () => void;
  getPendingRequests(sessionId: string): ExternalActionRequest[];
}

type RequestCallback = (request: ExternalActionRequest) => void;
type TerminalCallback = (event: ApprovalTerminalEvent) => void;

interface PendingApproval {
  request: ExternalActionRequest;
  resolve: (status: ApprovalTerminalStatus) => void;
  timer: ReturnType<typeof setTimeout>;
  signal?: AbortSignal;
  abortHandler?: () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;

function cloneRequest(request: ExternalActionRequest): ExternalActionRequest {
  return {
    requestId: request.requestId,
    sessionId: request.sessionId,
    connector: request.connector,
    ...(request.workspace === undefined ? {} : { workspace: request.workspace }),
    toolName: request.toolName,
    ...(request.target === undefined ? {} : { target: request.target }),
    summary: request.summary,
    argumentsHash: request.argumentsHash,
    createdAt: request.createdAt,
    timeoutMs: request.timeoutMs,
  };
}

function cloneTerminalEvent(event: ApprovalTerminalEvent): ApprovalTerminalEvent {
  return {
    requestId: event.requestId,
    sessionId: event.sessionId,
    status: event.status,
  };
}

export class PiActionApprovalBridge implements ActionApprovalBridge {
  private readonly clients = new Map<string, Map<string, number>>();
  private readonly pending = new Map<string, PendingApproval>();
  private readonly requestListeners = new Set<RequestCallback>();
  private readonly terminalListeners = new Set<TerminalCallback>();

  attachClient(sessionId: string, clientId: string): () => void {
    let sessionClients = this.clients.get(sessionId);
    if (!sessionClients) {
      sessionClients = new Map<string, number>();
      this.clients.set(sessionId, sessionClients);
    }
    sessionClients.set(clientId, (sessionClients.get(clientId) ?? 0) + 1);

    let detached = false;
    return () => {
      if (detached) return;
      detached = true;

      const currentClients = this.clients.get(sessionId);
      const references = currentClients?.get(clientId);
      if (!currentClients || references === undefined) return;

      if (references > 1) currentClients.set(clientId, references - 1);
      else currentClients.delete(clientId);
      if (currentClients.size === 0) this.clients.delete(sessionId);
    };
  }

  hasClient(sessionId: string): boolean {
    return (this.clients.get(sessionId)?.size ?? 0) > 0;
  }

  requestApproval(
    sessionId: string,
    input: ExternalActionRequestInput,
    options: ApprovalRequestOptions = {},
  ): Promise<ApprovalTerminalStatus> {
    const request: ExternalActionRequest = {
      requestId: randomUUID(),
      sessionId,
      connector: input.connector,
      ...(input.workspace === undefined ? {} : { workspace: input.workspace }),
      toolName: input.toolName,
      ...(input.target === undefined ? {} : { target: input.target }),
      summary: input.summary,
      argumentsHash: input.argumentsHash,
      createdAt: Date.now(),
      timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    };

    if (!this.hasClient(sessionId)) {
      this.emitTerminal({ requestId: request.requestId, sessionId, status: "denied" });
      return Promise.resolve("denied");
    }

    if (options.signal?.aborted) {
      this.emitTerminal({ requestId: request.requestId, sessionId, status: "cancelled" });
      return Promise.resolve("cancelled");
    }

    return new Promise<ApprovalTerminalStatus>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(request.requestId, "timeout");
      }, request.timeoutMs);
      const abortHandler = options.signal
        ? () => {
            this.finish(request.requestId, "cancelled");
          }
        : undefined;

      this.pending.set(request.requestId, {
        request,
        resolve,
        timer,
        signal: options.signal,
        abortHandler,
      });
      if (options.signal && abortHandler) {
        options.signal.addEventListener("abort", abortHandler, { once: true });
      }

      this.emitRequest(request);
    });
  }

  respondForSession(
    sessionId: string,
    requestId: string,
    argumentsHash: string,
    approved: boolean,
  ): ApprovalResponse {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return { status: "stale", reason: "request is no longer pending" };
    }
    if (
      pending.request.sessionId !== sessionId ||
      pending.request.argumentsHash !== argumentsHash
    ) {
      return { status: "rejected", reason: "request identity mismatch" };
    }

    const status: ApprovalTerminalStatus = approved ? "approved" : "denied";
    this.finish(requestId, status);
    return { status };
  }

  cancelRequest(requestId: string, _reason?: string): boolean {
    return this.finish(requestId, "cancelled");
  }

  cancelSession(sessionId: string, reason?: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.request.sessionId === sessionId) {
        this.cancelRequest(requestId, reason);
      }
    }
  }

  onRequest(callback: RequestCallback): () => void {
    this.requestListeners.add(callback);
    return () => {
      this.requestListeners.delete(callback);
    };
  }

  onTerminal(callback: TerminalCallback): () => void {
    this.terminalListeners.add(callback);
    return () => {
      this.terminalListeners.delete(callback);
    };
  }

  getPendingRequests(sessionId: string): ExternalActionRequest[] {
    const requests: ExternalActionRequest[] = [];
    for (const pending of this.pending.values()) {
      if (pending.request.sessionId === sessionId) {
        requests.push(cloneRequest(pending.request));
      }
    }
    return requests;
  }

  private finish(requestId: string, status: ApprovalTerminalStatus): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    if (pending.signal && pending.abortHandler) {
      pending.signal.removeEventListener("abort", pending.abortHandler);
    }

    pending.resolve(status);
    this.emitTerminal({
      requestId: pending.request.requestId,
      sessionId: pending.request.sessionId,
      status,
    });
    return true;
  }

  private emitRequest(request: ExternalActionRequest): void {
    for (const listener of this.requestListeners) {
      try {
        listener(cloneRequest(request));
      } catch {}
    }
  }

  private emitTerminal(event: ApprovalTerminalEvent): void {
    for (const listener of this.terminalListeners) {
      try {
        listener(cloneTerminalEvent(event));
      } catch {}
    }
  }
}

type ActionApprovalGlobal = typeof globalThis & {
  __pi_action_approval_bridge?: PiActionApprovalBridge;
};

export function getActionApprovalBridge(): PiActionApprovalBridge {
  const scope = globalThis as ActionApprovalGlobal;
  if (!scope.__pi_action_approval_bridge) {
    scope.__pi_action_approval_bridge = new PiActionApprovalBridge();
  }
  return scope.__pi_action_approval_bridge;
}
