/**
 * api/client.ts — Frontend API client for wayang backend.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionRuntimeStatus = "active" | "starting" | "stopped";
export type BashMode = "host" | "sandboxed" | "sandboxed-wren" | "unavailable";
export type BrowserSurfaceMode = "standard" | "protected" | "unavailable";
export type BrowserAgentReasonCode =
  | "approval_required"
  | "association_inactive"
  | "incompatible_project_mode"
  | "profile_disabled"
  | "profile_not_allowed"
  | "session_quarantined"
  | "interactive_session_required"
  | "fresh_runtime_required"
  | "browser_not_found"
  | "configured_path_invalid"
  | "transport_unavailable"
  | "tool_registration_failed";

export interface BrowserAgentDiagnostic {
  available: boolean;
  capability_id: "wayang.standard-browser.v1" | "wayang.protected-browser.v1" | null;
  reason_code: BrowserAgentReasonCode | null;
  remediation: string | null;
  executable: {
    platform: string;
    transport: "cdp-screencast" | "vnc";
    state: "resolved" | "missing" | "invalid_configured_path";
    reasonCode?: "browser_not_found" | "configured_path_invalid" | "transport_unavailable";
  };
  tool_state: "registered" | "withheld" | "stale_runtime";
}

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

export interface Session {
  id: string;
  pi_session_file: string | null;
  title: string;
  cwd: string;
  provider: string | null;
  model: string | null;
  agent_profile_id: string | null;
  pending_agent_switch: PendingAgentSwitch | null;
  created_at: number;
  last_active: number;
  archived: number;
  goal: string | null;
  goal_status: string | null;
  scheduled_job_id: string | null;
  scheduled_run_id: string | null;
  error: string | null;
  runtime_status: SessionRuntimeStatus;
  runtime_is_streaming: boolean;
  runtime_is_compacting: boolean;
  runtime_subscriber_count: number;
  runtime_last_activity_at: number | null;
  bash_mode: BashMode;
  browser_mode: BrowserSurfaceMode;
  browser_agent?: BrowserAgentDiagnostic;
}

export interface Me {
  username: string;
  provider: string;
  version: string;
}

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

export interface SlashArgumentSuggestion {
  value: string;
  label: string;
  description?: string;
}

export type SlashCommandSource = "builtin" | "extension" | "prompt" | "skill";

export interface SlashCommandOption {
  name: string;
  description?: string;
  argumentHint?: string;
  source: SlashCommandSource;
  argumentSuggestions?: SlashArgumentSuggestion[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, body: unknown, message?: string) {
    super(message ?? `API request failed with status ${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
  }
}

export interface AuthStatus {
  enabled: boolean;
  authenticated: boolean;
}

type UnauthorizedListener = () => void;

const unauthorizedListeners = new Set<UnauthorizedListener>();

export function subscribeToUnauthorized(listener: UnauthorizedListener): () => void {
  unauthorizedListeners.add(listener);
  return () => unauthorizedListeners.delete(listener);
}

function reportUnauthorized(): void {
  for (const listener of unauthorizedListeners) listener();
}

// ---------------------------------------------------------------------------
// HTTP helpers
// ---------------------------------------------------------------------------

async function parseBody(res: Response): Promise<unknown> {
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

let authRedirectReloadQueued = false;

function queueAuthRedirectReload(): void {
  if (authRedirectReloadQueued || typeof window === "undefined") return;
  authRedirectReloadQueued = true;
  window.setTimeout(() => {
    // Let the top-level document navigation perform an external-auth flow once.
    // Without this guard, background API polls can follow the same redirect
    // independently and stampede the configured authentication proxy.
    window.location.reload();
  }, 100);
}

async function request<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  notifyOnUnauthorized = true,
  cache?: RequestCache,
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    redirect: "manual",
    cache,
    headers:
      body !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  };

  const res = await fetch(path, init);
  if (res.type === "opaqueredirect" || (res.status >= 300 && res.status < 400)) {
    queueAuthRedirectReload();
    throw new ApiError(0, "Authentication redirect required");
  }
  if (!res.ok) {
    const parsed = await parseBody(res);
    if (
      res.status === 401
      && notifyOnUnauthorized
      && res.headers.get("x-wayang-authentication-required") === "1"
    ) reportUnauthorized();
    const message =
      parsed && typeof parsed === "object" && "error" in parsed && typeof parsed.error === "string"
        ? parsed.error
        : parsed && typeof parsed === "object" && "detail" in parsed && typeof parsed.detail === "string"
          ? parsed.detail
          : undefined;
    throw new ApiError(res.status, parsed, message);
  }
  if (res.status === 204) return null as T;
  return (await parseBody(res)) as T;
}

function apiGet<T>(path: string): Promise<T> {
  return request<T>("GET", path);
}

function apiPost<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("POST", path, body ?? {});
}

function apiPut<T>(path: string, body?: unknown): Promise<T> {
  return request<T>("PUT", path, body);
}

function apiDelete<T = null>(path: string): Promise<T> {
  return request<T>("DELETE", path);
}

// ---------------------------------------------------------------------------
// Endpoints
// ---------------------------------------------------------------------------

export function fetchAuthStatus(): Promise<AuthStatus> {
  return request<AuthStatus>("GET", "/api/auth/status", undefined, undefined, false);
}

export function login(password: string): Promise<AuthStatus> {
  return request<AuthStatus>("POST", "/api/auth/login", { password }, undefined, false);
}

export function logout(): Promise<unknown> {
  return request<unknown>("POST", "/api/auth/logout", {}, undefined, false);
}

/**
 * WebSocket and EventSource handshakes do not expose their HTTP status to
 * browser JavaScript. Probe the public status endpoint after an unexpected
 * disconnect so an expired session stops transport reconnect loops.
 */
export async function canRetryAuthenticatedTransport(): Promise<boolean> {
  try {
    const status = await fetchAuthStatus();
    if (status.enabled && !status.authenticated) {
      reportUnauthorized();
      return false;
    }
  } catch {
    // A transient network/backend failure should retain the existing retry
    // behavior. A later API 401 or successful status probe will open the gate.
  }
  return true;
}

export function fetchMe(): Promise<Me> {
  return apiGet<Me>("/api/me");
}

export function recordSessionOpenLatency(durationMs: number): Promise<null> {
  return apiPost<null>("/api/latency/metrics/session-open", { duration_ms: durationMs });
}

export function fetchModels(options: { refresh?: boolean } = {}): Promise<{ models: ModelOption[]; defaultModel: DefaultModelOption | null; error?: string }> {
  const query = options.refresh ? "?refresh=1" : "";
  return apiGet<{ models: ModelOption[]; defaultModel: DefaultModelOption | null; error?: string }>(`/api/models${query}`);
}

export function fetchSlashCommands(sessionId: string): Promise<{ commands: SlashCommandOption[] }> {
  return apiGet<{ commands: SlashCommandOption[] }>(`/api/sessions/${encodeURIComponent(sessionId)}/slash-commands`);
}

export type CapabilityCategory =
  | "agents"
  | "workflow"
  | "providers"
  | "security"
  | "automation"
  | "configuration";

export type CapabilityStatus = "available" | "partial" | "planned" | "external";

export interface CapabilityPath {
  label: string;
  path: string;
  exists: boolean;
}

