import { randomUUID } from "node:crypto";
import { getAgentProfile } from "../agent-profiles.js";
import { commitStoreMutation, flush, getStore } from "../db.js";
import { authorizeProjectAction } from "../policy.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import { nextCronOccurrence, validateCronExpression } from "./cron.js";
import type { ScheduledJobCommandGuardMode, ScheduledJobInput, ScheduledJobRow, ScheduledRunRow, ScheduledJobStatus, ScheduledJobTrigger } from "./types.js";

const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_PROMPT_TIMEOUT_MS = 60_000;
const MAX_RUNS_PER_JOB = 500;

export function listScheduledJobs(): ScheduledJobRow[] {
  const store = getStore();
  return [...store.scheduledJobs]
    .map(cloneJob)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function getScheduledJob(id: string): ScheduledJobRow | undefined {
  const row = getStore().scheduledJobs.find((job) => job.id === id);
  return row ? cloneJob(row) : undefined;
}

export function listScheduledRuns(jobId: string, limit = 100): ScheduledRunRow[] {
  return getStore()
    .scheduledRuns.map((run, index) => ({ run, index }))
    .filter(({ run }) => run.job_id === jobId)
    .sort((a, b) => (b.run.started_at - a.run.started_at) || (b.index - a.index))
    .slice(0, limit)
    .map(({ run }) => cloneRun(run));
}

export function createScheduledJob(input: ScheduledJobInput): ScheduledJobRow {
  const name = requiredString(input.name, "name");
  const cronExpr = requiredString(input.cron_expr, "cron_expr");
  const prompt = requiredString(input.prompt, "prompt");
  const cwd = requiredString(input.cwd, "cwd");
  const agentProfileId = validateAgentProfileId(input.agent_profile_id);
  validateCronExpression(cronExpr);
  requireScheduledAuthorization(cwd, agentProfileId);

  const store = getStore();
  const now = Date.now();
  const enabled = input.enabled ?? true;
  const job: ScheduledJobRow = {
    id: randomUUID(),
    name,
    schedule_kind: "cron",
    cron_expr: cronExpr,
    timezone: null,
    prompt,
    cwd,
    provider: normalizeNullableString(input.provider),
    model: normalizeNullableString(input.model),
    agent_profile_id: agentProfileId,
    permission_mode: normalizeString(input.permission_mode) || "bypass",
    command_guard_mode: normalizeCommandGuardMode(input.command_guard_mode),
    timeout_ms: positiveInteger(input.timeout_ms, DEFAULT_TIMEOUT_MS, "timeout_ms"),
    prompt_timeout_ms: positiveInteger(input.prompt_timeout_ms, DEFAULT_PROMPT_TIMEOUT_MS, "prompt_timeout_ms"),
    overlap_policy: "skip",
    missed_run_policy: "skip",
    enabled,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    next_run_at: enabled ? nextCronOccurrence(cronExpr, now) : null,
  };
  store.scheduledJobs.push(job);
  flush();
  return cloneJob(job);
}

export function updateScheduledJob(id: string, input: ScheduledJobInput): ScheduledJobRow | undefined {
  const job = getStore().scheduledJobs.find((row) => row.id === id);
  if (!job) return undefined;

  // Build and validate a private candidate before publishing any fields. The
  // attribution ID and its capability marker must always move together.
  const candidate = { ...job };
  if (input.name !== undefined) candidate.name = requiredString(input.name, "name");
  if (input.cron_expr !== undefined) {
    const cronExpr = requiredString(input.cron_expr, "cron_expr");
    validateCronExpression(cronExpr);
    candidate.cron_expr = cronExpr;
  }
  if (input.prompt !== undefined) candidate.prompt = requiredString(input.prompt, "prompt");
  if (input.cwd !== undefined) candidate.cwd = requiredString(input.cwd, "cwd");
  if (input.provider !== undefined) candidate.provider = normalizeNullableString(input.provider);
  if (input.model !== undefined) candidate.model = normalizeNullableString(input.model);
  if (input.agent_profile_id !== undefined) {
    const agentProfileId = validateAgentProfileId(input.agent_profile_id);
    candidate.agent_profile_id = agentProfileId;
    candidate.legacy_capability_ineligible = agentProfileId === null;
  }
  if (input.permission_mode !== undefined) candidate.permission_mode = normalizeString(input.permission_mode) || "bypass";
  if (input.command_guard_mode !== undefined) candidate.command_guard_mode = normalizeCommandGuardMode(input.command_guard_mode);
  if (input.timeout_ms !== undefined) candidate.timeout_ms = positiveInteger(input.timeout_ms, DEFAULT_TIMEOUT_MS, "timeout_ms");
  if (input.prompt_timeout_ms !== undefined) candidate.prompt_timeout_ms = positiveInteger(input.prompt_timeout_ms, DEFAULT_PROMPT_TIMEOUT_MS, "prompt_timeout_ms");
  if (input.enabled !== undefined) candidate.enabled = Boolean(input.enabled);

  requireScheduledAuthorization(candidate.cwd, candidate.agent_profile_id);
  const now = Date.now();
  candidate.updated_at = now;
  candidate.next_run_at = candidate.enabled ? nextCronOccurrence(candidate.cron_expr, now) : null;

  return commitStoreMutation((draft) => {
    const target = draft.scheduledJobs.find((row) => row.id === id);
    if (!target) return undefined;
    Object.assign(target, candidate);
    return cloneJob(target);
  });
}

export function deleteScheduledJob(id: string): boolean {
  const store = getStore();
  const before = store.scheduledJobs.length;
  store.scheduledJobs = store.scheduledJobs.filter((job) => job.id !== id);
  const deleted = store.scheduledJobs.length !== before;
  if (deleted) flush();
  return deleted;
}

export function setJobScheduleMetadata(id: string, values: Partial<Pick<ScheduledJobRow, "last_run_at" | "next_run_at">>): void {
  const job = getStore().scheduledJobs.find((row) => row.id === id);
  if (!job) return;
  if ("last_run_at" in values) job.last_run_at = values.last_run_at ?? null;
  if ("next_run_at" in values) job.next_run_at = values.next_run_at ?? null;
  job.updated_at = Date.now();
  flush();
}

export function createScheduledRun(params: {
  jobId: string;
  trigger: ScheduledJobTrigger;
  scheduledFor: number | null;
  status?: ScheduledJobStatus;
  sessionId?: string | null;
  errorMessage?: string | null;
  resultSummary?: string | null;
}): ScheduledRunRow {
  const store = getStore();
  const now = Date.now();
  const run: ScheduledRunRow = {
    id: randomUUID(),
    job_id: params.jobId,
    session_id: params.sessionId ?? null,
    trigger: params.trigger,
    scheduled_for: params.scheduledFor,
    started_at: now,
    finished_at: params.status && params.status !== "running" ? now : null,
    status: params.status ?? "running",
    error_message: params.errorMessage ?? null,
    result_summary: params.resultSummary ?? null,
  };
  store.scheduledRuns.push(run);
  pruneRunsForJob(params.jobId);
  flush();
  return cloneRun(run);
}

export function updateScheduledRun(id: string, values: Partial<Pick<ScheduledRunRow, "session_id" | "finished_at" | "status" | "error_message" | "result_summary">>): ScheduledRunRow | undefined {
  const run = getStore().scheduledRuns.find((row) => row.id === id);
  if (!run) return undefined;
  if ("session_id" in values) run.session_id = values.session_id ?? null;
  if ("finished_at" in values) run.finished_at = values.finished_at ?? null;
  if ("status" in values && values.status) run.status = values.status;
  if ("error_message" in values) run.error_message = values.error_message ?? null;
  if ("result_summary" in values) run.result_summary = values.result_summary ?? null;
  flush();
  return cloneRun(run);
}

export function hasRunningRun(jobId: string): boolean {
  return getStore().scheduledRuns.some((run) => run.job_id === jobId && run.status === "running");
}

export function markStaleScheduledRunsFailed(reason = "interrupted by scheduler restart"): number {
  const store = getStore();
  const now = Date.now();
  let count = 0;
  for (const run of store.scheduledRuns) {
    if (run.status === "running") {
      run.status = "failed";
      run.finished_at = now;
      run.error_message = reason;
      count++;
    }
  }
  if (count > 0) flush();
  return count;
}

function requiredString(value: unknown, field: string): string {
  const normalized = normalizeString(value);
  if (!normalized) throw new Error(`${field} is required`);
  return normalized;
}

function normalizeString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeNullableString(value: unknown): string | null {
  const normalized = normalizeString(value);
  return normalized ? normalized : null;
}

function requireScheduledAuthorization(cwd: string, agentProfileId: string | null): void {
  const decision = authorizeProjectAction({ cwd, actor: "scheduled", agentProfileId });
  if (!decision.allowed) throw new WorkspaceStoreError(decision.reason ?? "Scheduled project access denied", 403);
  if (decision.project?.access_policy.privacy_mode === "protected" && agentProfileId === null) {
    throw new WorkspaceStoreError("Protected scheduled jobs require an explicit agent_profile_id", 403);
  }
}

function validateAgentProfileId(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim()) {
    throw new WorkspaceStoreError("agent_profile_id must be a nonempty string or null");
  }
  const id = value.trim();
  const profile = getAgentProfile(id);
  if (!profile) throw new WorkspaceStoreError("Agent profile not found", 404);
  if (!profile.enabled) throw new WorkspaceStoreError("Agent profile must be enabled", 409);
  return id;
}

