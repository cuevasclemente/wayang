/**
 * @wayang/protocol — WebSocket wire types for the Wayang chat transport.
 *
 * One WebSocket per open session at `/ws/chat?session_id=…&selection_id=…`.
 * All frames are JSON text messages with a string `type` discriminator.
 *
 * Source of truth: `backend/src/routes/ws.ts` (serializers) and
 * `backend/src/pi-bridge.ts` (`serializeEvent`, history serializers).
 *
 * Envelope conventions (historical, preserved for compatibility):
 *  - Chat-stream messages carry snake_case `session_id` and, when the client
 *    connected with a `selection_id`, an optional snake_case `selection_id`.
 *  - The interactive-surface messages (external actions, interviews, sudo,
 *    command-guard PIN) carry camelCase `sessionId`; selection-bound ones also
 *    carry snake_case `selection_id`.
 *  - `error` and `command_guard_state` may omit the session envelope entirely.
 *
 * Evolution policy: additive-only. Consumers MUST ignore unknown message
 * types and unknown fields without crashing. New message types and new
 * optional fields may be added at any time; existing types and fields are
 * never removed, renamed, or retyped within a major protocol version.
 */

import type { BashMode } from "./rest.js";

// ===========================================================================
// Client → Server
// ===========================================================================

export interface ChatAttachment {
  name?: string;
  mimeType?: string;
  /** base64-encoded bytes */
  data: string;
  size?: number;
}

/**
 * Send a user prompt. `client_message_id` correlates the later
 * `queued_message_ack`; it must match /^[A-Za-z0-9._:-]{1,128}$/ when present.
 * Slash commands (e.g. "/model provider/model", "/compact") are sent as
 * ordinary `content`; the backend handles the built-ins it knows and forwards
 * the rest to pi.
 */
export interface SendMessage {
  type: "message";
  content: string;
  client_message_id?: string;
  attachments?: ChatAttachment[];
}

/** Cancel a previously queued (not yet claimed) message by correlation id. */
export interface CancelQueuedMessage {
  type: "cancel_queued_message";
  client_message_id: string;
}

/** Replay a persisted user message from history. */
export interface ResendMessage {
  type: "resend";
  message_id: string;
}

/** Interrupt the running turn. `clear_queue` defaults to true. */
export interface Interrupt {
  type: "interrupt";
  clear_queue?: boolean;
}

/** Reserved; currently a server-side no-op. */
export interface SetPermission {
  type: "set_permission";
  mode: string;
}

/** Set or clear the session goal. */
export interface SetGoal {
  type: "set_goal";
  goal: string | null;
  status?: string | null;
}

/** Change or refresh the command-guard mode for the live session. */
export interface SetCommandGuard {
  type: "command_guard";
  mode: string;
  announce?: boolean;
  pin?: string;
}

/**
 * Move this socket to another session. The server replays the full attach
 * sequence (`session_loading` → `session_ready` → `history` → snapshots) for
 * the new session on the same connection.
 */
export type TranscriptProtocol = "window-v1";
export type TranscriptIntent = "latest" | "around";

/** Optional transcript projection requested for one exact session selection. */
export interface TranscriptSelection {
  protocol: TranscriptProtocol;
  intent: TranscriptIntent;
  anchor_id?: string;
}

export interface SwitchSession {
  type: "switch_session";
  session_id: string;
  selection_id?: string | null;
  transcript?: TranscriptSelection;
}

/** Request one adjacent page using an opaque, selection-bound server token. */
export interface TranscriptPageRequest {
  type: "transcript_page_request";
  request_id: string;
  direction: "before" | "after";
  cursor: string;
}

/**
 * Declared by the ws.ts protocol header. Currently ignored by the server
 * (reserved); do not rely on it in v1 clients.
 */
export interface SubagentSpawn {
  type: "subagent_spawn";
  agent: string;
  task: string;
  mode: "single" | "parallel" | "chain";
}