export interface Capability {
  id: string;
  title: string;
  category: CapabilityCategory;
  status: CapabilityStatus;
  summary: string;
  ui: string[];
  tools?: string[];
  commands?: string[];
  paths?: CapabilityPath[];
}

export interface ScheduledJob {
  id: string;
  name: string;
  backend: "systemd-user" | "cron";
  enabled: boolean | null;
  schedule: string;
  command: string;
  status: string;
  nextRun: string | null;
  lastRun: string | null;
}

// ---------------------------------------------------------------------------
// Protected Automations
// ---------------------------------------------------------------------------

export interface ProtectedAutomationStatus {
  milestone: number;
  activationAvailable: boolean;
  production_services: boolean;
}

export type ProtectedAutomationRunStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "skipped"
  | "cancelled"
  | "needs_user"
  | "interrupted"
  | "denied";

export type ProtectedAutomationAttentionReason =
  | "login_required"
  | "mfa_required"
  | "captcha_required"
  | "payment_confirmation_required"
  | "human_review_required";

export interface ProtectedAutomationAttention {
  required: true;
  reason: ProtectedAutomationAttentionReason;
}

/** Exact owner-safe projection returned by publicJob(). */
export interface ProtectedAutomationJob {
  id: string;
  project_id: string;
  agent_profile_id: string;
  capability_revision: number;
  revision: number;
  source_revision: number;
  name: string;
  source_manifest_sha256: string;
  entrypoint: string;
  argv_count: number;
  uses_browser_profile: boolean;
  browser_profile: { supported: boolean; saved: boolean; last_saved_at: number | null };
  purge_request: { request_id: string; job_id: string; state: "awaiting_owner_pin"; requested_at: number; expires_at: number } | null;
  allowed_https_origins: string[];
  cron_expr: string;
  timeout_ms: number;
  missed_run_policy: "skip" | "run_once";
  enabled: boolean;
  blocked_reason: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
  attention: ProtectedAutomationAttention | null;
  activationAvailable: boolean;
}

/** Exact owner-safe projection returned by publicRun(). */
export interface ProtectedAutomationRun {
  id: string;
  job_id: string;
  project_id: string;
  agent_profile_id: string;
  job_revision: number;
  capability_revision: number;
  trigger: "schedule" | "manual";
  scheduled_for: number | null;
  started_at: number;
  finished_at: number | null;
  status: ProtectedAutomationRunStatus;
  outcome_code: string | null;
  exit_code: number | null;
  attention: ProtectedAutomationAttention | null;
}

export interface ProtectedAutomationPreparationSelection {
  sourceSessionId: string;
  jobId: string;
  preparationId: string;
}

export interface ProtectedAutomationPreparation {
  preparation_id: string;
  source_session_id: string;
  job_id: string;
  job_revision: number;
  state: "waiting_for_owner" | "ready" | "closed";
  websocket_path: string;
  project_id: string;
  agent_profile_id: string;
  capability_revision: number;
  source_revision: number;
  allowed_https_origins: string[];
  credential_broker: { supported: boolean; guarded: true };
}

export interface ProtectedAutomationPurgeChallenge {
  request_id: string;
  job_id: string;
  expected_revision: number;
  operation_digest: string;
  expires_at: number;
  summary: string;
}

export interface ProtectedAutomationPurgeResult {
  purged_job_id: string;
  purged_run_ids: string[];
}

export interface ProtectedAutomationCatalog {
  status: ProtectedAutomationStatus;
  jobs: ProtectedAutomationJob[];
}

export interface ProtectedAutomationDetail {
  status: ProtectedAutomationStatus;
  job: ProtectedAutomationJob;
  runs: ProtectedAutomationRun[];
}

export function fetchProtectedAutomationStatus(): Promise<ProtectedAutomationStatus> {
  return request<ProtectedAutomationStatus>("GET", "/api/protected-automations", undefined, undefined, true, "no-store");
}

export async function listProtectedAutomationJobs(): Promise<{ jobs: ProtectedAutomationJob[] }> {
  const payload = await request<{ jobs?: unknown }>("GET", "/api/protected-automations/jobs", undefined, undefined, true, "no-store");
  const rows = Array.isArray(payload?.jobs) ? payload.jobs : [];
  return {
    jobs: rows.filter((value): value is ProtectedAutomationJob => Boolean(
      value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string",
    )),
  };
}

export async function listProtectedAutomations(): Promise<ProtectedAutomationCatalog> {
  const [status, result] = await Promise.all([
    fetchProtectedAutomationStatus(),
    listProtectedAutomationJobs(),
  ]);
  return { status, jobs: result.jobs };
}

export async function getProtectedAutomationJob(id: string): Promise<{ job: ProtectedAutomationJob }> {
  const payload = await request<{ job?: unknown }>(
    "GET",
    `/api/protected-automations/jobs/${encodeURIComponent(id)}`,
    undefined,
    undefined,
    true,
    "no-store",
  );
  if (!payload?.job || typeof payload.job !== "object" || typeof (payload.job as { id?: unknown }).id !== "string") {
    throw new Error("Protected automation backend returned an invalid job projection");
  }
  return { job: payload.job as ProtectedAutomationJob };
}

export async function listProtectedAutomationRuns(id: string): Promise<{ runs: ProtectedAutomationRun[] }> {
  const payload = await request<{ runs?: unknown }>(
    "GET",
    `/api/protected-automations/jobs/${encodeURIComponent(id)}/runs`,
    undefined,
    undefined,
    true,
    "no-store",
  );
  const rows = Array.isArray(payload?.runs) ? payload.runs : [];
  return {
    runs: rows.filter((value): value is ProtectedAutomationRun => Boolean(
      value && typeof value === "object" && typeof (value as { id?: unknown }).id === "string",
    )),
  };
}

export async function getProtectedAutomation(id: string): Promise<ProtectedAutomationDetail> {
  const [status, jobResult, runResult] = await Promise.all([
    fetchProtectedAutomationStatus(),
    getProtectedAutomationJob(id),
    listProtectedAutomationRuns(id),
  ]);
  return { status, job: jobResult.job, runs: runResult.runs };
}

export function pauseProtectedAutomation(id: string, expectedRevision: number): Promise<{ job: ProtectedAutomationJob }> {
  return request<{ job: ProtectedAutomationJob }>(
    "POST",
    `/api/protected-automations/jobs/${encodeURIComponent(id)}/pause`,
    { expectedRevision },
    undefined,
    true,
    "no-store",
  );
}

export function cancelProtectedAutomationRun(jobId: string, runId: string): Promise<{ run: ProtectedAutomationRun }> {
  return request<{ run: ProtectedAutomationRun }>(
    "POST",
    `/api/protected-automations/jobs/${encodeURIComponent(jobId)}/runs/${encodeURIComponent(runId)}/cancel`,
    {},
    undefined,
    true,
    "no-store",
  );
}

function protectedAutomationPreparationBase(selection: ProtectedAutomationPreparationSelection): string {
  return `/api/protected-automations/sources/${encodeURIComponent(selection.sourceSessionId)}`
    + `/jobs/${encodeURIComponent(selection.jobId)}/preparations/${encodeURIComponent(selection.preparationId)}`;
}