function positiveInteger(value: unknown, fallback: number, field: string): number {
  if (value === undefined || value === null || value === "") return fallback;
  const num = Number(value);
  if (!Number.isFinite(num) || num <= 0) throw new Error(`${field} must be a positive number`);
  return Math.floor(num);
}

function normalizeCommandGuardMode(value: unknown): ScheduledJobCommandGuardMode {
  const normalized = normalizeString(value).toLowerCase();
  if (normalized === "on" || normalized === "enable" || normalized === "enabled") return "balanced";
  if (["default", "off", "balanced", "audit", "strict"].includes(normalized)) return normalized as ScheduledJobCommandGuardMode;
  return "default";
}

function pruneRunsForJob(jobId: string): void {
  const store = getStore();
  const runs = store.scheduledRuns
    .filter((run) => run.job_id === jobId)
    .sort((a, b) => b.started_at - a.started_at);
  const keep = new Set(runs.slice(0, MAX_RUNS_PER_JOB).map((run) => run.id));
  store.scheduledRuns = store.scheduledRuns.filter((run) => run.job_id !== jobId || keep.has(run.id));
}

function cloneJob(job: ScheduledJobRow): ScheduledJobRow {
  // Ignore unknown legacy metadata rather than exposing implementation-specific
  // migration provenance through the public API.
  const { migrated_from: _legacyMigration, ...publicJob } = job as ScheduledJobRow & { migrated_from?: unknown };
  return { ...publicJob, agent_profile_id: publicJob.agent_profile_id ?? null };
}

function cloneRun(run: ScheduledRunRow): ScheduledRunRow {
  return { ...run };
}