/** Approve or deny a pending `external_action_request`. */
export interface ExternalActionResponse {
  type: "external_action_response";
  requestId: string;
  sessionId: string;
  selection_id: string;
  argumentsHash: string;
  approved: boolean;
  pin?: string;
}

/** Answer a `command_guard_pin_request`. PINs are never persisted. */
export interface CommandGuardPinResponse {
  type: "command_guard_pin_response";
  requestId: string;
  sessionId: string;
  selection_id: string;
  pin?: string;
  cancelled?: boolean;
}

/** Submit answers for an `interview_request`. */
export interface InterviewResponseMessage {
  type: "interview_response";
  requestId: string;
  answers: InterviewAnswer[];
}

/** Dismiss an `interview_request` without answering. */
export interface InterviewCancelMessage {
  type: "interview_cancel";
  requestId: string;
}

/**
 * Answer a `sudo_request`. Exactly one resolution path applies: `cancelled`,
 * boolean `approved` (for kind="approval"), or a `password` (for
 * kind="password"; null clears). Passwords are never persisted or logged.
 */
export interface SudoResponseMessage {
  type: "sudo_response";
  requestId: string;
  cancelled?: boolean;
  approved?: boolean;
  password?: string;
}

export type ChatClientMessage =
  | SendMessage
  | CancelQueuedMessage
  | ResendMessage
  | Interrupt
  | SetPermission
  | SetGoal
  | SetCommandGuard
  | SwitchSession
  | TranscriptPageRequest
  | SubagentSpawn
  | ExternalActionResponse
  | CommandGuardPinResponse
  | InterviewResponseMessage
  | InterviewCancelMessage
  | SudoResponseMessage;

// ===========================================================================
// Server → Client
// ===========================================================================

/**
 * Open serialization of a persisted transcript entry. `type` is the pi entry
 * kind ("user" | "assistant" | "toolResult" | "custom" | …) and `message` is
 * the serialized pi message. Extra fields may appear; ignore them.
 */
export interface HistoryEntry {
  type: string;
  id?: string;
  parentId?: string | null;
  mutation_status?: "edited" | "deleted";
  message?: unknown;
  [key: string]: unknown;
}

export type HistoryReason =
  | "initial"
  | "external_file_change"
  | "agent_settled_reconciliation"
  | "compaction_end_reconciliation"
  | "event_buffer_overflow_resnapshot";

/**
 * Authoritative transcript snapshot. Sent on attach (`reason: "initial"`),
 * after settle/compaction reconciliation, on external file changes, and after
 * a `resend` (without `reason`). Clients replace their transcript wholesale.
 */
export interface HistoryMessage {
  type: "history";
  session_id: string;
  selection_id?: string;
  reason?: HistoryReason;
  streaming_at_snapshot?: boolean;
  compacting_at_snapshot?: boolean;
  message_count?: number;
  payload_bytes?: number;
  messages: HistoryEntry[];
}

export interface TranscriptProtocolMessage {
  type: "transcript_protocol";
  session_id: string;
  selection_id?: string;
  protocol: TranscriptProtocol;
  intent: TranscriptIntent;
  anchor_id?: string;
}

export type TranscriptWindowReason = "initial" | "prepend" | "append" | "tail_reconcile" | "reset";

export interface TranscriptAnchorResolution {
  requested_id: string;
  resolved_id: string | null;
  status: "found" | "missing" | "off_branch" | "pending";
}

/** A bounded active-branch projection. This never reuses the legacy `history` discriminator. */
export interface TranscriptWindowMessage {
  type: "transcript_window";
  session_id: string;
  selection_id?: string;
  request_id?: string;
  reason: TranscriptWindowReason;
  transcript_epoch: string;
  branch_tip_id: string | null;
  messages: HistoryEntry[];
  /** Frozen ID-less in-progress runtime overlay; never part of persisted paging order. */
  streaming_message?: HistoryEntry;
  before_cursor: string | null;
  after_cursor: string | null;
  has_older: boolean;
  has_newer: boolean;
  anchor?: TranscriptAnchorResolution;
  streaming_at_snapshot?: boolean;
  compacting_at_snapshot?: boolean;
  message_count: number;
  payload_bytes: number;
}

