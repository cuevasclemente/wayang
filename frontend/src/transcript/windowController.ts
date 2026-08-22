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

export function isTranscriptWindowEnvelope<Message = Record<string, unknown>>(
  value: unknown,
): value is TranscriptWindowEnvelope<Message> {
  if (!value || typeof value !== "object") return false;
  const message = value as Record<string, unknown>;
  const validReason = message.reason === "initial"
    || message.reason === "prepend"
    || message.reason === "append"
    || message.reason === "tail_reconcile"
    || message.reason === "reset";
  const anchor = message.anchor;
  const validAnchor = anchor === undefined || Boolean(
    anchor
    && typeof anchor === "object"
    && typeof (anchor as Record<string, unknown>).requested_id === "string"
    && (((anchor as Record<string, unknown>).resolved_id === null)
      || typeof (anchor as Record<string, unknown>).resolved_id === "string")
    && ["found", "missing", "off_branch", "pending"].includes(
      String((anchor as Record<string, unknown>).status),
    ),
  );
  return message.type === "transcript_window"
    && typeof message.session_id === "string"
    && (message.selection_id === undefined || typeof message.selection_id === "string")
    && (message.request_id === undefined || typeof message.request_id === "string")
    && validReason
    && typeof message.transcript_epoch === "string"
    && (message.branch_tip_id === null || typeof message.branch_tip_id === "string")
    && Array.isArray(message.messages)
    && (message.before_cursor === null || typeof message.before_cursor === "string")
    && (message.after_cursor === null || typeof message.after_cursor === "string")
    && typeof message.has_older === "boolean"
    && typeof message.has_newer === "boolean"
    && validAnchor
    && typeof message.message_count === "number"
    && Number.isFinite(message.message_count)
    && typeof message.payload_bytes === "number"
    && Number.isFinite(message.payload_bytes);
}
