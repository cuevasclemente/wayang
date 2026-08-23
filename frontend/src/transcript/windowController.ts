export type TranscriptIntentKind = "latest" | "around";

export interface TranscriptOpenIntent {
  kind: TranscriptIntentKind;
  anchorId?: string;
  requestKey: string;
}

export interface TranscriptAnchorStatus {
  requested_id: string;
  resolved_id: string | null;
  status: "found" | "missing" | "off_branch" | "pending";
}

export interface TranscriptWindowEnvelope<Message> {
  type: "transcript_window";
  session_id: string;
  selection_id?: string;
  request_id?: string;
  reason: "initial" | "prepend" | "append" | "tail_reconcile" | "reset";
  transcript_epoch: string;
  branch_tip_id: string | null;
  messages: Message[];
  streaming_message?: Message | null;
  before_cursor: string | null;
  after_cursor: string | null;
  has_older: boolean;
  has_newer: boolean;
  anchor?: TranscriptAnchorStatus;
  streaming_at_snapshot?: boolean;
  compacting_at_snapshot?: boolean;
  message_count: number;
  payload_bytes: number;
}

export interface TranscriptPageFlight {
  requestId: string;
  cursor: string;
}

export type TranscriptWindowMode = "awaiting" | "legacy" | "window-v1";

export interface TranscriptWindowState<Message> {
  mode: TranscriptWindowMode;
  sessionId: string | null;
  selectionId: string | null;
  intent: TranscriptOpenIntent;
  transcriptEpoch: string | null;
  branchTipId: string | null;
  messages: Message[];
  beforeCursor: string | null;
  afterCursor: string | null;
  hasOlder: boolean;
  hasNewer: boolean;
  anchor: TranscriptAnchorStatus | null;
  inFlightBefore: TranscriptPageFlight | null;
  inFlightAfter: TranscriptPageFlight | null;
  invalidated: boolean;
  error: string | null;
  lastAppliedRequestId: string | null;
  lastReason: TranscriptWindowEnvelope<Message>["reason"] | null;
  pendingTailEvents: boolean;
}

export type TranscriptWindowAction<Message> =
  | {
      type: "selection";
      sessionId: string | null;
      selectionId: string | null;
      intent: TranscriptOpenIntent;
    }
  | { type: "legacy_history"; messages: Message[] }
  | { type: "local_update"; updater: Message[] | ((messages: Message[]) => Message[]) }
  | { type: "page_requested"; direction: "before" | "after"; flight: TranscriptPageFlight }
  | { type: "page_failed"; direction: "before" | "after"; requestId: string; error: string }
  | { type: "window"; window: TranscriptWindowEnvelope<Message> }
  | { type: "invalidate"; error?: string }
  | { type: "tail_activity" }
  | { type: "clear_tail_activity" };

export function createTranscriptWindowState<Message>(
  intent: TranscriptOpenIntent = { kind: "latest", requestKey: "initial" },
): TranscriptWindowState<Message> {
  return {
    mode: "awaiting",
    sessionId: null,
    selectionId: null,
    intent,
    transcriptEpoch: null,
    branchTipId: null,
    messages: [],
    beforeCursor: null,
    afterCursor: null,
    hasOlder: false,
    hasNewer: false,
    anchor: null,
    inFlightBefore: null,
    inFlightAfter: null,
    invalidated: false,
    error: null,
    lastAppliedRequestId: null,
    lastReason: null,
    pendingTailEvents: false,
  };
}

function eventId(value: unknown): string | null {
  if (!value || typeof value !== "object") return null;
  const id = (value as { id?: unknown }).id;
  return typeof id === "string" && id.length > 0 ? id : null;
}

function canonicalEventValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalEventValue);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(
    Object.keys(record)
      .sort()
      .map((key) => [key, canonicalEventValue(record[key])]),
  );
}

function sameEvent(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  try {
    return JSON.stringify(canonicalEventValue(left)) === JSON.stringify(canonicalEventValue(right));
  } catch {
    return false;
  }
}

function mergeStableMessages<Message>(
  left: Message[],
  right: Message[],
): { messages: Message[]; conflictId: string | null } {
  const messages: Message[] = [];
  const byId = new Map<string, Message>();
  for (const message of [...left, ...right]) {
    const id = eventId(message);
    if (!id) {
      messages.push(message);
      continue;
    }
    const existing = byId.get(id);
    if (existing) {
      if (!sameEvent(existing, message)) return { messages: [], conflictId: id };
      continue;
    }
    byId.set(id, message);
    messages.push(message);
  }
  return { messages, conflictId: null };
}