/** Correlated terminal failure for one transcript edge request. */
export interface TranscriptPageErrorMessage {
  type: "transcript_page_error";
  session_id: string;
  selection_id: string;
  request_id: string;
  direction: "before" | "after";
  code: string;
  error: string;
}

export interface SessionLoadingMessage {
  type: "session_loading";
  session_id: string;
  selection_id?: string;
}

export interface SessionReadyMessage {
  type: "session_ready";
  session_id: string;
  selection_id?: string;
}

export interface SessionErrorMessage {
  type: "session_error";
  session_id: string;
  selection_id?: string;
  error: string;
}

export interface SessionRuntimeStateMessage {
  type: "session_runtime_state";
  session_id: string;
  selection_id?: string;
  bash_mode: BashMode;
  mutation_locked: boolean;
}

export interface TranscriptInvalidatedMessage {
  type: "transcript_invalidated";
  session_id: string;
  selection_id?: string;
  catalog_generation: number;
  reason: "canonical_mutation";
  reconnect_required: true;
}

export interface TextDeltaMessage {
  type: "text_delta";
  session_id: string;
  selection_id?: string;
  delta: string;
}

export interface ThinkingDeltaMessage {
  type: "thinking_delta";
  session_id: string;
  selection_id?: string;
  delta: string;
}

export interface MessageStartMessage {
  type: "message_start";
  session_id: string;
  selection_id?: string;
  message: unknown;
}

export interface MessageEndMessage {
  type: "message_end";
  session_id: string;
  selection_id?: string;
  message: unknown;
}

export interface TurnStartMessage {
  type: "turn_start";
  session_id: string;
  selection_id?: string;
}

export interface TurnEndMessage {
  type: "turn_end";
  session_id: string;
  selection_id?: string;
  message: unknown | null;
}

export interface ToolExecutionStartMessage {
  type: "tool_execution_start";
  session_id: string;
  selection_id?: string;
  tool_call_id: string;
  tool_name: string;
  input: unknown;
}

export interface ToolExecutionUpdateMessage {
  type: "tool_execution_update";
  session_id: string;
  selection_id?: string;
  tool_call_id: string;
  partial_result: unknown;
}

export interface ToolExecutionEndMessage {
  type: "tool_execution_end";
  session_id: string;
  selection_id?: string;
  tool_call_id: string;
  tool_name: string;
  result: unknown;
  is_error: boolean;
}

export interface AgentStartMessage {
  type: "agent_start";
  session_id: string;
  selection_id?: string;
}

export interface AgentEndMessage {
  type: "agent_end";
  session_id: string;
  selection_id?: string;
  messages: unknown[];
  will_retry: boolean;
}

/** Top-level agent run fully settled (after retries/auto-compaction). */
export interface AgentSettledMessage {
  type: "agent_settled";
  session_id: string;
  selection_id?: string;
}

/** Generic protocol error. The session envelope may be absent. */
export interface ErrorMessage {
  type: "error";
  error: string;
  code?: string;
  session_id?: string;
  selection_id?: string;
}

/** Not rendered natively by v1 clients; show a placeholder row. */
export interface SubagentEventMessage {
  type: "subagent_event";
  session_id?: string;
  selection_id?: string;
  subagent_id: string;
  event: unknown;
}

/** Goal state echo after `set_goal` (also sent on REST goal updates). */
export interface GoalUpdateMessage {
  type: "goal_update";
  session_id: string;
  selection_id?: string;
  goal?: string | null;
  goal_id?: string;
  status: string;
}