export async function getProtectedAutomationPreparation(
  selection: ProtectedAutomationPreparationSelection,
): Promise<ProtectedAutomationPreparation> {
  const preparation = await request<ProtectedAutomationPreparation>(
    "GET",
    protectedAutomationPreparationBase(selection),
    undefined,
    undefined,
    true,
    "no-store",
  );
  if (preparation?.source_session_id !== selection.sourceSessionId
    || preparation?.job_id !== selection.jobId
    || preparation?.preparation_id !== selection.preparationId
    || typeof preparation.websocket_path !== "string") {
    throw new Error("Protected automation backend returned a mismatched preparation projection");
  }
  return preparation;
}

export function closeProtectedAutomationPreparation(selection: ProtectedAutomationPreparationSelection): Promise<null> {
  return request<null>("POST", `${protectedAutomationPreparationBase(selection)}/close`, {}, undefined, true, "no-store");
}

export function navigateProtectedAutomationPreparation(
  selection: ProtectedAutomationPreparationSelection,
  url: string,
): Promise<ProtectedAutomationPreparation> {
  return request<ProtectedAutomationPreparation>("POST", `${protectedAutomationPreparationBase(selection)}/navigate`, { url }, undefined, true, "no-store");
}

export function requestProtectedAutomationPurge(
  jobId: string,
  expectedRevision: number,
): Promise<ProtectedAutomationPurgeChallenge> {
  return request<ProtectedAutomationPurgeChallenge>(
    "POST",
    `/api/protected-automations/jobs/${encodeURIComponent(jobId)}/purge-requests`,
    { expectedRevision },
    undefined,
    false,
    "no-store",
  );
}

export function commitProtectedAutomationPurge(
  jobId: string,
  requestId: string,
  pin: string,
): Promise<ProtectedAutomationPurgeResult> {
  return request<ProtectedAutomationPurgeResult>(
    "POST",
    `/api/protected-automations/jobs/${encodeURIComponent(jobId)}/purge-requests/${encodeURIComponent(requestId)}/commit`,
    { pin },
    undefined,
    false,
    "no-store",
  );
}

export function cancelProtectedAutomationPurge(jobId: string, requestId: string): Promise<null> {
  return request<null>(
    "DELETE",
    `/api/protected-automations/jobs/${encodeURIComponent(jobId)}/purge-requests/${encodeURIComponent(requestId)}`,
    undefined,
    undefined,
    false,
    "no-store",
  );
}

export type ScheduledAgentRunStatus = "running" | "completed" | "failed" | "skipped";
export type ScheduledAgentCommandGuardMode = "default" | "off" | "balanced" | "audit" | "strict";

export interface ScheduledAgentJob {
  id: string;
  name: string;
  schedule_kind: "cron";
  cron_expr: string;
  timezone: string | null;
  prompt: string;
  cwd: string;
  provider: string | null;
  model: string | null;
  agent_profile_id: string | null;
  permission_mode: string;
  command_guard_mode: ScheduledAgentCommandGuardMode;
  timeout_ms: number;
  prompt_timeout_ms: number;
  overlap_policy: "skip";
  missed_run_policy: "skip";
  enabled: boolean;
  created_at: number;
  updated_at: number;
  last_run_at: number | null;
  next_run_at: number | null;
}

export interface ScheduledAgentRun {
  id: string;
  job_id: string;
  session_id: string | null;
  trigger: "schedule" | "manual";
  scheduled_for: number | null;
  started_at: number;
  finished_at: number | null;
  status: ScheduledAgentRunStatus;
  error_message: string | null;
  result_summary: string | null;
}

export interface ScheduledAgentJobInput {
  name?: string;
  cron_expr?: string;
  prompt?: string;
  cwd?: string;
  provider?: string | null;
  model?: string | null;
  agent_profile_id?: string | null;
  permission_mode?: string;
  command_guard_mode?: ScheduledAgentCommandGuardMode;
  timeout_ms?: number;
  prompt_timeout_ms?: number;
  enabled?: boolean;
}

export function fetchCapabilities(cwd?: string | null): Promise<{ cwd: string | null; capabilities: Capability[] }> {
  const params = cwd ? `?${new URLSearchParams({ cwd }).toString()}` : "";
  return apiGet<{ cwd: string | null; capabilities: Capability[] }>(`/api/capabilities${params}`);
}

export const WORKSPACE_CAPABILITY_IDS = [
  "wayang.standard-resources.v1",
  "wayang.standard-browser.v1",
  "wayang.host-execution.v1",
  "wayang.protected-browser.v1",
  "wayang.protected-automation.v1",
] as const;

export type WorkspaceCapabilityId = typeof WORKSPACE_CAPABILITY_IDS[number];
export type WorkspacePrivacyMode = "standard" | "protected";

export interface WorkspaceCapabilityCatalogItem {
  id: WorkspaceCapabilityId;
  compatiblePrivacyMode: WorkspacePrivacyMode;
  title: string;
  riskSummary: string;
}

export interface WorkspaceCapabilityAssociation {
  capabilityId: WorkspaceCapabilityId;
  projectId: string;
  agentProfileId: string;
  revision: number;
  active: boolean;
  approvedAt: number;
  revokedAt: number | null;
  updatedAt: number;
}

export interface WorkspaceCapabilityApprovalEvent {
  id: string;
  capabilityId: WorkspaceCapabilityId;
  projectId: string;
  agentProfileId: string;
  associationRevision: number;
  operationDigest: string;
  approvedAt: number;
  revokedAt: number | null;
}

export interface WorkspaceCapabilityCatalogStatus {
  capabilities: WorkspaceCapabilityCatalogItem[];
  associations: WorkspaceCapabilityAssociation[];
  approvalEvents: WorkspaceCapabilityApprovalEvent[];
  history: { returned: number; limit: number; hasMore: boolean };
}

export interface WorkspaceCapabilityChallenge {
  requestId: string;
  operationDigest: string;
  expiresAt: number;
  capabilityId: WorkspaceCapabilityId;
  projectId: string;
  projectLabel: string;
  projectCwd: string;
  privacyMode: WorkspacePrivacyMode;
  agentProfileId: string;
  agentProfileLabel: string;
  profileEnabled: boolean;
  profileAllowed: boolean;
  previewStateDigest: string;
  association: {
    before: { active: boolean; revision: number } | null;
    after: { active: boolean; revision: number };
  };
  summary: string;
  consequences: string[];
  affectedRuntimes: Array<{
    runtimeId: string;
    status: "idle" | "streaming" | "queued" | "starting" | "mutation_locked";
  }>;
}

export interface WorkspaceCapabilityAssociationIntent {
  capabilityId: WorkspaceCapabilityId;
  projectId: string;
  agentProfileId: string;
}

export function fetchWorkspaceCapabilities(): Promise<WorkspaceCapabilityCatalogStatus> {
  return request<WorkspaceCapabilityCatalogStatus>(
    "GET",
    "/api/workspace-capabilities",
    undefined,
    undefined,
    false,
    "no-store",
  );
}

export function requestWorkspaceCapabilityActivation(
  intent: WorkspaceCapabilityAssociationIntent,
): Promise<WorkspaceCapabilityChallenge> {
  return request<WorkspaceCapabilityChallenge>(
    "POST",
    "/api/workspace-capabilities/requests",
    intent,
    undefined,
    false,
    "no-store",
  );
}