function invalidatedState<Message>(
  state: TranscriptWindowState<Message>,
  error: string,
): TranscriptWindowState<Message> {
  return {
    ...state,
    messages: [],
    beforeCursor: null,
    afterCursor: null,
    hasOlder: false,
    hasNewer: false,
    inFlightBefore: null,
    inFlightAfter: null,
    invalidated: true,
    error,
    pendingTailEvents: false,
  };
}

export function transcriptWindowReducer<Message>(
  state: TranscriptWindowState<Message>,
  action: TranscriptWindowAction<Message>,
): TranscriptWindowState<Message> {
  switch (action.type) {
    case "selection":
      return {
        ...createTranscriptWindowState<Message>(action.intent),
        sessionId: action.sessionId,
        selectionId: action.selectionId,
      };
    case "legacy_history":
      return {
        ...state,
        mode: "legacy",
        messages: action.messages,
        transcriptEpoch: null,
        branchTipId: null,
        beforeCursor: null,
        afterCursor: null,
        hasOlder: false,
        hasNewer: false,
        anchor: null,
        inFlightBefore: null,
        inFlightAfter: null,
        invalidated: false,
        error: null,
        pendingTailEvents: false,
      };
    case "local_update": {
      const messages = typeof action.updater === "function"
        ? action.updater(state.messages)
        : action.updater;
      if (messages === state.messages) return state;
      // Live/local transcript events belong at the canonical tail. When this
      // projection is a historical island, never fabricate adjacency across
      // the unloaded newer range; retain the island and expose tail activity.
      if (state.mode === "window-v1" && state.hasNewer) {
        return { ...state, pendingTailEvents: true };
      }
      return { ...state, messages };
    }
    case "page_requested":
      return action.direction === "before"
        ? { ...state, inFlightBefore: action.flight, error: null }
        : { ...state, inFlightAfter: action.flight, error: null };
    case "page_failed": {
      const flight = action.direction === "before" ? state.inFlightBefore : state.inFlightAfter;
      if (flight?.requestId !== action.requestId) return state;
      return action.direction === "before"
        ? { ...state, inFlightBefore: null, error: action.error }
        : { ...state, inFlightAfter: null, error: action.error };
    }
    case "invalidate":
      return invalidatedState(state, action.error ?? "Transcript changed; waiting for a fresh bounded window.");
    case "tail_activity":
      return state.mode === "window-v1" && state.hasNewer
        ? { ...state, pendingTailEvents: true }
        : state;
    case "clear_tail_activity":
      return state.pendingTailEvents ? { ...state, pendingTailEvents: false } : state;
    case "window": {
      const incoming = action.window;
      if (state.sessionId !== incoming.session_id) return state;

      const replacesProjection = incoming.reason === "initial"
        || incoming.reason === "reset"
        || state.mode !== "window-v1";
      const changedEpoch = state.transcriptEpoch !== null
        && state.transcriptEpoch !== incoming.transcript_epoch;

      if (changedEpoch && !replacesProjection && incoming.reason !== "tail_reconcile") {
        return invalidatedState(state, "Transcript revision changed while a page was loading. Reopen the bounded window.");
      }

      if (replacesProjection || changedEpoch) {
        return {
          ...state,
          mode: "window-v1",
          transcriptEpoch: incoming.transcript_epoch,
          branchTipId: incoming.branch_tip_id,
          messages: incoming.messages,
          beforeCursor: incoming.before_cursor,
          afterCursor: incoming.after_cursor,
          hasOlder: incoming.has_older,
          hasNewer: incoming.has_newer,
          anchor: incoming.anchor ?? null,
          inFlightBefore: null,
          inFlightAfter: null,
          invalidated: false,
          error: null,
          lastAppliedRequestId: incoming.request_id ?? null,
          lastReason: incoming.reason,
          pendingTailEvents: false,
        };
      }

      if (incoming.reason === "prepend") {
        if (!incoming.request_id || state.inFlightBefore?.requestId !== incoming.request_id) return state;
        const merged = mergeStableMessages(incoming.messages, state.messages);
        if (merged.conflictId) {
          return invalidatedState(state, `Conflicting transcript event ${merged.conflictId} arrived in one revision.`);
        }
        return {
          ...state,
          mode: "window-v1",
          branchTipId: incoming.branch_tip_id,
          messages: merged.messages,
          beforeCursor: incoming.before_cursor,
          hasOlder: incoming.has_older,
          inFlightBefore: null,
          invalidated: false,
          error: null,
          lastAppliedRequestId: incoming.request_id,
          lastReason: incoming.reason,
        };
      }

      if (incoming.reason === "append") {
        if (!incoming.request_id || state.inFlightAfter?.requestId !== incoming.request_id) return state;
        const merged = mergeStableMessages(state.messages, incoming.messages);
        if (merged.conflictId) {
          return invalidatedState(state, `Conflicting transcript event ${merged.conflictId} arrived in one revision.`);
        }
        return {
          ...state,
          mode: "window-v1",
          branchTipId: incoming.branch_tip_id,
          messages: merged.messages,
          afterCursor: incoming.after_cursor,
          hasNewer: incoming.has_newer,
          inFlightAfter: null,
          invalidated: false,
          error: null,
          lastAppliedRequestId: incoming.request_id,
          lastReason: incoming.reason,
          pendingTailEvents: false,
        };
      }

      // A reconcile is authoritative at the tail. Merge it only when the loaded
      // segment already reaches the tail; otherwise retain the historical
      // island and expose the explicit newer-range gap/jump affordance.
      if (state.hasNewer) {
        return {
          ...state,
          branchTipId: incoming.branch_tip_id,
          hasNewer: true,
          pendingTailEvents: true,
          lastAppliedRequestId: incoming.request_id ?? null,
          lastReason: incoming.reason,
        };
      }
      const merged = mergeStableMessages(state.messages, incoming.messages);
      if (merged.conflictId) {
        return invalidatedState(state, `Conflicting transcript event ${merged.conflictId} arrived in one revision.`);
      }
      return {
        ...state,
        branchTipId: incoming.branch_tip_id,
        messages: merged.messages,
        afterCursor: incoming.after_cursor,
        hasNewer: incoming.has_newer,
        inFlightAfter: null,
        invalidated: false,
        error: null,
        lastAppliedRequestId: incoming.request_id ?? null,
        lastReason: incoming.reason,
        pendingTailEvents: false,
      };
    }
  }
}