export interface ContextUsageMessage {
  type: "context_usage";
  session_id: string;
  selection_id?: string;
  tokens: number | null;
  contextWindow: number;
  percent: number | null;
}

export type CompactionReason = "manual" | "threshold" | "overflow";

export interface CompactionStartMessage {
  type: "compaction_start";
  session_id: string;
  selection_id?: string;
  reason: CompactionReason;
}

export interface CompactionEndMessage {
  type: "compaction_end";
  session_id: string;
  selection_id?: string;
  reason: CompactionReason;
  succeeded: boolean;
  aborted: boolean;
  will_retry: boolean;
  tokens_before?: number;
  estimated_tokens_after?: number;
  error?: string;
}

export interface QueueUpdateMessage {
  type: "queue_update";
  session_id: string;
  selection_id?: string;
  steering: string[];
  followUp: string[];
}

/** One queued (not yet claimed) browser message in a snapshot. */
export interface QueuedBrowserMessage {
  client_message_id: string;
  content: string;
  attachment_names: string[];
}

export interface QueuedMessageSnapshotMessage {
  type: "queued_message_snapshot";
  session_id: string;
  selection_id?: string;
  messages: QueuedBrowserMessage[];
}

export type QueuedMessageAckStatus = "queued" | "accepted" | "rejected";

/**
 * Correlated acknowledgement for a `message` that carried a
 * `client_message_id`. `cancellable` is true only while the message still
 * sits in the pi steering queue.
 */
export interface QueuedMessageAckMessage {
  type: "queued_message_ack";
  session_id: string;
  client_message_id: string;
  status: QueuedMessageAckStatus;
  cancellable?: boolean;
  error_code?: "mutation_locked" | string;
  error?: string;
}

export type QueuedMessageCancelAckStatus = "cancelled" | "not_found" | "error";

export interface QueuedMessageCancelAckMessage {
  type: "queued_message_cancel_ack";
  session_id: string;
  client_message_id: string;
  status: QueuedMessageCancelAckStatus;
  error?: string;
}

export interface TodoItem {
  id: number;
  text: string;
  status: string;
  priority?: string;
  assignee?: string;
  notes?: string;
  dependencies?: number[];
}

export interface TodoStateMessage {
  type: "todo_state";
  session_id?: string;
  selection_id?: string;
  todos: TodoItem[];
  nextId?: number;
  source: "todo-state" | "tool-result" | "todo-preseed" | "none";
}

// ---------------------------------------------------------------------------
// Interactive surfaces (approvals, interviews, sudo, command-guard PIN)
// ---------------------------------------------------------------------------

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