/** One non-retrying, no-store submission of the transient PIN. */
export function commitWorkspaceCapabilityActivation(
  requestId: string,
  pin: string,
): Promise<{ association: WorkspaceCapabilityAssociation }> {
  return request<{ association: WorkspaceCapabilityAssociation }>(
    "POST",
    `/api/workspace-capabilities/requests/${encodeURIComponent(requestId)}/commit`,
    { pin },
    undefined,
    false,
    "no-store",
  );
}

export function cancelWorkspaceCapabilityActivation(requestId: string): Promise<null> {
  return request<null>(
    "DELETE",
    `/api/workspace-capabilities/requests/${encodeURIComponent(requestId)}`,
    undefined,
    undefined,
    false,
    "no-store",
  );
}

export function revokeWorkspaceCapabilityAssociation(
  association: Pick<WorkspaceCapabilityAssociation, "capabilityId" | "projectId" | "agentProfileId" | "revision">,
): Promise<{ association: WorkspaceCapabilityAssociation }> {
  return request<{ association: WorkspaceCapabilityAssociation }>(
    "POST",
    "/api/workspace-capability-associations/revoke",
    {
      capabilityId: association.capabilityId,
      projectId: association.projectId,
      agentProfileId: association.agentProfileId,
      expectedRevision: association.revision,
    },
    undefined,
    false,
    "no-store",
  );
}

export function fetchScheduledJobs(): Promise<{ jobs: ScheduledJob[] }> {
  return apiGet<{ jobs: ScheduledJob[] }>("/api/scheduled-jobs");
}

export async function listScheduledAgentJobs(): Promise<{ jobs: ScheduledAgentJob[] }> {
  const payload = await apiGet<unknown>("/api/scheduled-agent-jobs");
  if (!payload || typeof payload !== "object") return { jobs: [] };
  const jobs = (payload as { jobs?: unknown }).jobs;
  return { jobs: Array.isArray(jobs) ? (jobs as ScheduledAgentJob[]) : [] };
}

export function getScheduledAgentJob(id: string): Promise<{ job: ScheduledAgentJob; runs: ScheduledAgentRun[] }> {
  return apiGet<{ job: ScheduledAgentJob; runs: ScheduledAgentRun[] }>(`/api/scheduled-agent-jobs/${encodeURIComponent(id)}`);
}

export function createScheduledAgentJob(input: ScheduledAgentJobInput): Promise<ScheduledAgentJob> {
  return apiPost<ScheduledAgentJob>("/api/scheduled-agent-jobs", input);
}

export function updateScheduledAgentJob(id: string, input: ScheduledAgentJobInput): Promise<ScheduledAgentJob> {
  return apiPut<ScheduledAgentJob>(`/api/scheduled-agent-jobs/${encodeURIComponent(id)}`, input);
}

export function deleteScheduledAgentJob(id: string): Promise<null> {
  return apiDelete<null>(`/api/scheduled-agent-jobs/${encodeURIComponent(id)}`);
}

export function runScheduledAgentJob(id: string): Promise<ScheduledAgentRun> {
  return apiPost<ScheduledAgentRun>(`/api/scheduled-agent-jobs/${encodeURIComponent(id)}/run`);
}

export async function listSessions(signal?: AbortSignal): Promise<Session[]> {
  const payload = await request<unknown>("GET", "/api/sessions", undefined, signal);
  return Array.isArray(payload) ? (payload as Session[]) : [];
}

export function createSession(
  cwd: string,
  title?: string,
  model?: string,
  provider?: string,
  agentProfileId?: string,
): Promise<Session> {
  return apiPost<Session>("/api/sessions", {
    cwd,
    title: title ?? "",
    model,
    provider,
    agent_profile_id: agentProfileId,
  });
}

export interface SessionAgentSwitchPreview {
  session_id: string;
  from_agent_profile_id: string | null;
  from_agent_name: string | null;
  to_agent_profile_id: string;
  to_agent_name: string;
  current_provider: string | null;
  current_model: string | null;
  target_provider: string;
  target_model: string;
  memory_access: MemoryAccess;
  transcript_retained: true;
  warning: string;
}

export interface SessionAgentSwitchResult {
  switch_id: string;
  preview: SessionAgentSwitchPreview;
  session: Session;
}

