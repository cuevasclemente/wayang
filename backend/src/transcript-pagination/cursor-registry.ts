import { randomBytes } from "node:crypto";

export type TranscriptCursorDirection = "before" | "after";

export interface TranscriptCursorBinding {
  sessionId: string;
  selectionId: string;
  transcriptEpoch: string;
  direction: TranscriptCursorDirection;
}

export interface TranscriptCursorRecord<T> extends TranscriptCursorBinding {
  state: T;
  expiresAt: number;
}

export type TranscriptCursorFailure =
  | "unknown_cursor"
  | "expired_cursor"
  | "session_mismatch"
  | "selection_mismatch"
  | "epoch_mismatch"
  | "direction_mismatch";

export class TranscriptCursorError extends Error {
  constructor(readonly code: TranscriptCursorFailure) {
    super(code.replaceAll("_", " "));
    this.name = "TranscriptCursorError";
  }
}

/** Process-local opaque cursor registry. Tokens contain no path, offset, or identity data. */
export class TranscriptCursorRegistry<T> {
  private readonly records = new Map<string, TranscriptCursorRecord<T>>();

  constructor(
    private readonly options: { maxEntries?: number; ttlMs?: number; now?: () => number } = {},
  ) {}

  issue(binding: TranscriptCursorBinding, state: T): string {
    this.sweep();
    const token = randomBytes(32).toString("base64url");
    this.records.set(token, {
      ...binding,
      state,
      expiresAt: this.now() + (this.options.ttlMs ?? 10 * 60_000),
    });
    const maxEntries = this.options.maxEntries ?? 4_096;
    while (this.records.size > maxEntries) {
      const oldest = this.records.keys().next().value as string | undefined;
      if (!oldest) break;
      this.records.delete(oldest);
    }
    return token;
  }

  resolve(token: string, expected: TranscriptCursorBinding): TranscriptCursorRecord<T> {
    const record = this.records.get(token);
    if (!record) throw new TranscriptCursorError("unknown_cursor");
    if (record.expiresAt <= this.now()) {
      this.records.delete(token);
      throw new TranscriptCursorError("expired_cursor");
    }
    if (record.sessionId !== expected.sessionId) throw new TranscriptCursorError("session_mismatch");
    if (record.selectionId !== expected.selectionId) throw new TranscriptCursorError("selection_mismatch");
    if (record.transcriptEpoch !== expected.transcriptEpoch) throw new TranscriptCursorError("epoch_mismatch");
    if (record.direction !== expected.direction) throw new TranscriptCursorError("direction_mismatch");
    // LRU refresh without changing the opaque token or expiry.
    this.records.delete(token);
    this.records.set(token, record);
    return record;
  }

  invalidateSession(sessionId: string): void {
    for (const [token, record] of this.records) {
      if (record.sessionId === sessionId) this.records.delete(token);
    }
  }

  invalidateSelection(sessionId: string, selectionId: string): void {
    for (const [token, record] of this.records) {
      if (record.sessionId === sessionId && record.selectionId === selectionId) this.records.delete(token);
    }
  }

  clear(): void {
    this.records.clear();
  }

  get size(): number {
    this.sweep();
    return this.records.size;
  }

  private now(): number {
    return (this.options.now ?? Date.now)();
  }

  private sweep(): void {
    const now = this.now();
    for (const [token, record] of this.records) {
      if (record.expiresAt <= now) this.records.delete(token);
    }
  }
}
