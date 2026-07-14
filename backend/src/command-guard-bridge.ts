/**
 * command-guard-bridge.ts — Shared bridge for command-guard identity PIN prompts.
 *
 * The command guard uses this bridge when no TUI is available. The backend
 * relays an identity PIN challenge to the owning browser session and resolves
 * the waiting guard with the submitted PIN. PIN values are never persisted.
 */

import { randomUUID } from "node:crypto";

export interface CommandGuardIdentityRequest {
  requestId: string;
  sessionId: string;
  prompt: string;
  command?: string;
  reason?: string;
}

interface PendingCommandGuardIdentityRequest extends CommandGuardIdentityRequest {
  timer: ReturnType<typeof setTimeout>;
  resolve: (pin: string | null) => void;
}

interface CommandGuardIdentityRequestOptions {
  command?: string;
  reason?: string;
}

type RequestCallback = (req: CommandGuardIdentityRequest) => void;

class PiCommandGuardIdentityBridge {
  private pending = new Map<string, PendingCommandGuardIdentityRequest>();
  private listeners = new Set<RequestCallback>();

  requestIdentityPin(
    sessionId: string,
    prompt = "Identity PIN required",
    timeoutMs = 120_000,
    options: CommandGuardIdentityRequestOptions = {},
  ): Promise<string | null> {
    return new Promise<string | null>((resolve) => {
      const requestId = randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(requestId);
        resolve(null);
      }, timeoutMs);

      const req: PendingCommandGuardIdentityRequest = {
        requestId,
        sessionId,
        prompt,
        command: options.command,
        reason: options.reason,
        timer,
        resolve,
      };
      this.pending.set(requestId, req);
      this.emitRequest({ requestId, sessionId, prompt, command: options.command, reason: options.reason });
    });
  }

  resolve(requestId: string, pin: string | null): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve(pin && pin.length > 0 ? pin : null);
    return true;
  }

  resolveForSession(sessionId: string, requestId: string, pin: string | null): boolean {
    const pending = this.pending.get(requestId);
    if (!pending || pending.sessionId !== sessionId) return false;
    return this.resolve(requestId, pin);
  }

  cancel(requestId: string): boolean {
    return this.resolve(requestId, null);
  }

  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.resolve(null);
      }
    }
  }

  onRequest(callback: RequestCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  getPendingRequests(sessionId: string): CommandGuardIdentityRequest[] {
    const requests: CommandGuardIdentityRequest[] = [];
    for (const pending of this.pending.values()) {
      if (pending.sessionId === sessionId) {
        requests.push({
          requestId: pending.requestId,
          sessionId: pending.sessionId,
          prompt: pending.prompt,
          command: pending.command,
          reason: pending.reason,
        });
      }
    }
    return requests;
  }

  private emitRequest(req: CommandGuardIdentityRequest): void {
    for (const listener of this.listeners) {
      try { listener(req); } catch {}
    }
  }
}

export function getCommandGuardIdentityBridge(): PiCommandGuardIdentityBridge {
  if (!(globalThis as any).__pi_command_guard_identity_bridge) {
    (globalThis as any).__pi_command_guard_identity_bridge = new PiCommandGuardIdentityBridge();
  }
  return (globalThis as any).__pi_command_guard_identity_bridge;
}

export { PiCommandGuardIdentityBridge };