export function previewSessionAgentSwitch(
  sessionId: string,
  agentProfileId: string,
): Promise<SessionAgentSwitchPreview> {
  return apiPost<SessionAgentSwitchPreview>(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent/preview`,
    { agent_profile_id: agentProfileId },
  );
}

export function switchSessionAgent(
  sessionId: string,
  agentProfileId: string,
): Promise<SessionAgentSwitchResult> {
  return apiPut<SessionAgentSwitchResult>(
    `/api/sessions/${encodeURIComponent(sessionId)}/agent`,
    { agent_profile_id: agentProfileId },
  );
}

export function getSession(id: string): Promise<Session> {
  return apiGet<Session>(`/api/sessions/${encodeURIComponent(id)}`);
}

export function archiveSession(id: string): Promise<null> {
  return apiDelete<null>(`/api/sessions/${encodeURIComponent(id)}`);
}

export function deleteSession(id: string, pin: string): Promise<{ deleted: true; deleted_session_file: string | null }> {
  return apiPost<{ deleted: true; deleted_session_file: string | null }>(
    `/api/sessions/${encodeURIComponent(id)}/delete`,
    { pin },
  );
}

export function stopSession(id: string): Promise<Session> {
  return apiPost<Session>(`/api/sessions/${encodeURIComponent(id)}/stop`);
}

export function updateSessionTitle(id: string, title: string): Promise<null> {
  return apiPut<null>(`/api/sessions/${encodeURIComponent(id)}/title`, {
    title,
  });
}

export function refreshSessionTitle(id: string): Promise<string | null> {
  return request<string | null>(
    "PATCH",
    `/api/sessions/${encodeURIComponent(id)}/title`,
  );
}

export function updateSessionGoal(
  id: string,
  goal: string | null,
  status: string | null,
): Promise<null> {
  return apiPut<null>(`/api/sessions/${encodeURIComponent(id)}/goal`, {
    goal,
    status,
  });
}

export function updateSessionModel(
  id: string,
  provider: string | null,
  model: string | null,
): Promise<Session> {
  return apiPut<Session>(`/api/sessions/${encodeURIComponent(id)}/model`, {
    provider,
    model,
  });
}

// ---------------------------------------------------------------------------
// Session history search
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

export function searchSessions(
  query: string,
  filters: SessionSearchFilters = {},
  signal?: AbortSignal,
): Promise<SessionSearchResponse> {
  const params = new URLSearchParams();
  params.set("q", query);
  if (filters.cwd) params.set("cwd", filters.cwd);
  if (filters.archived) params.set("archived", filters.archived);
  if (filters.since != null) params.set("since", String(filters.since));
  if (filters.until != null) params.set("until", String(filters.until));
  if (filters.model) params.set("model", filters.model);
  if (filters.has_goal != null) params.set("has_goal", String(filters.has_goal));
  if (filters.has_error != null) params.set("has_error", String(filters.has_error));
  if (filters.limit != null) params.set("limit", String(filters.limit));
  return request<SessionSearchResponse>(
    "GET",
    `/api/sessions/search?${params.toString()}`,
    undefined,
    signal,
  );
}

export interface SessionSearchHealth {
  total_sessions: number;
  indexed_sessions: number;
  pending: number;
  errored?: number;
  last_error?: string;
  schema_version: number;
  embedder: "off" | "http";
  watcher?: {
    backfill_done: boolean;
    backfill_running: boolean;
    last_tick_at: number | null;
  };
}

export function fetchSessionSearchHealth(): Promise<SessionSearchHealth> {
  return apiGet<SessionSearchHealth>("/api/sessions/search/health");
}

export function reindexSessions(sessionId?: string): Promise<{ queued: number }> {
  return apiPost<{ queued: number }>("/api/sessions/search/reindex", {
    session_id: sessionId ?? null,
  });
}

// ---------------------------------------------------------------------------
// WebSocket
// ---------------------------------------------------------------------------

export function chatWsUrl(sessionId: string, selectionId?: string | null): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams({ session_id: sessionId });
  if (selectionId) params.set("selection_id", selectionId);
  return `${proto}//${window.location.host}/ws/chat?${params.toString()}`;
}

// ---------------------------------------------------------------------------
// Embedded Browser Workbench
// ---------------------------------------------------------------------------

export type BrowserLifecycleStatus = "stopped" | "starting" | "running" | "errored";
export type BrowserControlMode = "agent" | "user" | "paused";
export type BrowserViewerTransport = "vnc" | "cdp-screencast";

/** Public profile metadata deliberately excludes private runtime and filesystem paths. */
export interface BrowserProfileMetadata {
  persistence: "shared" | "project" | "session" | "protected";
}

/** Exact public state returned by browser HTTP routes and status messages. */
export interface ProtectedDownloadStatus {
  status: "downloading" | "completed" | "canceled";
  suggestedFilename: string;
  relativePath?: string;
  bytes?: number;
  reason?: "count_quota" | "file_quota" | "aggregate_quota" | "unsafe_source" | "publication_failed";
  updatedAt: number;
}

export interface BrowserSessionState {
  sessionId: string | null;
  projectCwd: string;
  status: BrowserLifecycleStatus;
  controlMode: BrowserControlMode;
  secretTainted: boolean;
  localOnlyRecommended: boolean;
  needsUser: boolean;
  needsUserReason?: string;
  lastResumeAt?: number;
  activeUrl?: string;
  activeTitle?: string;
  cdpReady: boolean;
  viewerTransport: BrowserViewerTransport;
  viewerWsPath?: string;
  cdpScreencastWsPath?: string;
  vncReady: boolean;
  profile: BrowserProfileMetadata;
  startedAt?: number;
  updatedAt: number;
  lastError?: string;
  credentialInspection?: "blocked" | "text-allowed";
  credentialBroker?: { supported: boolean; guarded: true };
  download?: ProtectedDownloadStatus;
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text?: string;
  screenshot?: string;
}

function browserBody(sessionId: string | null, projectCwd: string | null, extra?: Record<string, unknown>): Record<string, unknown> {
  return {
    ...(sessionId ? { sessionId } : {}),
    ...(projectCwd ? { projectCwd } : {}),
    ...extra,
  };
}

function browserQuery(sessionId: string | null, projectCwd: string | null): string {
  const params = new URLSearchParams();
  if (sessionId) params.set("session_id", sessionId);
  if (projectCwd) params.set("project_cwd", projectCwd);
  return params.toString();
}

function browserApiPath(operation: string, sessionId: string | null, projectCwd: string | null): string {
  return `/api/browser/${operation}?${browserQuery(sessionId, projectCwd)}`;
}

export function fetchBrowserStatus(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiGet<BrowserSessionState>(`/api/browser/status?${browserQuery(sessionId, projectCwd)}`);
}

export function startBrowser(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>(browserApiPath("start", sessionId, projectCwd), browserBody(sessionId, projectCwd));
}

export function stopBrowser(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>(browserApiPath("stop", sessionId, projectCwd), browserBody(sessionId, projectCwd));
}

export function restartBrowser(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>(browserApiPath("restart", sessionId, projectCwd), browserBody(sessionId, projectCwd));
}

export function resetBrowserProfile(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>(browserApiPath("reset-profile", sessionId, projectCwd), browserBody(sessionId, projectCwd, { confirmed: true }));
}

export function setBrowserControlMode(
  sessionId: string | null,
  projectCwd: string | null,
  mode: BrowserControlMode,
  reason?: string,
): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>(browserApiPath("control-mode", sessionId, projectCwd), browserBody(sessionId, projectCwd, { mode, reason }));
}

export function navigateBrowser(sessionId: string | null, projectCwd: string | null, url: string): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>(browserApiPath("navigate", sessionId, projectCwd), browserBody(sessionId, projectCwd, { url }));
}

export function snapshotBrowser(
  sessionId: string | null,
  projectCwd: string | null,
  mode: "text" | "screenshot" = "text",
): Promise<BrowserSnapshot> {
  return apiPost<BrowserSnapshot>(browserApiPath("snapshot", sessionId, projectCwd), browserBody(sessionId, projectCwd, { mode }));
}

export function pasteTextBrowser(sessionId: string | null, projectCwd: string | null, text: string): Promise<BrowserSessionState> {
  // This user-only route is intentionally not allowed to fall back to the
  // agent's public-text route: a direct human paste may contain a credential.
  return apiPost<BrowserSessionState>(browserApiPath("paste-text", sessionId, projectCwd), browserBody(sessionId, projectCwd, { text }));
}

export type BrowserCredentialAvailability = "unavailable" | "locked" | "unlocked";

export interface BrowserCredentialStatus {
  availability: BrowserCredentialAvailability;
  exactOrigin: string | null;
  unlockExpiresAt?: number;
}

export interface BrowserCredentialChoice {
  choiceToken: string;
  label: string;
  maskedIdentifier: string;
  hasTotp: boolean;
  matchWarning?: string;
}

export interface BrowserCredentialMatches extends BrowserCredentialStatus {
  choices: BrowserCredentialChoice[];
}

export interface BrowserCredentialFillResult {
  filled: Array<"username" | "password" | "totp">;
}