/** Display metadata for one pending external-action approval. */
export interface ExternalActionRequestInfo {
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

export interface ExternalActionRequestMessage extends ExternalActionRequestInfo {
  type: "external_action_request";
  selection_id: string;
}

export interface ExternalActionResponseAckMessage {
  type: "external_action_response_ack";
  requestId: string | null;
  sessionId: string | null;
  selection_id: string | null;
  status: ApprovalResponseStatus;
  errorCode?: ApprovalResponseErrorCode;
  retryAt?: number;
}

/**
 * Explicit outcome for a request. Always followed immediately by an
 * `external_action_snapshot` carrying the authoritative pending set.
 */
export interface ExternalActionTerminalMessage {
  type: "external_action_terminal";
  requestId: string;
  sessionId: string;
  selection_id: string;
  status: ApprovalTerminalStatus;
}

export interface ExternalActionSnapshotMessage {
  type: "external_action_snapshot";
  sessionId: string;
  selection_id: string;
  requests: ExternalActionRequestInfo[];
  syncComplete: true;
}

export interface InterviewQuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface InterviewQuestion {
  id: string;
  label: string;
  prompt: string;
  options: InterviewQuestionOption[];
  allowOther: boolean;
}

export interface InterviewAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

export type InterviewStatus = "open" | "submitted" | "cancelled" | "delivered";

export interface InterviewRequestMessage {
  type: "interview_request";
  requestId: string;
  sessionId: string;
  questions: unknown;
  createdAt: number;
}

export type InterviewResponseAckErrorCode =
  | "session_busy"
  | "invalid_answers"
  | "unauthorized_submission"
  | "not_found"
  | "wrong_session"
  | "cancelled"
  | "conflict"
  | "persistence_failed";

/** Durable receipt boundary for `interview_response`; also sent for retries. */
export interface InterviewResponseAckMessage {
  type: "interview_response_ack";
  requestId: string | null;
  sessionId: string;
  submissionId?: string;
  status: InterviewStatus | "rejected";
  duplicate?: boolean;
  errorCode?: InterviewResponseAckErrorCode;
  error?: string;
}

export type InterviewCancelAckErrorCode =
  | "session_busy"
  | "not_found"
  | "persistence_failed";

export interface InterviewCancelAckMessage {
  type: "interview_cancel_ack";
  requestId: string | null;
  sessionId: string;
  status: "cancelled" | "rejected";
  duplicate?: boolean;
  errorCode?: InterviewCancelAckErrorCode;
  error?: string;
}

export type SudoRequestKind = "password" | "approval";

export interface SudoRequestOrigin {
  mode: "parent" | "long-lived" | "one-shot";
  lineage: string[];
}

export interface SudoRequestMessage {
  type: "sudo_request";
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

export interface CommandGuardPinRequestMessage {
  type: "command_guard_pin_request";
  requestId: string;
  sessionId: string;
  selection_id: string;
  prompt: string;
  command?: string;
  reason?: string;
}

export type CommandGuardMode = "off" | "audit" | "balanced" | "strict";

export interface CommandGuardStateMessage {
  type: "command_guard_state";
  session_id?: string;
  selection_id?: string;
  available: boolean;
  mode: CommandGuardMode | "unknown";
  source?: string;
  modelRoute?: string[];
  error?: string;
  pinRequired?: boolean;
  pinConfigured?: boolean;
}

/**
 * Free-form message wrapper used for slash-command notices and custom pi
 * entries. `customType` distinguishes renderers; unknown customTypes must be
 * ignored safely.
 */
export interface CustomMessage {
  type: "custom";
  session_id?: string;
  selection_id?: string;
  id?: string;
  parentId?: string;
  message: {
    role: "custom";
    customType: string;
    content: unknown;
    [key: string]: unknown;
  };
}

export type ChatServerMessage =
  | HistoryMessage
  | TranscriptProtocolMessage
  | TranscriptWindowMessage
  | TranscriptPageErrorMessage
  | SessionLoadingMessage
  | SessionReadyMessage
  | SessionErrorMessage
  | SessionRuntimeStateMessage
  | TranscriptInvalidatedMessage
  | TextDeltaMessage
  | ThinkingDeltaMessage
  | MessageStartMessage
  | MessageEndMessage
  | TurnStartMessage
  | TurnEndMessage
  | ToolExecutionStartMessage
  | ToolExecutionUpdateMessage
  | ToolExecutionEndMessage
  | AgentStartMessage
  | AgentEndMessage
  | AgentSettledMessage
  | ErrorMessage
  | SubagentEventMessage
  | GoalUpdateMessage
  | ContextUsageMessage
  | CompactionStartMessage
  | CompactionEndMessage
  | QueueUpdateMessage
  | QueuedMessageSnapshotMessage
  | QueuedMessageAckMessage
  | QueuedMessageCancelAckMessage
  | TodoStateMessage
  | ExternalActionRequestMessage
  | ExternalActionResponseAckMessage
  | ExternalActionTerminalMessage
  | ExternalActionSnapshotMessage
  | InterviewRequestMessage
  | InterviewResponseAckMessage
  | InterviewCancelAckMessage
  | SudoRequestMessage
  | CommandGuardPinRequestMessage
  | CommandGuardStateMessage
  | CustomMessage;
