/**
 * Shared, in-memory approval bridge for connector actions initiated by pi.
 *
 * The bridge exposes display metadata only. Connector credentials and raw
 * arguments must remain behind the connector boundary; callers identify the
 * exact proposed call with argumentsHash.
 */

import { createHash, randomUUID } from "node:crypto";
import type { SettingsPinAttemptPort } from "./workspace-capability-approval/types.js";

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
export type ApprovalResponseErrorCode =
  | "request_not_pending"
  | "request_identity_mismatch"
  | "invalid_decision"
  | "realm_busy"
  | "cooldown"
  | "pin_unavailable"
  | "wrong_pin"
  | "request_expired";

export interface ApprovalDecision {
  status: ApprovalTerminalStatus;
  requestId: string | null;
  sessionId: string;
  argumentsHash: string;
}

export interface ApprovalResponse {
  status: ApprovalResponseStatus;
  errorCode?: ApprovalResponseErrorCode;
  retryAt?: number;
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
  ): Promise<ApprovalDecision>;
  /** Accepts untrusted transport input; approval additionally requires one PIN attempt. */
  respondForSession(
    sessionId: string,
    requestId: string,
    argumentsHash: string,
    approved: unknown,
    pin?: unknown,
  ): Promise<ApprovalResponse>;
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
  expiresAt: number;
  resolve: (decision: ApprovalDecision) => void;
  timer: ReturnType<typeof setTimeout>;
  approvalInProgress: boolean;
  removeAbortListener?: () => void;
}

const DEFAULT_TIMEOUT_MS = 120_000;
const MAX_TIMEOUT_MS = 300_000;
const MAX_SUMMARY_BYTES = 64 * 1_024;
const MAX_SESSION_ID_BYTES = 512;
const MAX_CONNECTOR_BYTES = 256;
const MAX_WORKSPACE_BYTES = 256;
const MAX_TOOL_NAME_BYTES = 256;
const MAX_TARGET_BYTES = 2_048;
const MAX_PIN_BYTES = 1_024;
const EXTERNAL_ACTION_APPROVAL_REALM = "wayang.external-actions.v1";
const UNSAFE_METADATA_PATTERN = /[\p{Cc}\p{Cf}\p{Cs}]/u;
const UNSAFE_SUMMARY_PATTERN = /[\p{Cf}\p{Cs}\u0000-\u0008\u000b-\u000c\u000e-\u001f\u007f-\u009f]/u;
const ARGUMENTS_HASH_PATTERN = /^[0-9a-fA-F]{64}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type AbortListenerMethod = (
  this: Record<string, unknown>,
  type: "abort",
  listener: () => void,
  options?: { once: boolean },
) => unknown;

interface ValidatedAbortSignal {
  aborted: boolean;
  add(listener: () => void): boolean;
  remove(listener: () => void): void;
  readAborted(): boolean | null;
}

const abortSignalAbortedGetter = Object.getOwnPropertyDescriptor(
  AbortSignal.prototype,
  "aborted",
)?.get;

function readAbortSignalAborted(value: AbortSignal): boolean | null {
  try {
    const aborted = abortSignalAbortedGetter?.call(value);
    return typeof aborted === "boolean" ? aborted : null;
  } catch {
    return null;
  }
}

function validateAbortSignal(value: unknown): ValidatedAbortSignal | null {
  if (!isRecord(value) || !(value instanceof AbortSignal)) return null;

  const aborted = readAbortSignalAborted(value);
  if (aborted === null) return null;

  let addEventListener: unknown;
  let removeEventListener: unknown;
  try {
    addEventListener = value.addEventListener;
    removeEventListener = value.removeEventListener;
  } catch {
    return null;
  }
  if (
    typeof addEventListener !== "function"
    || typeof removeEventListener !== "function"
  ) {
    return null;
  }

  const add = addEventListener as AbortListenerMethod;
  const remove = removeEventListener as AbortListenerMethod;
  const tryRemove = (listener: () => void): boolean => {
    try {
      remove.call(value, "abort", listener);
      return true;
    } catch {
      return false;
    }
  };
  const probe = () => {};
  try {
    add.call(value, "abort", probe, { once: true });
  } catch {
    tryRemove(probe);
    return null;
  }
  if (!tryRemove(probe)) return null;

  return {
    aborted,
    add(listener) {
      try {
        add.call(value, "abort", listener, { once: true });
        return true;
      } catch {
        tryRemove(listener);
        return false;
      }
    },
    remove(listener) {
      tryRemove(listener);
    },
    readAborted() {
      return readAbortSignalAborted(value);
    },
  };
}

function isBoundedMetadata(value: unknown, maxBytes: number): value is string {
  return (
    typeof value === "string"
    && value.length > 0
    && Buffer.byteLength(value, "utf8") <= maxBytes
    && !UNSAFE_METADATA_PATTERN.test(value)
  );
}

