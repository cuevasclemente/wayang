import type { MatrixClient } from "./client.js";
import { validateMatrixRoomId, validateMatrixUserId } from "./identifiers.js";

export interface MatrixTypingAuthorizationPort {
  authorize(input: MatrixTypingTarget): Promise<boolean>;
}

export interface MatrixTypingTarget {
  readonly endpointId: string;
  readonly roomId: string;
  readonly personaUserId: string;
}

export interface MatrixGatewayEphemeralEffectPort {
  runWithTyping<T>(endpointId: string, operation: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface MatrixTypingTargetResolver {
  resolve(endpointId: string): Promise<MatrixTypingTarget | null>;
}

export interface MatrixTypingTimerPort {
  setTimeout(callback: () => void, delayMs: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface MatrixTypingControllerOptions {
  readonly client: Pick<MatrixClient, "setTyping">;
  readonly authorization: MatrixTypingAuthorizationPort;
  readonly timer?: MatrixTypingTimerPort;
  readonly typingTimeoutMs?: number;
  readonly refreshMs?: number;
}

interface ActiveTyping {
  readonly target: MatrixTypingTarget;
  timer: unknown | null;
  refresh: Promise<void> | null;
  clearing: Promise<void> | null;
}

const systemTimer: MatrixTypingTimerPort = {
  setTimeout: (callback, delayMs) => setTimeout(callback, delayMs),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class MatrixTypingController {
  private readonly timer: MatrixTypingTimerPort;
  private readonly typingTimeoutMs: number;
  private readonly refreshMs: number;
  private readonly active = new Map<string, ActiveTyping>();
  private closed = false;
  private closePromise: Promise<void> | null = null;

  constructor(private readonly options: MatrixTypingControllerOptions) {
    this.timer = options.timer ?? systemTimer;
    this.typingTimeoutMs = options.typingTimeoutMs ?? 20_000;
    this.refreshMs = options.refreshMs ?? Math.floor(this.typingTimeoutMs / 2);
    if (!Number.isInteger(this.typingTimeoutMs) || this.typingTimeoutMs < 1_000 || this.typingTimeoutMs > 30_000
      || !Number.isInteger(this.refreshMs) || this.refreshMs < 500 || this.refreshMs >= this.typingTimeoutMs) {
      throw new Error("Invalid Matrix typing refresh bounds");
    }
  }

  private key(target: MatrixTypingTarget): string {
    validateMatrixRoomId(target.roomId);
    validateMatrixUserId(target.personaUserId);
    if (!target.endpointId || Buffer.byteLength(target.endpointId, "utf8") > 128) throw new Error("Invalid Matrix typing endpoint");
    return `${target.roomId}\0${target.personaUserId}`;
  }

  /** Typing effects are best effort and never alter the durable operation result. */
  async run<T>(target: MatrixTypingTarget, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return operation();
    let authorized = false;
    try {
      authorized = await this.options.authorization.authorize(target);
    } catch { /* no ephemeral effect without fresh authorization */ }
    if (!authorized || this.closed) return operation();
    await this.begin(target);
    try {
      return await operation();
    } finally {
      await this.clear(target);
    }
  }

  private async begin(target: MatrixTypingTarget): Promise<void> {
    const key = this.key(target);
    if (this.active.has(key) || this.closed) return;
    const entry: ActiveTyping = { target: Object.freeze({ ...target }), timer: null, refresh: null, clearing: null };
    this.active.set(key, entry);
    try {
      await this.options.client.setTyping(target.roomId, target.personaUserId, true, this.typingTimeoutMs);
    } catch { /* typing failure does not fail the accepted operation */ }
    if (this.active.get(key) === entry && !this.closed) this.schedule(key, entry);
  }

  private schedule(key: string, entry: ActiveTyping): void {
    entry.timer = this.timer.setTimeout(() => {
      entry.timer = null;
      if (this.active.get(key) !== entry || this.closed) return;
      entry.refresh = (async () => {
        try {
          if (await this.options.authorization.authorize(entry.target)) {
            await this.options.client.setTyping(
              entry.target.roomId, entry.target.personaUserId, true, this.typingTimeoutMs,
            );
          }
        } catch { /* refresh remains best effort */ }
      })().finally(() => {
        entry.refresh = null;
        if (this.active.get(key) === entry && !this.closed) this.schedule(key, entry);
      });
    }, this.refreshMs);
  }

  async clear(target: MatrixTypingTarget): Promise<void> {
    const key = this.key(target);
    const entry = this.active.get(key);
    if (!entry) return;
    if (entry.clearing) return entry.clearing;
    this.active.delete(key);
    if (entry.timer !== null) this.timer.clearTimeout(entry.timer);
    entry.clearing = (async () => {
      await entry.refresh?.catch(() => undefined);
      try {
        await this.options.client.setTyping(target.roomId, target.personaUserId, false, this.typingTimeoutMs);
      } catch { /* clear is idempotent and best effort */ }
    })();
    return entry.clearing;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    const targets = [...this.active.values()].map((entry) => entry.target);
    this.closePromise = Promise.allSettled(targets.map((target) => this.clear(target))).then(() => undefined);
    return this.closePromise;
  }
}

/** Gateway adapter: callers invoke this only for an admitted operation. */
export function createMatrixGatewayEphemeralEffectPort(
  controller: MatrixTypingController,
  targets: MatrixTypingTargetResolver,
): MatrixGatewayEphemeralEffectPort {
  return Object.freeze({
    async runWithTyping<T>(endpointId: string, operation: () => Promise<T>): Promise<T> {
      let target: MatrixTypingTarget | null = null;
      try { target = await targets.resolve(endpointId); } catch { /* no effect without an exact current target */ }
      return target ? controller.run(target, operation) : operation();
    },
    close: () => controller.close(),
  });
}