export interface BrowserCredentialInspectionResult {
  allowedInspection: "text-only";
  screenshotsAllowed: false;
  mutationsAllowed: false;
  state: BrowserSessionState;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function exactOrigin(value: unknown): string | null {
  if (typeof value !== "string" || !value) return null;
  try {
    const url = new URL(value);
    return url.origin === "null" ? null : url.origin;
  } catch {
    return null;
  }
}

export async function fetchBrowserCredentialStatus(
  sessionId: string | null,
  projectCwd: string | null,
): Promise<BrowserCredentialStatus> {
  const raw = asRecord(await apiPost<unknown>(
    browserApiPath("credentials/status", sessionId, projectCwd),
    browserBody(sessionId, projectCwd),
  ));
  if (typeof raw.available !== "boolean" || typeof raw.unlocked !== "boolean") {
    throw new Error("Credential broker returned an invalid status");
  }
  return {
    availability: !raw.available ? "unavailable" : raw.unlocked ? "unlocked" : "locked",
    exactOrigin: exactOrigin(raw.origin),
    ...(typeof raw.unlockExpiresAt === "number" ? { unlockExpiresAt: raw.unlockExpiresAt } : {}),
  };
}

export async function fetchBrowserCredentialMatches(
  sessionId: string | null,
  projectCwd: string | null,
): Promise<BrowserCredentialMatches> {
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(await apiPost<unknown>(
      browserApiPath("credentials/matches", sessionId, projectCwd),
      browserBody(sessionId, projectCwd),
    ));
  } catch (error) {
    // The finalized UI route pauses the agent before checking the broker. Its
    // status is represented by bounded HTTP outcomes rather than secret-bearing
    // response data: unavailable=503, locked/not-connected=409.
    if (error instanceof ApiError && error.status === 503) {
      return { availability: "unavailable", exactOrigin: null, choices: [] };
    }
    if (error instanceof ApiError && error.status === 409) {
      return { availability: "locked", exactOrigin: null, choices: [] };
    }
    throw error;
  }
  const rawChoices = Array.isArray(raw.choices) ? raw.choices : [];
  return {
    availability: "unlocked",
    exactOrigin: exactOrigin(raw.origin),
    choices: rawChoices.flatMap((value): BrowserCredentialChoice[] => {
      const choice = asRecord(value);
      const choiceToken = typeof choice.choiceToken === "string"
        ? choice.choiceToken
        : typeof choice.token === "string"
          ? choice.token
          : "";
      if (!choiceToken) return [];
      return [{
        choiceToken,
        label: typeof choice.label === "string" && choice.label ? choice.label : "Saved login",
        // Never fall back to a raw username/identifier field. The broker must
        // explicitly return display-safe masked metadata.
        maskedIdentifier: typeof choice.maskedIdentifier === "string" && choice.maskedIdentifier
          ? choice.maskedIdentifier
          : "Identifier hidden",
        hasTotp: choice.hasTotp === true || choice.totpAvailable === true,
        matchWarning: typeof choice.matchWarning === "string"
          ? choice.matchWarning
          : typeof choice.warning === "string"
            ? choice.warning
            : undefined,
      }];
    }),
  };
}

function normalizeCredentialFill(value: unknown): BrowserCredentialFillResult {
  const record = asRecord(value);
  const values = Array.isArray(record.filled) ? record.filled : Array.isArray(record.fields) ? record.fields : [];
  const allowed = new Set<BrowserCredentialFillResult["filled"][number]>(["username", "password", "totp"]);
  return { filled: values.filter((field): field is BrowserCredentialFillResult["filled"][number] => allowed.has(field)) };
}

export async function fillBrowserCredentialLogin(
  sessionId: string | null,
  projectCwd: string | null,
  choiceToken: string,
): Promise<BrowserCredentialFillResult> {
  const raw = await apiPost<unknown>(
    browserApiPath("credentials/fill", sessionId, projectCwd),
    browserBody(sessionId, projectCwd, { choiceToken }),
  );
  return normalizeCredentialFill(raw);
}

export async function fillBrowserCredentialTotp(
  sessionId: string | null,
  projectCwd: string | null,
  choiceToken: string,
): Promise<BrowserCredentialFillResult> {
  const raw = await apiPost<unknown>(
    browserApiPath("credentials/fill-totp", sessionId, projectCwd),
    browserBody(sessionId, projectCwd, { choiceToken }),
  );
  return normalizeCredentialFill(raw);
}

export async function allowAgentBrowserCredentialInspection(
  sessionId: string | null,
  projectCwd: string | null,
): Promise<BrowserCredentialInspectionResult> {
  return apiPost<BrowserCredentialInspectionResult>(
    browserApiPath("credentials/allow-agent-inspection", sessionId, projectCwd),
    browserBody(sessionId, projectCwd),
  );
}

export async function lockBrowserCredentials(
  sessionId: string | null,
  projectCwd: string | null,
): Promise<{ locked: true }> {
  const raw = asRecord(await apiPost<unknown>(
    browserApiPath("credentials/lock", sessionId, projectCwd),
    browserBody(sessionId, projectCwd),
  ));
  if (raw.locked !== true) throw new Error("Credential vault did not confirm it was locked");
  return { locked: true };
}

function protectedAutomationCredentialPath(
  selection: ProtectedAutomationPreparationSelection,
  operation: string,
): string {
  return `${protectedAutomationPreparationBase(selection)}/credentials/${operation}`;
}

export async function fetchProtectedAutomationCredentialStatus(
  selection: ProtectedAutomationPreparationSelection,
): Promise<BrowserCredentialStatus> {
  const raw = asRecord(await apiPost<unknown>(protectedAutomationCredentialPath(selection, "status")));
  if (typeof raw.available !== "boolean" || typeof raw.unlocked !== "boolean") {
    throw new Error("Automation credential broker returned an invalid status");
  }
  return {
    availability: !raw.available ? "unavailable" : raw.unlocked ? "unlocked" : "locked",
    exactOrigin: exactOrigin(raw.origin),
    ...(typeof raw.unlockExpiresAt === "number" ? { unlockExpiresAt: raw.unlockExpiresAt } : {}),
  };
}

export async function fetchProtectedAutomationCredentialMatches(
  selection: ProtectedAutomationPreparationSelection,
): Promise<BrowserCredentialMatches> {
  let raw: Record<string, unknown>;
  try {
    raw = asRecord(await apiPost<unknown>(protectedAutomationCredentialPath(selection, "matches")));
  } catch (error) {
    if (error instanceof ApiError && error.status === 503) return { availability: "unavailable", exactOrigin: null, choices: [] };
    if (error instanceof ApiError && error.status === 409) return { availability: "locked", exactOrigin: null, choices: [] };
    throw error;
  }
  const rawChoices = Array.isArray(raw.choices) ? raw.choices : [];
  return {
    availability: "unlocked",
    exactOrigin: exactOrigin(raw.origin),
    choices: rawChoices.flatMap((value): BrowserCredentialChoice[] => {
      const choice = asRecord(value);
      const choiceToken = typeof choice.choiceToken === "string"
        ? choice.choiceToken
        : typeof choice.token === "string" ? choice.token : "";
      if (!choiceToken) return [];
      return [{
        choiceToken,
        label: typeof choice.label === "string" && choice.label ? choice.label : "Saved login",
        maskedIdentifier: typeof choice.maskedIdentifier === "string" && choice.maskedIdentifier
          ? choice.maskedIdentifier : "Identifier hidden",
        hasTotp: choice.hasTotp === true || choice.totpAvailable === true,
        matchWarning: typeof choice.matchWarning === "string" ? choice.matchWarning
          : typeof choice.warning === "string" ? choice.warning : undefined,
      }];
    }),
  };
}

export async function fillProtectedAutomationCredentialLogin(
  selection: ProtectedAutomationPreparationSelection,
  choiceToken: string,
): Promise<BrowserCredentialFillResult> {
  return normalizeCredentialFill(await apiPost<unknown>(
    protectedAutomationCredentialPath(selection, "fill"),
    { choiceToken },
  ));
}

export async function fillProtectedAutomationCredentialTotp(
  selection: ProtectedAutomationPreparationSelection,
  choiceToken: string,
): Promise<BrowserCredentialFillResult> {
  return normalizeCredentialFill(await apiPost<unknown>(
    protectedAutomationCredentialPath(selection, "fill-totp"),
    { choiceToken },
  ));
}