function isBoundedSummary(value: unknown): value is string {
  return typeof value === "string"
    && Buffer.byteLength(value, "utf8") > 0
    && Buffer.byteLength(value, "utf8") <= MAX_SUMMARY_BYTES
    && !UNSAFE_SUMMARY_PATTERN.test(value);
}

function approvalOperationDigest(pending: PendingApproval): string {
  const request = pending.request;
  return createHash("sha256").update(JSON.stringify({
    realm: EXTERNAL_ACTION_APPROVAL_REALM,
    requestId: request.requestId,
    sessionId: request.sessionId,
    connector: request.connector,
    workspace: request.workspace ?? null,
    toolName: request.toolName,
    target: request.target ?? null,
    summary: request.summary,
    argumentsHash: request.argumentsHash,
    createdAt: request.createdAt,
    timeoutMs: request.timeoutMs,
    expiresAt: pending.expiresAt,
  })).digest("hex");
}

function deniedAdmissionDecision(
  sessionId: unknown,
  argumentsHash: unknown,
): ApprovalDecision {
  return {
    status: "denied",
    requestId: null,
    sessionId: typeof sessionId === "string" ? sessionId : "",
    argumentsHash: typeof argumentsHash === "string" ? argumentsHash : "",
  };
}

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
  private pinAttempts: SettingsPinAttemptPort | undefined;

  constructor(pinAttempts?: SettingsPinAttemptPort) {
    this.pinAttempts = pinAttempts;
  }

  /** Production installs exactly one shared hardened attempt authority. */
  installPinAttempts(pinAttempts: SettingsPinAttemptPort): void {
    if (this.pinAttempts && this.pinAttempts !== pinAttempts
      && (this.clients.size > 0 || this.pending.size > 0)) {
      throw new Error("External-action PIN attempt authority cannot change while approvals are live");
    }
    this.pinAttempts = pinAttempts;
  }

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
  ): Promise<ApprovalDecision> {
    const runtimeInput: unknown = input;
    const runtimeOptions: unknown = options;
    const inputRecord = isRecord(runtimeInput) ? runtimeInput : null;
    const argumentsHash = inputRecord?.argumentsHash;
    if (!inputRecord || !isRecord(runtimeOptions)) {
      return Promise.resolve(deniedAdmissionDecision(sessionId, argumentsHash));
    }

    const connector = inputRecord.connector;
    const workspace = inputRecord.workspace;
    const toolName = inputRecord.toolName;
    const target = inputRecord.target;
    const summary = inputRecord.summary;
    const timeoutValue = runtimeOptions.timeoutMs;
    const timeoutMs = timeoutValue === undefined ? DEFAULT_TIMEOUT_MS : timeoutValue;
    if (
      !isBoundedMetadata(sessionId, MAX_SESSION_ID_BYTES)
      || !isBoundedMetadata(connector, MAX_CONNECTOR_BYTES)
      || (workspace !== undefined && !isBoundedMetadata(workspace, MAX_WORKSPACE_BYTES))
      || !isBoundedMetadata(toolName, MAX_TOOL_NAME_BYTES)
      || (target !== undefined && !isBoundedMetadata(target, MAX_TARGET_BYTES))
      || !isBoundedSummary(summary)
      || typeof argumentsHash !== "string"
      || !ARGUMENTS_HASH_PATTERN.test(argumentsHash)
      || typeof timeoutMs !== "number"
      || !Number.isFinite(timeoutMs)
      || !Number.isInteger(timeoutMs)
      || timeoutMs < 1
      || timeoutMs > MAX_TIMEOUT_MS
    ) {
      return Promise.resolve(deniedAdmissionDecision(sessionId, argumentsHash));
    }

    const signalValue = runtimeOptions.signal;
    const signal = signalValue === undefined ? undefined : validateAbortSignal(signalValue);
    if (signalValue !== undefined && !signal) {
      return Promise.resolve(deniedAdmissionDecision(sessionId, argumentsHash));
    }

    if (!this.hasClient(sessionId)) {
      const requestId = randomUUID();
      this.emitTerminal({ requestId, sessionId, status: "denied" });
      return Promise.resolve(deniedAdmissionDecision(sessionId, argumentsHash));
    }

    const now = Date.now();
    for (const [requestId, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue;
      if (now >= pending.expiresAt) {
        this.finish(requestId, "timeout");
        continue;
      }
      return Promise.resolve(deniedAdmissionDecision(sessionId, argumentsHash));
    }

    const createRequest = (): ExternalActionRequest => ({
      requestId: randomUUID(),
      sessionId,
      connector,
      ...(workspace === undefined ? {} : { workspace }),
      toolName,
      ...(target === undefined ? {} : { target }),
      summary,
      argumentsHash,
      createdAt: now,
      timeoutMs,
    });

    if (signal?.aborted) {
      const request = createRequest();
      this.emitTerminal({ requestId: request.requestId, sessionId, status: "cancelled" });
      return Promise.resolve({
        status: "cancelled",
        requestId: request.requestId,
        sessionId: request.sessionId,
        argumentsHash: request.argumentsHash,
      });
    }

    let pendingCreated = false;
    let abortedDuringSetup = false;
    let requestId: string | undefined;
    const abortHandler = signal
      ? () => {
          if (!pendingCreated || !requestId) {
            abortedDuringSetup = true;
            return;
          }
          this.finish(requestId, "cancelled");
        }
      : undefined;
    if (signal && abortHandler && !signal.add(abortHandler)) {
      return Promise.resolve(deniedAdmissionDecision(sessionId, argumentsHash));
    }

    const abortedAfterRegistration = signal?.readAborted();
    if (abortedAfterRegistration === null) {
      if (signal && abortHandler) signal.remove(abortHandler);
      return Promise.resolve(deniedAdmissionDecision(sessionId, argumentsHash));
    }

    const request = createRequest();
    requestId = request.requestId;
    if (abortedDuringSetup || abortedAfterRegistration === true) {
      if (signal && abortHandler) signal.remove(abortHandler);
      this.emitTerminal({ requestId: request.requestId, sessionId, status: "cancelled" });
      return Promise.resolve({
        status: "cancelled",
        requestId: request.requestId,
        sessionId: request.sessionId,
        argumentsHash: request.argumentsHash,
      });
    }

    return new Promise<ApprovalDecision>((resolve) => {
      const timer = setTimeout(() => {
        this.finish(request.requestId, "timeout");
      }, request.timeoutMs);

      this.pending.set(request.requestId, {
        request: Object.freeze(request),
        expiresAt: request.createdAt + request.timeoutMs,
        resolve,
        timer,
        approvalInProgress: false,
        ...(signal && abortHandler
          ? { removeAbortListener: () => signal.remove(abortHandler) }
          : {}),
      });
      pendingCreated = true;
      this.emitRequest(request);
    });
  }

  async respondForSession(
    sessionId: string,
    requestId: string,
    argumentsHash: string,
    approved: unknown,
    pin?: unknown,
  ): Promise<ApprovalResponse> {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return { status: "stale", errorCode: "request_not_pending" };
    }
    if (Date.now() >= pending.expiresAt) {
      this.finish(requestId, "timeout");
      return { status: "stale", errorCode: "request_expired" };
    }
    if (
      pending.request.sessionId !== sessionId
      || pending.request.argumentsHash !== argumentsHash
    ) {
      return { status: "rejected", errorCode: "request_identity_mismatch" };
    }
    if (approved !== true && approved !== false) {
      return { status: "rejected", errorCode: "invalid_decision" };
    }

    // Denial is deliberately PIN-free, including while an approval attempt is
    // awaiting the adapter. The racing attempt rechecks this exact object and
    // can never approve after terminal denial.
    if (approved === false) {
      this.finish(requestId, "denied");
      return { status: "denied" };
    }
    if (pending.approvalInProgress) {
      return { status: "rejected", errorCode: "realm_busy" };
    }

    const pinAttempts = this.pinAttempts;
    if (!pinAttempts) {
      this.finish(requestId, "denied");
      return { status: "denied", errorCode: "pin_unavailable" };
    }

    pending.approvalInProgress = true;
    const reservationId = randomUUID();
    const reservationInput = {
      realm: EXTERNAL_ACTION_APPROVAL_REALM,
      reservationId,
      requestId: pending.request.requestId,
      operationDigest: approvalOperationDigest(pending),
      expiresAt: pending.expiresAt,
    };
    let reservation: Awaited<ReturnType<SettingsPinAttemptPort["reserve"]>>;
    try {
      reservation = await pinAttempts.reserve(reservationInput);
    } catch {
      if (this.pending.get(requestId) !== pending) {
        return { status: "stale", errorCode: "request_not_pending" };
      }
      this.finish(requestId, "denied");
      return { status: "denied", errorCode: "pin_unavailable" };
    }

    if (reservation.status === "cooldown" || reservation.status === "busy") {
      if (reservation.status === "cooldown"
        && (!Number.isSafeInteger(reservation.retryAt) || reservation.retryAt < 0)) {
        if (this.pending.get(requestId) !== pending) {
          return { status: "stale", errorCode: "request_not_pending" };
        }
        this.finish(requestId, "denied");
        return { status: "denied", errorCode: "pin_unavailable" };
      }
      if (this.pending.get(requestId) !== pending) {
        return { status: "stale", errorCode: "request_not_pending" };
      }
      if (Date.now() >= pending.expiresAt) {
        this.finish(requestId, "timeout");
        return { status: "stale", errorCode: "request_expired" };
      }
      pending.approvalInProgress = false;
      return reservation.status === "cooldown"
        ? { status: "rejected", errorCode: "cooldown", retryAt: reservation.retryAt }
        : { status: "rejected", errorCode: "realm_busy" };
    }
    if (reservation.status === "unavailable") {
      if (this.pending.get(requestId) !== pending) {
        return { status: "stale", errorCode: "request_not_pending" };
      }
      this.finish(requestId, "denied");
      return { status: "denied", errorCode: "pin_unavailable" };
    }

    // A denial, cancellation, or timeout can race the durable reservation.
    // Consume that orphaned reservation best-effort and never revive the action.
    if (this.pending.get(requestId) !== pending || Date.now() >= pending.expiresAt) {
      const expired = this.pending.get(requestId) === pending;
      if (expired) this.finish(requestId, "timeout");
      await pinAttempts.cancelAndConsume({
        realm: EXTERNAL_ACTION_APPROVAL_REALM,
        reservationId,
        requestId: pending.request.requestId,
        reason: expired ? "expired" : "backend_failure",
        now: Date.now(),
      }).catch(() => undefined);
      return expired
        ? { status: "stale", errorCode: "request_expired" }
        : { status: "stale", errorCode: "request_not_pending" };
    }

    let verification: Awaited<ReturnType<SettingsPinAttemptPort["verifyAndConsume"]>>;
    try {
      verification = await pinAttempts.verifyAndConsume({
        realm: EXTERNAL_ACTION_APPROVAL_REALM,
        reservationId,
        requestId: pending.request.requestId,
        // Malformed and oversized values still perform one opaque adapter
        // attempt, using a bounded guaranteed-wrong candidate.
        pin: typeof pin === "string" && Buffer.byteLength(pin, "utf8") <= MAX_PIN_BYTES ? pin : "",
        now: Date.now(),
      });
    } catch {
      await pinAttempts.cancelAndConsume({
        realm: EXTERNAL_ACTION_APPROVAL_REALM,
        reservationId,
        requestId: pending.request.requestId,
        reason: "backend_failure",
        now: Date.now(),
      }).catch(() => undefined);
      if (this.pending.get(requestId) !== pending) {
        return { status: "stale", errorCode: "request_not_pending" };
      }
      this.finish(requestId, "denied");
      return { status: "denied", errorCode: "pin_unavailable" };
    }

    if (this.pending.get(requestId) !== pending) {
      return { status: "stale", errorCode: "request_not_pending" };
    }
    if (verification.status === "verified") {
      if (Date.now() >= pending.expiresAt) {
        this.finish(requestId, "timeout");
        return { status: "stale", errorCode: "request_expired" };
      }
      this.finish(requestId, "approved");
      return { status: "approved" };
    }
    if (verification.status === "expired") {
      this.finish(requestId, "timeout");
      return { status: "stale", errorCode: "request_expired" };
    }

    // A wrong/malformed PIN and unavailable verification both consume and
    // terminally deny this exact action. Neither can be retried.
    this.finish(requestId, "denied");
    return verification.status === "wrong_pin"
      ? { status: "denied", errorCode: "wrong_pin" }
      : { status: "denied", errorCode: "pin_unavailable" };
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
    const now = Date.now();
    for (const [requestId, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue;
      if (now >= pending.expiresAt) {
        this.finish(requestId, "timeout");
        continue;
      }
      requests.push(cloneRequest(pending.request));
    }
    return requests;
  }

  private finish(requestId: string, status: ApprovalTerminalStatus): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;

    this.pending.delete(requestId);
    clearTimeout(pending.timer);
    pending.removeAbortListener?.();

    pending.resolve({
      status,
      requestId: pending.request.requestId,
      sessionId: pending.request.sessionId,
      argumentsHash: pending.request.argumentsHash,
    });
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
  __pi_action_approval_pin_attempts?: SettingsPinAttemptPort;
};

export function installActionApprovalPinAttempts(pinAttempts: SettingsPinAttemptPort): void {
  const scope = globalThis as ActionApprovalGlobal;
  scope.__pi_action_approval_bridge?.installPinAttempts(pinAttempts);
  scope.__pi_action_approval_pin_attempts = pinAttempts;
}

export function getActionApprovalBridge(): PiActionApprovalBridge {
  const scope = globalThis as ActionApprovalGlobal;
  if (!scope.__pi_action_approval_bridge) {
    scope.__pi_action_approval_bridge = new PiActionApprovalBridge(scope.__pi_action_approval_pin_attempts);
  }
  return scope.__pi_action_approval_bridge;
}