export const MAX_TRANSCRIPT_WINDOW_MESSAGES = 200;
export const MAX_TRANSCRIPT_WINDOW_CONTENT_BYTES = 512 * 1024;

export type TranscriptPageErrorClass = "terminal" | "transient";

/**
 * Cursor and projection-identity failures cannot succeed with the same opaque
 * cursor. Unknown operational failures remain retryable so temporary I/O or
 * index availability does not unnecessarily discard a valid loaded window.
 */
export function classifyTranscriptPageErrorCode(code: unknown): TranscriptPageErrorClass {
  if (typeof code !== "string") return "transient";
  const normalized = code.trim().toLowerCase().replace(/[^a-z0-9]+/g, "_");
  if (!normalized) return "transient";
  return [
    "cursor",
    "revision",
    "epoch",
    "session",
    "selection",
    "path",
    "source",
    "file",
    "branch",
    "stale",
  ].some((identity) => normalized.includes(identity))
    || normalized === "transcript_changed"
    || normalized === "transcript_invalidated"
    ? "terminal"
    : "transient";
}

function serializedBytes(value: unknown): number | null {
  try {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) return null;
    return new TextEncoder().encode(serialized).byteLength;
  } catch {
    return null;
  }
}

/** Serialized canonical rows plus the separate live overlay payload. */
export function serializedTranscriptWindowContentBytes(value: {
  messages: unknown[];
  streaming_message?: unknown;
}): number | null {
  return serializedBytes({
    messages: value.messages,
    ...(value.streaming_message === undefined
      ? {}
      : { streaming_message: value.streaming_message }),
  });
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Returns a stable machine-readable reason for malformed modern frames. The
 * function is intentionally pure/exported for backend-independent unit/E2E
 * fixtures even though the frontend package currently has no unit-test runner.
 */
export function transcriptWindowValidationError(value: unknown): string | null {
  if (!value || typeof value !== "object") return "not_object";
  const message = value as Record<string, unknown>;
  if (message.type !== "transcript_window") return "wrong_type";
  if (!nonEmptyString(message.session_id)) return "invalid_session_id";
  if (message.selection_id !== undefined && !nonEmptyString(message.selection_id)) return "invalid_selection_id";
  if (!nonEmptyString(message.transcript_epoch)) return "invalid_transcript_epoch";
  if (message.branch_tip_id !== null && !nonEmptyString(message.branch_tip_id)) return "invalid_branch_tip_id";

  const reason = message.reason;
  if (!["initial", "prepend", "append", "tail_reconcile", "reset"].includes(String(reason))) {
    return "invalid_reason";
  }
  const pageReason = reason === "prepend" || reason === "append";
  if (pageReason ? !nonEmptyString(message.request_id) : message.request_id !== undefined) {
    return "request_reason_mismatch";
  }

  if (!Array.isArray(message.messages)) return "invalid_messages";
  if (message.messages.length > MAX_TRANSCRIPT_WINDOW_MESSAGES) return "message_limit_exceeded";
  const messageIds = new Set<string>();
  for (const candidate of message.messages) {
    if (!candidate || typeof candidate !== "object") return "invalid_message";
    const id = (candidate as Record<string, unknown>).id;
    if (!nonEmptyString(id)) return "missing_message_id";
    if (messageIds.has(id)) return "duplicate_message_id";
    messageIds.add(id);
  }

  const streamingMessage = message.streaming_message;
  if (streamingMessage !== undefined && streamingMessage !== null) {
    if (!streamingMessage || typeof streamingMessage !== "object") return "invalid_streaming_message";
    const streamingRecord = streamingMessage as Record<string, unknown>;
    const nestedMessage = streamingRecord.message && typeof streamingRecord.message === "object"
      ? streamingRecord.message as Record<string, unknown>
      : null;
    const streamingRole = streamingRecord.role ?? nestedMessage?.role;
    const streamingType = streamingRecord.type;
    if (
      !["assistant", "toolResult", "tool_result"].includes(String(streamingType))
      && streamingRole !== "assistant"
      && streamingRole !== "toolResult"
      && streamingRole !== "tool_result"
    ) return "invalid_streaming_message_type";
    if (message.streaming_at_snapshot !== true) return "streaming_message_without_streaming_snapshot";
  }
  if (message.streaming_at_snapshot !== undefined && typeof message.streaming_at_snapshot !== "boolean") {
    return "invalid_streaming_snapshot_flag";
  }
  if (message.compacting_at_snapshot !== undefined && typeof message.compacting_at_snapshot !== "boolean") {
    return "invalid_compacting_snapshot_flag";
  }

  if (!Number.isSafeInteger(message.message_count) || (message.message_count as number) < 0) {
    return "invalid_message_count";
  }
  if (message.message_count !== message.messages.length) return "message_count_mismatch";
  if (!Number.isSafeInteger(message.payload_bytes) || (message.payload_bytes as number) < 0) {
    return "invalid_payload_bytes";
  }
  if ((message.payload_bytes as number) > MAX_TRANSCRIPT_WINDOW_CONTENT_BYTES) return "declared_payload_limit_exceeded";
  const actualBytes = serializedTranscriptWindowContentBytes({
    messages: message.messages,
    ...(streamingMessage === undefined ? {} : { streaming_message: streamingMessage }),
  });
  if (actualBytes === null) return "unserializable_content";
  if (actualBytes > MAX_TRANSCRIPT_WINDOW_CONTENT_BYTES) return "content_limit_exceeded";

  if (message.before_cursor !== null && !nonEmptyString(message.before_cursor)) return "invalid_before_cursor";
  if (message.after_cursor !== null && !nonEmptyString(message.after_cursor)) return "invalid_after_cursor";
  if (typeof message.has_older !== "boolean" || typeof message.has_newer !== "boolean") return "invalid_edge_flags";
  const beforeEdgeConsistent = message.has_older === (message.before_cursor !== null);
  const afterEdgeConsistent = message.has_newer === (message.after_cursor !== null);
  if (reason === "initial" || reason === "reset") {
    if (!beforeEdgeConsistent) return "before_cursor_edge_mismatch";
    if (!afterEdgeConsistent) return "after_cursor_edge_mismatch";
  } else if (reason === "prepend") {
    // The response's before edge is newly navigable. Its newer adjacency is
    // already represented by the client's loaded segment, so has_newer may be
    // true without minting a redundant after cursor.
    if (!beforeEdgeConsistent) return "before_cursor_edge_mismatch";
  } else {
    // Append and authoritative tail reconciliation own the after edge. Their
    // older adjacency may already be represented by loaded client state.
    if (!afterEdgeConsistent) return "after_cursor_edge_mismatch";
  }

  const anchor = message.anchor;
  if (anchor !== undefined) {
    if ((reason !== "initial" && reason !== "reset") || !anchor || typeof anchor !== "object") {
      return "anchor_reason_mismatch";
    }
    const record = anchor as Record<string, unknown>;
    if (!nonEmptyString(record.requested_id)) return "invalid_anchor_requested_id";
    if (!["found", "missing", "off_branch", "pending"].includes(String(record.status))) {
      return "invalid_anchor_status";
    }
    if (record.status === "found") {
      if (!nonEmptyString(record.resolved_id)) return "found_anchor_without_resolution";
      if (!messageIds.has(record.resolved_id)) return "resolved_anchor_not_in_window";
    } else if (record.resolved_id !== null) {
      return "unavailable_anchor_has_resolution";
    }
  }
  return null;
}

export function isTranscriptWindowEnvelope<Message = Record<string, unknown>>(
  value: unknown,
): value is TranscriptWindowEnvelope<Message> {
  return transcriptWindowValidationError(value) === null;
}
