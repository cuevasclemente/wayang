/**
 * sudo-bridge.ts — Shared bridge for sudo password prompts in web/SDK mode.
 *
 * The sudo hook uses this bridge when no TUI is available. The backend relays
 * a password request to connected browser clients over the existing WebSocket
 * session and resolves the waiting hook with the submitted password.
 *
 * Passwords are never persisted here. They live only in memory long enough to
 * resolve a pending request; the sudo hook owns its own in-memory per-session
 * cache after validation.
 */

import { randomUUID } from "node:crypto";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SudoRequestKind = "password" | "approval";

export interface SudoRequestOrigin {
  mode: "parent" | "long-lived" | "one-shot";
  lineage: string[];
}

export interface SudoRequest {
  requestId: string;
  sessionId: string;
  prompt: string;
  kind: SudoRequestKind;
  /** Legacy display-only field retained during the broker migration. */
  command?: string;
  executable?: string;
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
  origin?: SudoRequestOrigin;
}

// ---------------------------------------------------------------------------
// Pending state
// ---------------------------------------------------------------------------

interface PendingSudoRequestBase extends SudoRequest {
  timer: ReturnType<typeof setTimeout>;
}

interface PendingPasswordRequest extends PendingSudoRequestBase {
  kind: "password";
  resolve: (password: string | null) => void;
}

interface PendingApprovalRequest extends PendingSudoRequestBase {
  kind: "approval";
  resolve: (approved: boolean) => void;
}

type PendingSudoRequest = PendingPasswordRequest | PendingApprovalRequest;

export interface SudoRequestOptions {
  /** Legacy display-only field retained during the broker migration. */
  command?: string;
  executable?: string;
  argv?: string[];
  cwd?: string;
  timeoutMs?: number;
  origin?: SudoRequestOrigin;
}

function safeRequestMetadata(options: SudoRequestOptions): SudoRequestOptions {
  return {
    command: options.command,
    executable: options.executable,
    argv: options.argv ? [...options.argv] : undefined,
    cwd: options.cwd,
    timeoutMs: options.timeoutMs,
    origin: options.origin
      ? { mode: options.origin.mode, lineage: [...options.origin.lineage] }
      : undefined,
  };
}

type RequestCallback = (req: SudoRequest) => void;
// The owner UI intentionally renders one exact sudo gate at a time.
const MAX_PENDING_SUDO_REQUESTS_PER_SESSION = 1;

class PiSudoBridge {
  private pending = new Map<string, PendingSudoRequest>();
  private listeners = new Set<RequestCallback>();

  /**
   * Create a sudo password request and resolve with the submitted password, or
   * null if the user cancels/times out. The password is not stored after resolve.
   */
  requestPassword(
    sessionId: string,
    prompt = "Sudo password required",
    timeoutMs = 120_000,
    options: SudoRequestOptions = {},
  ): Promise<string | null> {
    if (this.getPendingCount(sessionId) >= MAX_PENDING_SUDO_REQUESTS_PER_SESSION) return Promise.resolve(null);
    return new Promise<string | null>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);

      const metadata = safeRequestMetadata(options);
      this.pending.set(requestId, {
        requestId,
        sessionId,
        prompt,
        kind: "password",
        ...metadata,
        resolve,
        timer,
      });

      this.emitRequest({ requestId, sessionId, prompt, kind: "password", ...metadata });
    });
  }

  /** Ask the owning browser thread to approve/deny a cached-password sudo command. */
  requestApproval(
    sessionId: string,
    prompt = "Approve sudo command?",
    timeoutMs = 120_000,
    options: SudoRequestOptions = {},
  ): Promise<boolean> {
    if (this.getPendingCount(sessionId) >= MAX_PENDING_SUDO_REQUESTS_PER_SESSION) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(false);
      }, timeoutMs);

      const metadata = safeRequestMetadata(options);
      this.pending.set(requestId, {
        requestId,
        sessionId,
        prompt,
        kind: "approval",
        ...metadata,
        resolve,
        timer,
      });

      this.emitRequest({ requestId, sessionId, prompt, kind: "approval", ...metadata });
    });
  }

  /** Backwards-compatible alias for early web hook builds. */
  createRequest(
    sessionId: string,
    prompt = "Sudo password required",
    timeoutMs = 120_000,
    options: SudoRequestOptions = {},
  ): Promise<string | null> {
    return this.requestPassword(sessionId, prompt, timeoutMs, options);
  }

  /** Resolve a pending sudo password request. Prefer resolveForSession from websocket handlers. */
  resolve(requestId: string, password: string | null): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== "password") return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(password && password.length > 0 ? password : null);
    return true;
  }

  /** Resolve a password request only when it belongs to the active web session/thread. */
  resolveForSession(sessionId: string, requestId: string, password: string | null): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    return this.resolve(requestId, password);
  }

  /** Resolve a pending sudo approval request. Prefer approveForSession from websocket handlers. */
  approve(requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.kind !== "approval") return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(approved);
    return true;
  }

  /** Resolve an approval request only when it belongs to the active web session/thread. */
  approveForSession(sessionId: string, requestId: string, approved: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    return this.approve(requestId, approved);
  }

  /** Cancel a pending sudo request. */
  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    if (pending.kind === "approval") return this.approve(requestId, false);
    return this.resolve(requestId, null);
  }

  /** Cancel all pending sudo requests for a session. */
  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        if (pending.kind === "approval") pending.resolve(false);
        else pending.resolve(null);
      }
    }
  }

  private emitRequest(req: SudoRequest): void {
    for (const listener of this.listeners) {
      try { listener(req); } catch {}
    }
  }

  /** Register a listener for new sudo requests. */
  onRequest(callback: RequestCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Return pending prompt metadata for a session; never includes password data. */
  getPendingRequests(sessionId: string): SudoRequest[] {
    const requests: SudoRequest[] = [];
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) {
        requests.push({
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          prompt: pending.prompt,
          kind: pending.kind,
          ...safeRequestMetadata(pending),
        });
      }
    }
    return requests;
  }

  /** Exposed for diagnostics/tests only; never includes password data. */
  getPendingCount(sessionId?: string): number {
    if (!sessionId) return this.pending.size;
    let count = 0;
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) count++;
    }
    return count;
  }
}

// ---------------------------------------------------------------------------
// Singleton
// ---------------------------------------------------------------------------

/** Get or create the singleton bridge (stored on globalThis for extensions). */
export function getSudoBridge(): PiSudoBridge {
  if (!(globalThis as any).__pi_sudo_bridge) {
    (globalThis as any).__pi_sudo_bridge = new PiSudoBridge();
  }
  return (globalThis as any).__pi_sudo_bridge;
}

export { PiSudoBridge };
