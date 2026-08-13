/**
 * @wayang/protocol — REST payload types for the Wayang v1 HTTP API.
 *
 * Types only: no runtime code, no dependencies. The backend serializes these
 * shapes (see `backend/src/routes/sessions.ts` and `frontend/src/api/client.ts`,
 * which are the source of truth); companion apps consume them.
 *
 * Evolution policy: additive-only. The server may add new optional fields at
 * any time; consumers MUST ignore unknown fields. Existing fields are never
 * removed, renamed, or retyped within a major protocol version.
 */

// ---------------------------------------------------------------------------
// Shared scalar enums
// ---------------------------------------------------------------------------

/** Live runtime execution mode for the session's bash tool. */
export type BashMode = "host" | "sandboxed" | "sandboxed-wren" | "unavailable";

/** Whether the session's project exposes the embedded browser workbench. */
export type BrowserSurfaceMode = "standard" | "protected" | "unavailable";

export type SessionRuntimeStatus = "active" | "starting" | "stopped";
export type SessionTitleSource = "provisional" | "explicit" | "pi" | "legacy_unknown";

// ---------------------------------------------------------------------------
// Sessions
// ---------------------------------------------------------------------------

export interface PendingAgentSwitch {
  switch_id: string;
  from_agent_profile_id: string | null;
  from_provider: string | null;
  from_model: string | null;
  to_agent_profile_id: string;
  target_provider: string;
  target_model: string;
  changed_at: number;
}

/** Catalog bookkeeping fingerprint for the session's canonical JSONL file. */
export interface FileFingerprint {
  mtimeMs: number;
  ctimeMs: number;
  size: number;
  ino: number;
}

/**
 * Exact `GET/POST /api/sessions` payload produced by `serializeSession()` in
 * `backend/src/routes/sessions.ts`. It is the durable session row plus a live
 * runtime projection. Fields marked "internal" are catalog bookkeeping that
 * happens to ride the wire; consumers should ignore them.
 */
export interface HumanAttentionSummary {
  sessionId: string;
  kind: "question";
  sourceId: string;
  createdAt: number;
  status: "pending";
  requiresWayang: true;
}

export interface Session {
  id: string;
  pi_session_file: string | null;
  title: string;
  title_source: SessionTitleSource;
  cwd: string;
  provider: string | null;
  model: string | null;
  /** Null means a legacy/imported session whose historical identity is unknown. */
  agent_profile_id?: string | null;
  pending_agent_switch: PendingAgentSwitch | null;
  created_at: number;
  last_active: number;
  archived: number;
  archived_at: number | null;
  goal: string | null;
  goal_status: string | null;
  scheduled_job_id: string | null;
  scheduled_run_id: string | null;
  error: string | null;
  error_kind: "context_overflow" | null;
  /** @deprecated internal: schema-1 input only; migrated to the generic quarantine marker. */
  finance_private_data_taint?: boolean;
  /** internal: permanent quarantine for legacy private sessions. */
  legacy_private_session_quarantine?: boolean;
  /** internal: null-attribution legacy records can never inherit a later default grant. */
  legacy_capability_ineligible?: boolean;
  /** internal: fingerprint of the canonical file that produced catalog-derived fields. */
  catalog_fingerprint?: FileFingerprint | null;
  /** internal: incremented by direct user/runtime mutations to reject stale worker results. */
  catalog_mutation_version?: number;
  runtime_status: SessionRuntimeStatus;
  runtime_is_streaming: boolean;
  runtime_is_compacting: boolean;
  runtime_subscriber_count: number;
  runtime_last_activity_at: number | null;
  bash_mode: BashMode;
  browser_mode: BrowserSurfaceMode;
  /** Minimal read-only projection of unresolved durable human-input gates. */
  humanAttention: HumanAttentionSummary[];
}

/** `POST /api/sessions` request body. Responds 201 with a `Session`. */
export interface CreateSessionRequest {
  cwd: string;
  title?: string;
  model?: string;
  provider?: string;
  agent_profile_id?: string;
}

/** `PUT /api/sessions/:id/title` request body. Responds with `null`. */
export interface UpdateSessionTitleRequest {
  title: string;
}

/** `PUT /api/sessions/:id/goal` request body. Responds with `null`. */
export interface UpdateSessionGoalRequest {
  goal: string | null;
  status: string | null;
}

/** `PUT /api/sessions/:id/model` request body. Responds with a `Session`. */
export interface UpdateSessionModelRequest {
  provider: string | null;
  model: string | null;
}

/** `POST /api/sessions/:id/delete` request body (PIN-gated permanent delete). */
export interface DeleteSessionRequest {
  pin: string;
}

export interface DeleteSessionResponse {
  deleted: true;
  deleted_session_file: string | null;
}

// ---------------------------------------------------------------------------
// Identity and built-in auth
// ---------------------------------------------------------------------------

/** `GET /api/me`. */
export interface Me {
  username: string;
  provider: string;
  version: string;
}

/** `GET /api/auth/status` and `POST /api/auth/login` response. */
export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
}

/** `POST /api/auth/login` request body (built-in shared-password mode only). */
export interface LoginRequest {
  password: string;
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelOption {
  provider: string;
  id: string;
  name: string;
  api: string;
  reasoning: boolean;
  input: string[];
  contextWindow: number;
  available: boolean;
}

export interface DefaultModelOption {
  provider: string;
  id: string;
  name: string;
}

/** `GET /api/models` (optionally `?refresh=1`). */
export interface ModelsResponse {
  models: ModelOption[];
  defaultModel: DefaultModelOption | null;
  error?: string;
}

// ---------------------------------------------------------------------------
// Session history search (`GET /api/sessions/search`, online only)
// ---------------------------------------------------------------------------

export type SearchChunkRole = "user" | "assistant" | "meta" | "thinking";

export interface SessionSearchResult {
  session_id: string;
  title: string;
  cwd: string;
  model: string | null;
  last_active: number;
  archived: boolean;
  score: number;
  best_role: SearchChunkRole;
  snippet_html: string;
  best_message_id?: string | null;
}

export interface SessionSearchFacets {
  cwds: Array<{ value: string; count: number }>;
  models: Array<{ value: string; count: number }>;
}

export interface SessionSearchResponse {
  query: string;
  took_ms: number;
  results: SessionSearchResult[];
  facets: SessionSearchFacets;
  degraded?: "semantic_off" | "indexing_in_progress";
}

/** Query parameters for `GET /api/sessions/search` (all except `q` optional). */
export interface SessionSearchFilters {
  cwd?: string | null;
  /** `false` (default), `true` (archived only), or `any`. */
  archived?: "true" | "false" | "any";
  /** epoch ms */
  since?: number | null;
  /** epoch ms */
  until?: number | null;
  model?: string | null;
  has_goal?: boolean | null;
  has_error?: boolean | null;
  limit?: number;
}

// ---------------------------------------------------------------------------
// Projects (`GET /api/projects`) — used for session-list grouping
// ---------------------------------------------------------------------------

export interface ProjectAccessPolicy {
  privacy_mode: "standard" | "protected";
  allowed_agent_profile_ids: string[] | null;
}

export interface WorkspaceProject {
  id: string;
  cwd: string;
  name: string;
  description: string | null;
  color: string | null;
  default_agent_profile_id: string;
  default_provider: string | null;
  default_model: string | null;
  access_policy: ProjectAccessPolicy;
  created_at: number;
  updated_at: number;
}

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

/** Shape of non-2xx JSON error bodies across the v1 API. */
export interface ApiErrorBody {
  error?: string;
  detail?: string;
}