export async function lockProtectedAutomationCredentials(
  selection: ProtectedAutomationPreparationSelection,
): Promise<{ locked: true }> {
  const raw = asRecord(await apiPost<unknown>(protectedAutomationCredentialPath(selection, "lock")));
  if (raw.locked !== true) throw new Error("Automation credential vault did not confirm it was locked");
  return { locked: true };
}

export function browserWsUrl(sessionId: string | null, projectCwd: string | null): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = new URLSearchParams(browserQuery(sessionId, projectCwd));
  params.set("frames", "binary");
  return `${proto}//${window.location.host}/ws/browser?${params.toString()}`;
}

export function browserVncWsUrl(sessionId: string | null, projectCwd: string | null): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = browserQuery(sessionId, projectCwd);
  return `${proto}//${window.location.host}/ws/browser-vnc?${params}`;
}

// ---------------------------------------------------------------------------
// TTS (Text-to-Speech)
// ---------------------------------------------------------------------------

export interface TtsChunkManifest {
  index: number;
  status: "pending" | "running" | "completed" | "failed";
  chars?: number;
  duration_seconds?: number | null;
  bytes?: number | null;
  url?: string | null;
}

export interface TtsJobManifest {
  job_id: string;
  status: "queued" | "running" | "completed" | "failed" | "cancelled";
  chunks_total: number;
  chunks_completed: number;
  chunks: TtsChunkManifest[];
  final_audio_url?: string | null;
  errors?: unknown[];
}

export interface TtsJobResponse {
  jobId: string;
  status: string;
  manifestUrl: string;
  eventsUrl: string;
}

export interface TtsLegacySynthesizeResponse {
  id: string;
  url: string;
  chunks: number;
  duration: number;
}

export type TtsSynthesizeResponse = TtsJobResponse | TtsLegacySynthesizeResponse;

export function synthesizeTts(
  sessionId: string,
  messageId: string,
): Promise<TtsSynthesizeResponse> {
  return apiPost<TtsSynthesizeResponse>("/api/tts/synthesize", {
    sessionId,
    messageId,
  });
}

// ---------------------------------------------------------------------------
// Durable projects and agent profiles
// ---------------------------------------------------------------------------

export type MemoryAccess = "none" | "read" | "read_write";
export type ResourceMode = "standard" | "project_only" | "custom";

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

export interface AgentProfileSummary {
  id: string;
  name: string;
  description: string | null;
  enabled: boolean;
  resource_mode: ResourceMode;
  memory_access: MemoryAccess;
  default_provider: string | null;
  default_model: string | null;
  allowed_tools: string[] | null;
  allowed_extensions: string[] | null;
  created_at: number;
  updated_at: number;
}

export interface AgentProfile extends AgentProfileSummary {
  instructions: string | null;
}

export interface ProjectInstructions {
  path: string;
  exists: boolean;
  text: string | null;
  sha256: string | null;
  git_tracked: boolean | null;
  git_changed: boolean | null;
}

export interface ProjectInput {
  cwd: string;
  name?: string;
  description?: string | null;
  color?: string | null;
  default_agent_profile_id?: string;
  default_provider?: string | null;
  default_model?: string | null;
  access_policy?: ProjectAccessPolicy;
}

export type ProjectUpdate = Omit<ProjectInput, "cwd">;

export interface AgentProfileInput {
  name: string;
  description?: string | null;
  resource_mode?: ResourceMode;
  instructions?: string | null;
  memory_access?: MemoryAccess;
  default_provider?: string | null;
  default_model?: string | null;
}

export interface AgentProfileUpdate {
  name?: string;
  description?: string | null;
  enabled?: boolean;
  resource_mode?: ResourceMode;
  instructions?: string | null;
  memory_access?: MemoryAccess;
  default_provider?: string | null;
  default_model?: string | null;
  replacement_agent_profile_id?: string;
}

export function fetchProjects(): Promise<WorkspaceProject[]> {
  return apiGet<WorkspaceProject[]>("/api/projects");
}

export function createProject(input: ProjectInput): Promise<WorkspaceProject> {
  return apiPost<WorkspaceProject>("/api/projects", input);
}

export function fetchProject(id: string): Promise<WorkspaceProject> {
  return apiGet<WorkspaceProject>(`/api/projects/${encodeURIComponent(id)}`);
}

export function updateProject(id: string, input: ProjectUpdate): Promise<WorkspaceProject> {
  return apiPut<WorkspaceProject>(`/api/projects/${encodeURIComponent(id)}`, input);
}

export function fetchProjectInstructions(id: string): Promise<ProjectInstructions> {
  return apiGet<ProjectInstructions>(`/api/projects/${encodeURIComponent(id)}/instructions`);
}

export function updateProjectInstructions(
  id: string,
  input: { text: string; expected_sha256?: string | null; create_if_missing?: boolean },
): Promise<ProjectInstructions> {
  return apiPut<ProjectInstructions>(`/api/projects/${encodeURIComponent(id)}/instructions`, input);
}

export function fetchAgentProfiles(): Promise<AgentProfileSummary[]> {
  return apiGet<AgentProfileSummary[]>("/api/agent-profiles");
}

export function createAgentProfile(input: AgentProfileInput): Promise<AgentProfile> {
  return apiPost<AgentProfile>("/api/agent-profiles", input);
}

export function fetchAgentProfile(id: string): Promise<AgentProfile> {
  return apiGet<AgentProfile>(`/api/agent-profiles/${encodeURIComponent(id)}`);
}

export function updateAgentProfile(id: string, input: AgentProfileUpdate): Promise<AgentProfile> {
  return apiPut<AgentProfile>(`/api/agent-profiles/${encodeURIComponent(id)}`, input);
}

export function deleteAgentProfile(id: string, replacementAgentProfileId?: string): Promise<null> {
  return request<null>("DELETE", `/api/agent-profiles/${encodeURIComponent(id)}`, replacementAgentProfileId
    ? { replacement_agent_profile_id: replacementAgentProfileId }
    : {});
}

// ---------------------------------------------------------------------------
// Project/session joins (virtual fallback retained for catalog durability)
// ---------------------------------------------------------------------------

export interface Project {
  id: string | null;
  cwd: string;
  name: string;
  description: string | null;
  color: string | null;
  default_agent_profile_id: string | null;
  default_provider: string | null;
  default_model: string | null;
  access_policy: ProjectAccessPolicy;
  sessions: Session[];
  lastActive: number;
}

export function groupSessionsIntoProjects(sessions: Session[]): Project[] {
  const byCwd = new Map<string, Session[]>();

  for (const s of sessions) {
    const key = s.cwd.replace(/\/+$/, "") || "/";
    const existing = byCwd.get(key);
    if (existing) {
      existing.push(s);
    } else {
      byCwd.set(key, [s]);
    }
  }

  const projects: Project[] = [];
  for (const [cwd, cwdSessions] of byCwd) {
    cwdSessions.sort((a, b) => b.last_active - a.last_active);
    const segments = cwd.split("/").filter(Boolean);
    projects.push({
      id: null,
      cwd,
      name: segments[segments.length - 1] || "/",
      description: null,
      color: null,
      default_agent_profile_id: null,
      default_provider: null,
      default_model: null,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
      sessions: cwdSessions,
      lastActive: cwdSessions[0].last_active,
    });
  }

  projects.sort((a, b) => b.lastActive - a.lastActive);
  return projects;
}

