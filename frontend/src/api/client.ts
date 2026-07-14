/**
 * api/client.ts — Frontend API client for wayang backend.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type SessionRuntimeStatus = "active" | "starting" | "stopped";

export interface Session {
  id: string;
  pi_session_file: string | null;
  title: string;
  cwd: string;
  provider: string | null;
  model: string | null;
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
  runtime_subscriber_count: number;
  runtime_last_activity_at: number | null;
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
): Promise<T> {
  const init: RequestInit = {
    method,
    credentials: "include",
    redirect: "manual",
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
    if (res.status === 401 && notifyOnUnauthorized) reportUnauthorized();
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
): Promise<Session> {
  return apiPost<Session>("/api/sessions", { cwd, title: title ?? "", model, provider });
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

export interface BrowserProfileMetadata {
  key: string;
  projectCwd: string;
  rootDir: string;
  profileDir: string;
  downloadsDir: string;
  artifactsDir: string;
  runtimePath: string;
  persistence: "project" | "session";
}

export interface BrowserSessionState {
  sessionId: string | null;
  projectCwd: string;
  key: string;
  status: BrowserLifecycleStatus;
  controlMode: BrowserControlMode;
  secretTainted: boolean;
  localOnlyRecommended: boolean;
  needsUser: boolean;
  needsUserReason?: string;
  lastResumeAt?: number;
  activeUrl?: string;
  activeTitle?: string;
  cdpPort?: number;
  cdpReady: boolean;
  viewerTransport: BrowserViewerTransport;
  viewerWsPath?: string;
  cdpScreencastWsPath?: string;
  vncReady: boolean;
  vncPort?: number;
  display?: string;
  profile: BrowserProfileMetadata;
  startedAt?: number;
  updatedAt: number;
  lastError?: string;
  logs: string[];
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

export function fetchBrowserStatus(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiGet<BrowserSessionState>(`/api/browser/status?${browserQuery(sessionId, projectCwd)}`);
}

export function startBrowser(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>("/api/browser/start", browserBody(sessionId, projectCwd));
}

export function stopBrowser(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>("/api/browser/stop", browserBody(sessionId, projectCwd));
}

export function restartBrowser(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>("/api/browser/restart", browserBody(sessionId, projectCwd));
}

export function resetBrowserProfile(sessionId: string | null, projectCwd: string | null): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>("/api/browser/reset-profile", browserBody(sessionId, projectCwd));
}

export function setBrowserControlMode(
  sessionId: string | null,
  projectCwd: string | null,
  mode: BrowserControlMode,
  reason?: string,
): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>("/api/browser/control-mode", browserBody(sessionId, projectCwd, { mode, reason }));
}

export function navigateBrowser(sessionId: string | null, projectCwd: string | null, url: string): Promise<BrowserSessionState> {
  return apiPost<BrowserSessionState>("/api/browser/navigate", browserBody(sessionId, projectCwd, { url }));
}

export function snapshotBrowser(
  sessionId: string | null,
  projectCwd: string | null,
  mode: "text" | "screenshot" = "text",
): Promise<BrowserSnapshot> {
  return apiPost<BrowserSnapshot>("/api/browser/snapshot", browserBody(sessionId, projectCwd, { mode }));
}

export async function pasteTextBrowser(sessionId: string | null, projectCwd: string | null, text: string): Promise<BrowserSessionState> {
  const body = browserBody(sessionId, projectCwd, { text });
  try {
    return await apiPost<BrowserSessionState>("/api/browser/paste-text", body);
  } catch (err) {
    // During rolling frontend/backend updates, an already-running backend may
    // not have the user-paste endpoint yet. Fall back to the existing CDP text
    // insertion route so the UI works immediately after the frontend build is
    // served, without exposing clipboard text to chat or logs.
    if (err instanceof ApiError && err.status === 404) {
      return apiPost<BrowserSessionState>("/api/browser/type-public", body);
    }
    throw err;
  }
}

export function browserWsUrl(sessionId: string | null, projectCwd: string | null): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  const params = browserQuery(sessionId, projectCwd);
  return `${proto}//${window.location.host}/ws/browser?${params}`;
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
// Projects — virtual grouping by cwd
// ---------------------------------------------------------------------------

export interface Project {
  cwd: string;
  name: string;
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
      cwd,
      name: segments[segments.length - 1] || "/",
      sessions: cwdSessions,
      lastActive: cwdSessions[0].last_active,
    });
  }

  projects.sort((a, b) => b.lastActive - a.lastActive);
  return projects;
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