export function joinSessionsIntoProjects(
  sessions: Session[],
  durableProjects: WorkspaceProject[],
): Project[] {
  const virtual = groupSessionsIntoProjects(sessions);
  const byCwd = new Map(virtual.map((project) => [project.cwd, project]));

  for (const record of durableProjects) {
    const cwd = record.cwd.replace(/\/+$/, "") || "/";
    const existing = byCwd.get(cwd);
    byCwd.set(cwd, {
      id: record.id,
      cwd,
      name: record.name,
      description: record.description,
      color: record.color,
      default_agent_profile_id: record.default_agent_profile_id,
      default_provider: record.default_provider,
      default_model: record.default_model,
      access_policy: record.access_policy,
      sessions: existing?.sessions ?? [],
      lastActive: existing?.lastActive ?? record.updated_at,
    });
  }

  return [...byCwd.values()].sort((a, b) => b.lastActive - a.lastActive);
}

// ---------------------------------------------------------------------------
// Filesystem
// ---------------------------------------------------------------------------

export type FsEntryType = "file" | "dir" | "symlink";

export interface FsEntry {
  name: string;
  type: FsEntryType;
  size: number;
  mtime: number;
}

export interface DiscoveredProject {
  cwd: string;
  name: string;
  hasPiSessions: boolean;
  hasGit: boolean;
  hasPiConfig: boolean;
  hasPackageJson: boolean;
  lastModified: number;
}

export interface FsTreeResult {
  root: string;
  path: string;
  entries: FsEntry[];
}

export interface FsTextRead {
  text: string;
  size: number;
  sha256: string;
  name: string;
}

export interface FsBinaryRead {
  binary: true;
  data_b64: string;
  size: number;
  name: string;
}

export interface FsTooLarge {
  too_large: true;
  size: number;
  name: string;
}

export type FsRead = FsTextRead | FsBinaryRead | FsTooLarge;

export function isFsTextRead(r: FsRead): r is FsTextRead {
  return "text" in r;
}

export function isFsBinaryRead(r: FsRead): r is FsBinaryRead {
  return "binary" in r;
}

export function isFsTooLarge(r: FsRead): r is FsTooLarge {
  return "too_large" in r;
}

export function fetchDiscoveredProjects(): Promise<DiscoveredProject[]> {
  return apiGet<DiscoveredProject[]>("/api/fs/discover-projects");
}

export function fetchFsTree(path: string, showHidden = false): Promise<FsTreeResult> {
  const params = new URLSearchParams({ path, show_hidden: showHidden ? "1" : "0" });
  return apiGet<FsTreeResult>(`/api/fs/tree?${params.toString()}`);
}

export function fetchFsRead(path: string): Promise<FsRead> {
  const params = new URLSearchParams({ path });
  return apiGet<FsRead>(`/api/fs/read?${params.toString()}`);
}

export function writeFsFile(
  path: string,
  content: string,
  expectedSha256?: string,
): Promise<{ sha256: string; size: number }> {
  return apiPut<{ sha256: string; size: number }>("/api/fs/write", {
    path,
    content,
    expected_sha256: expectedSha256,
  });
}

// ---------------------------------------------------------------------------
// Apps
// ---------------------------------------------------------------------------

export type AppStatus = "registered" | "stopped" | "starting" | "running" | "errored";

export interface AppManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  version?: string;
  entry: {
    type: "managed-process";
    workingDirectory: string;
    installCommand?: string;
    devCommand: string;
    healthPath?: string;
    port?: number;
  };
  bridge?: {
    initialStatePath?: string;
    statePath?: string;
  };
}

export interface RegisteredApp {
  id: string;
  sessionId?: string;
  projectCwd: string;
  manifestPath: string;
  manifest: AppManifest;
  status: AppStatus;
  url?: string;
  port?: number;
  lastError?: string;
  updatedAt: number;
}

export interface AppEvent {
  id: string;
  appId: string;
  sessionId?: string;
  projectCwd: string;
  type: "app_event";
  event: string;
  payload?: unknown;
  summary?: string;
  createdAt: number;
}

export interface AppStateRecord {
  appId: string;
  sessionId?: string;
  projectCwd: string;
  state: unknown;
  updatedAt: number;
}

function appQuery(sessionId: string | null, projectCwd?: string | null): string {
  const params = new URLSearchParams();
  if (sessionId) params.set("session_id", sessionId);
  if (projectCwd) params.set("project_cwd", projectCwd);
  return params.toString();
}

export async function fetchApps(sessionId: string, scan = true): Promise<RegisteredApp[]> {
  const params = new URLSearchParams({ session_id: sessionId, scan: scan ? "1" : "0" });
  const payload = await apiGet<unknown>(`/api/apps?${params.toString()}`);
  return Array.isArray(payload) ? (payload as RegisteredApp[]) : [];
}

export function registerApp(input: {
  sessionId?: string;
  projectCwd?: string;
  manifestPath: string;
}): Promise<RegisteredApp> {
  return apiPost<RegisteredApp>("/api/apps/register", input);
}

export function startApp(appId: string, sessionId: string): Promise<RegisteredApp> {
  return apiPost<RegisteredApp>(`/api/apps/${encodeURIComponent(appId)}/start`, { sessionId });
}

export function stopApp(appId: string, sessionId: string): Promise<RegisteredApp> {
  return apiPost<RegisteredApp>(`/api/apps/${encodeURIComponent(appId)}/stop`, { sessionId });
}

export function restartApp(appId: string, sessionId: string): Promise<RegisteredApp> {
  return apiPost<RegisteredApp>(`/api/apps/${encodeURIComponent(appId)}/restart`, { sessionId });
}

export function fetchAppLogs(appId: string, sessionId: string): Promise<{ lines: string[] }> {
  const params = appQuery(sessionId);
  return apiGet<{ lines: string[] }>(`/api/apps/${encodeURIComponent(appId)}/logs?${params}`);
}

export async function fetchAppEvents(appId: string, sessionId: string): Promise<AppEvent[]> {
  const params = appQuery(sessionId);
  const payload = await apiGet<unknown>(`/api/apps/${encodeURIComponent(appId)}/events?${params}`);
  return Array.isArray(payload) ? (payload as AppEvent[]) : [];
}

export function postAppEvent(
  appId: string,
  sessionId: string,
  input: { event: string; payload?: unknown; summary?: string; sendToAgent?: boolean },
): Promise<AppEvent> {
  return apiPost<AppEvent>(`/api/apps/${encodeURIComponent(appId)}/events`, { ...input, sessionId });
}

export function fetchAppState(appId: string, sessionId: string): Promise<AppStateRecord> {
  const params = appQuery(sessionId);
  return apiGet<AppStateRecord>(`/api/apps/${encodeURIComponent(appId)}/state?${params}`);
}

export function updateAppState(appId: string, sessionId: string, state: unknown): Promise<AppStateRecord> {
  return apiPut<AppStateRecord>(`/api/apps/${encodeURIComponent(appId)}/state`, { sessionId, state });
}
