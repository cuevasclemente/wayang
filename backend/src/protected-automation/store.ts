import { randomUUID } from "node:crypto";
import { commitStoreMutation, getStore, type StoreData } from "../db.js";
import { validateCronExpression } from "../scheduler/cron.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import { deriveWorkspaceCapabilityAssociation } from "../derived-project-authority.js";
import { verifyProtectedAutomationSnapshot } from "./snapshots.js";
import {
  retireProtectedAutomationRunStorage,
  type ProtectedAutomationRunStorageIdentity,
} from "./runtime-storage.js";
export { blockProtectedAutomationJobsDraft } from "./draft-lifecycle.js";
import {
  MAX_PROTECTED_AUTOMATION_ARGV_BYTES,
  MAX_PROTECTED_AUTOMATION_ARGV_ITEMS,
  MAX_PROTECTED_AUTOMATION_ARG_BYTES,
  MAX_PROTECTED_AUTOMATION_CRON_BYTES,
  MAX_PROTECTED_AUTOMATION_ENTRYPOINT_BYTES,
  MAX_PROTECTED_AUTOMATION_HTTPS_ORIGINS,
  MAX_PROTECTED_AUTOMATION_JOBS,
  MAX_PROTECTED_AUTOMATION_NAME_BYTES,
  MAX_PROTECTED_AUTOMATION_ORIGIN_BYTES,
  MAX_PROTECTED_AUTOMATION_OUTCOME_CODE_BYTES,
  MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB,
  MAX_PROTECTED_AUTOMATION_TIMEOUT_MS,
  MIN_PROTECTED_AUTOMATION_TIMEOUT_MS,
  PROTECTED_AUTOMATION_CAPABILITY_ID,
  type ProtectedAutomationJobCreateInput,
  type ProtectedAutomationJobRow,
  type ProtectedAutomationJobUpdateFields,
  type ProtectedAutomationRunCreateInput,
  type ProtectedAutomationRunRow,
  type ProtectedAutomationRunStatus,
  type ProtectedAutomationTrigger,
} from "./types.js";

const JOB_CREATE_KEYS = [
  "agent_profile_id", "allowed_https_origins", "argv", "capability_revision", "cron_expr", "entrypoint", "id",
  "missed_run_policy", "name", "overlap_policy", "project_id", "source_manifest_sha256", "timeout_ms",
  "timezone", "uses_browser_profile",
] as const;
const JOB_UPDATE_KEYS = [
  "allowed_https_origins", "argv", "cron_expr", "entrypoint", "missed_run_policy", "name", "overlap_policy",
  "source_manifest_sha256", "timeout_ms", "timezone", "uses_browser_profile",
] as const;
const RUN_CREATE_KEYS = [
  "agent_profile_id", "capability_revision", "exit_code", "finished_at", "id", "job_id", "job_revision",
  "occurrence_key", "outcome_code", "project_id", "scheduled_for", "started_at", "status", "trigger",
] as const;
const TERMINAL = new Set<ProtectedAutomationRunStatus>([
  "completed", "failed", "skipped", "cancelled", "needs_user", "interrupted", "denied",
]);

export interface ProtectedAutomationReferences { jobs: string[]; runs: string[] }

function cloneJob(row: ProtectedAutomationJobRow): ProtectedAutomationJobRow {
  return { ...row, argv: [...row.argv], allowed_https_origins: [...row.allowed_https_origins] };
}
function cloneRun(row: ProtectedAutomationRunRow): ProtectedAutomationRunRow { return { ...row }; }
function exactKeys(value: object, allowed: readonly string[], label: string, requireAll: boolean): void {
  const actual = Object.keys(value);
  const allowedSet = new Set<string>(allowed);
  if (actual.some((key) => !allowedSet.has(key))) throw new WorkspaceStoreError(`${label} contains unsupported fields`);
  if (requireAll && allowed.some((key) => !Object.hasOwn(value, key))) throw new WorkspaceStoreError(`${label} is missing required fields`);
}
function stableId(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 256 || value !== value.normalize("NFC")
    || /[\u0000-\u001f\u007f]/u.test(value)) throw new WorkspaceStoreError(`${label} must be an exact stable ID`);
  return value;
}
function finiteTimestamp(value: unknown, label: string, nullable = false): number | null {
  if (value === null && nullable) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) throw new WorkspaceStoreError(`${label} must be a nonnegative finite timestamp`);
  return value;
}
function positiveRevision(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) >= Number.MAX_SAFE_INTEGER) {
    throw new WorkspaceStoreError(`${label} must be a positive safe revision`);
  }
  return value as number;
}
function nextRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value >= Number.MAX_SAFE_INTEGER - 1) {
    throw new WorkspaceStoreError("Protected automation job revision is exhausted", 409);
  }
  return value + 1;
}
function boundedText(value: unknown, label: string, maxBytes: number): string {
  if (typeof value !== "string" || value.length === 0 || value !== value.normalize("NFC")
    || /[\u0000-\u001f\u007f]/u.test(value) || Buffer.byteLength(value, "utf8") > maxBytes) {
    throw new WorkspaceStoreError(`${label} is invalid or exceeds its compiled bound`);
  }
  return value;
}
function manifestSha256(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) throw new WorkspaceStoreError("source_manifest_sha256 must be a lowercase SHA-256 digest");
  return value;
}
function relativeEntrypoint(value: unknown): string {
  const entrypoint = boundedText(value, "entrypoint", MAX_PROTECTED_AUTOMATION_ENTRYPOINT_BYTES);
  if (entrypoint.startsWith("/") || entrypoint.includes("\\") || entrypoint.split("/").some((part) => !part || part === "." || part === "..")) {
    throw new WorkspaceStoreError("entrypoint must be a normalized relative snapshot path");
  }
  return entrypoint;
}
function argv(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROTECTED_AUTOMATION_ARGV_ITEMS) throw new WorkspaceStoreError("argv exceeds its compiled item bound");
  let bytes = 0;
  const result = value.map((candidate) => {
    if (typeof candidate !== "string" || candidate !== candidate.normalize("NFC") || /[\u0000-\u001f\u007f]/u.test(candidate)) {
      throw new WorkspaceStoreError("argv contains an invalid value");
    }
    const itemBytes = Buffer.byteLength(candidate, "utf8");
    if (itemBytes > MAX_PROTECTED_AUTOMATION_ARG_BYTES) throw new WorkspaceStoreError("argv item exceeds its compiled byte bound");
    bytes += itemBytes;
    return candidate;
  });
  if (bytes > MAX_PROTECTED_AUTOMATION_ARGV_BYTES) throw new WorkspaceStoreError("argv exceeds its compiled byte bound");
  return result;
}
function exactHttpsOrigins(value: unknown): string[] {
  if (!Array.isArray(value) || value.length > MAX_PROTECTED_AUTOMATION_HTTPS_ORIGINS) throw new WorkspaceStoreError("allowed_https_origins exceeds its compiled item bound");
  const result: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (typeof candidate !== "string" || Buffer.byteLength(candidate, "utf8") > MAX_PROTECTED_AUTOMATION_ORIGIN_BYTES) throw new WorkspaceStoreError("allowed_https_origins contains an invalid origin");
    let parsed: URL;
    try { parsed = new URL(candidate); } catch { throw new WorkspaceStoreError("allowed_https_origins contains an invalid URL"); }
    if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash
      || parsed.origin !== candidate || seen.has(candidate)) throw new WorkspaceStoreError("allowed_https_origins must contain unique exact HTTPS origins");
    seen.add(candidate); result.push(candidate);
  }
  return result;
}
function cronExpression(value: unknown): string {
  const expression = boundedText(value, "cron_expr", MAX_PROTECTED_AUTOMATION_CRON_BYTES);
  if (expression.trim() !== expression) throw new WorkspaceStoreError("cron_expr must be canonical without surrounding whitespace");
  try { validateCronExpression(expression); } catch (error) { throw new WorkspaceStoreError(error instanceof Error ? error.message : "Invalid cron_expr"); }
  return expression;
}
function timeout(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < MIN_PROTECTED_AUTOMATION_TIMEOUT_MS || (value as number) > MAX_PROTECTED_AUTOMATION_TIMEOUT_MS) {
    throw new WorkspaceStoreError("timeout_ms is outside its compiled bounds");
  }
  return value as number;
}
function validateJobConfiguration(input: ProtectedAutomationJobCreateInput | ProtectedAutomationJobUpdateFields): ProtectedAutomationJobUpdateFields {
  if (input.timezone !== "local") throw new WorkspaceStoreError("timezone must be local in v1");
  if (input.overlap_policy !== "skip") throw new WorkspaceStoreError("overlap_policy must be skip in v1");
  if (input.missed_run_policy !== "skip" && input.missed_run_policy !== "run_once") throw new WorkspaceStoreError("Invalid missed_run_policy");
  if (typeof input.uses_browser_profile !== "boolean") throw new WorkspaceStoreError("uses_browser_profile must be boolean");
  return {
    name: boundedText(input.name, "name", MAX_PROTECTED_AUTOMATION_NAME_BYTES),
    source_manifest_sha256: manifestSha256(input.source_manifest_sha256), entrypoint: relativeEntrypoint(input.entrypoint),
    argv: argv(input.argv), uses_browser_profile: input.uses_browser_profile, allowed_https_origins: exactHttpsOrigins(input.allowed_https_origins),
    cron_expr: cronExpression(input.cron_expr), timezone: "local", timeout_ms: timeout(input.timeout_ms), overlap_policy: "skip",
    missed_run_policy: input.missed_run_policy,
  };
}
function requireCurrentPair(draft: StoreData, projectId: string, profileId: string, capabilityRevision: number): void {
  const project = draft.projects.find((row) => row.id === projectId);
  const profile = draft.agentProfiles.find((row) => row.id === profileId);
  if (!project) throw new WorkspaceStoreError("Protected automation project not found", 404);
  if (!profile) throw new WorkspaceStoreError("Protected automation agent profile not found", 404);
  if (project.access_policy.privacy_mode !== "protected") throw new WorkspaceStoreError("Protected automation requires a Protected project", 409);
  if (!profile.enabled) throw new WorkspaceStoreError("Protected automation agent profile must be enabled", 409);
  if (!project.access_policy.allowed_agent_profile_ids?.includes(profileId)) throw new WorkspaceStoreError("Protected automation agent profile is not allowed for this project", 403);
  const authority = deriveWorkspaceCapabilityAssociation({
    capability_id: PROTECTED_AUTOMATION_CAPABILITY_ID,
    project_id: projectId,
    agent_profile_id: profileId,
  }, project, profile);
  if (authority.revision !== capabilityRevision) {
    throw new WorkspaceStoreError("Protected automation derived authority revision is not current", 409);
  }
}
function occurrenceKey(value: unknown, nullable: boolean): string | null {
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw new WorkspaceStoreError("occurrence_key must be a host-local wall-minute key");
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/u.exec(value);
  if (!match) throw new WorkspaceStoreError("occurrence_key must be a host-local wall-minute key");
  const [year, month, day, hour, minute] = match.slice(1).map(Number) as [number, number, number, number, number];
  const roundTrip = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (year < 1 || roundTrip.getUTCFullYear() !== year || roundTrip.getUTCMonth() !== month - 1 || roundTrip.getUTCDate() !== day
    || roundTrip.getUTCHours() !== hour || roundTrip.getUTCMinutes() !== minute) throw new WorkspaceStoreError("occurrence_key must be a valid host-local wall-minute key");
  return value;
}
function keyForTimestamp(timestamp: number): string {
  const date = new Date(timestamp); const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function validateScheduleAttribution(trigger: ProtectedAutomationTrigger, scheduledFor: number | null, key: string | null, startedAt: number): void {
  if (trigger === "schedule") {
    if (scheduledFor === null || key === null || scheduledFor > startedAt || keyForTimestamp(scheduledFor) !== key) {
      throw new WorkspaceStoreError("Protected automation run scheduling attribution is inconsistent");
    }
  } else if (scheduledFor !== null || key !== null) throw new WorkspaceStoreError("Protected automation run scheduling attribution is inconsistent");
}
function pruneRunsDraft(draft: StoreData, jobId: string): ProtectedAutomationRunStorageIdentity[] {
  const rows = draft.protectedAutomationRuns.filter((run) => run.job_id === jobId);
  const retired: ProtectedAutomationRunStorageIdentity[] = [];
  while (rows.length >= MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB) {
    const oldest = rows.filter((run) => TERMINAL.has(run.status)).sort((a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id))[0];
    if (!oldest) throw new WorkspaceStoreError("Protected automation active run history limit reached", 409);
    retired.push({ projectId: oldest.project_id, agentProfileId: oldest.agent_profile_id, jobId: oldest.job_id, runId: oldest.id });
    draft.protectedAutomationRuns = draft.protectedAutomationRuns.filter((run) => run.id !== oldest.id);
    rows.splice(rows.indexOf(oldest), 1);
  }
  return retired;
}
function retireCommittedRuns(retired: readonly ProtectedAutomationRunStorageIdentity[]): void {
  for (const identity of retired) retireProtectedAutomationRunStorage(identity);
}
function cancelQueuedDraft(draft: StoreData, jobId: string, now: number, outcome: string): void {
  for (const run of draft.protectedAutomationRuns) {
    if (run.job_id === jobId && run.status === "queued") {
      run.status = "cancelled"; run.finished_at = Math.max(now, run.started_at); run.outcome_code = outcome; run.exit_code = null;
    }
  }
}

export function listProtectedAutomationJobs(): ProtectedAutomationJobRow[] {
  return getStore().protectedAutomationJobs.map(cloneJob).sort((a, b) => a.created_at - b.created_at || a.id.localeCompare(b.id));
}
export function getProtectedAutomationJob(id: string): ProtectedAutomationJobRow | undefined {
  const row = getStore().protectedAutomationJobs.find((candidate) => candidate.id === id); return row ? cloneJob(row) : undefined;
}
export function getProtectedAutomationRun(id: string): ProtectedAutomationRunRow | undefined {
  const row = getStore().protectedAutomationRuns.find((candidate) => candidate.id === id); return row ? cloneRun(row) : undefined;
}
export function listProtectedAutomationRuns(jobId: string, limit = 100): ProtectedAutomationRunRow[] {
  if (!Number.isSafeInteger(limit) || limit < 0 || limit > MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB) throw new WorkspaceStoreError("Invalid protected automation run limit");
  return getStore().protectedAutomationRuns.filter((row) => row.job_id === jobId)
    .sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id)).slice(0, limit).map(cloneRun);
}
export function listProtectedAutomationActiveRuns(): ProtectedAutomationRunRow[] {
  return getStore().protectedAutomationRuns.filter((run) => run.status === "queued" || run.status === "running").map(cloneRun);
}

export function createProtectedAutomationJob(input: ProtectedAutomationJobCreateInput, now = Date.now()): ProtectedAutomationJobRow {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkspaceStoreError("Protected automation job input must be an object");
  exactKeys(input, JOB_CREATE_KEYS, "Protected automation job input", false);
  for (const key of JOB_CREATE_KEYS) if (key !== "id" && !Object.hasOwn(input, key)) throw new WorkspaceStoreError("Protected automation job input is missing required fields");
  const id = input.id === undefined ? randomUUID() : stableId(input.id, "job id");
  const projectId = stableId(input.project_id, "project_id"); const profileId = stableId(input.agent_profile_id, "agent_profile_id");
  const capabilityRevision = positiveRevision(input.capability_revision, "capability_revision"); const configuration = validateJobConfiguration(input);
  const timestamp = finiteTimestamp(now, "creation time")!;
  return commitStoreMutation((draft) => {
    if (draft.protectedAutomationJobs.length >= MAX_PROTECTED_AUTOMATION_JOBS) throw new WorkspaceStoreError("Protected automation job limit reached", 409);
    requireCurrentPair(draft, projectId, profileId, capabilityRevision);
    if (draft.protectedAutomationJobs.some((candidate) => candidate.id === id)) throw new WorkspaceStoreError("Protected automation job ID already exists", 409);
    const snapshot = verifyProtectedAutomationSnapshot({ projectId, agentProfileId: profileId, jobId: id, revision: 1,
      expectedManifestSha256: configuration.source_manifest_sha256 });
    if (snapshot.entrypoint !== configuration.entrypoint) throw new WorkspaceStoreError("Protected automation snapshot entrypoint does not match the job", 409);
    const row: ProtectedAutomationJobRow = {
      id, project_id: projectId, agent_profile_id: profileId, capability_revision: capabilityRevision, revision: 1, source_revision: 1,
      ...configuration, enabled: false, blocked_reason: "paused", deleted_at: null, created_at: timestamp, updated_at: timestamp,
      schedule_cursor_at: timestamp, last_occurrence_key: null, last_run_at: null, next_run_at: null,
    };
    draft.protectedAutomationJobs.push(row); return cloneJob(row);
  });
}

export function updateProtectedAutomationJob(id: string, expectedRevision: number, updates: Partial<ProtectedAutomationJobUpdateFields>, now = Date.now()): ProtectedAutomationJobRow {
  stableId(id, "job id"); positiveRevision(expectedRevision, "expected revision");
  if (!updates || typeof updates !== "object" || Array.isArray(updates)) throw new WorkspaceStoreError("Protected automation updates must be an object");
  exactKeys(updates, JOB_UPDATE_KEYS, "Protected automation updates", false);
  if (Object.keys(updates).length === 0) throw new WorkspaceStoreError("Protected automation update is empty");
  const timestamp = finiteTimestamp(now, "update time")!;
  return commitStoreMutation((draft) => {
    const row = draft.protectedAutomationJobs.find((candidate) => candidate.id === id);
    if (!row) throw new WorkspaceStoreError("Protected automation job not found", 404);
    if (row.revision !== expectedRevision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
    if (row.deleted_at !== null) throw new WorkspaceStoreError("Protected automation job is tombstoned", 409);
    requireCurrentPair(draft, row.project_id, row.agent_profile_id, row.capability_revision);
    const candidate = validateJobConfiguration({ ...row, ...updates });
    const nextSourceRevision = nextRevision(row.source_revision); const nextOverallRevision = nextRevision(row.revision);
    const snapshot = verifyProtectedAutomationSnapshot({ projectId: row.project_id, agentProfileId: row.agent_profile_id, jobId: row.id,
      revision: nextSourceRevision, expectedManifestSha256: candidate.source_manifest_sha256 });
    if (snapshot.entrypoint !== candidate.entrypoint) throw new WorkspaceStoreError("Protected automation snapshot entrypoint does not match the job", 409);
    Object.assign(row, candidate); row.source_revision = nextSourceRevision; row.revision = nextOverallRevision;
    row.enabled = false; row.blocked_reason = "paused"; row.updated_at = Math.max(timestamp, row.updated_at, row.created_at);
    row.schedule_cursor_at = row.updated_at; row.last_occurrence_key = null; row.next_run_at = null;
    cancelQueuedDraft(draft, row.id, row.updated_at, "job_updated");
    return cloneJob(row);
  });
}

export function transitionProtectedAutomationJobLifecycle(id: string, expectedRevision: number, enabling: boolean, now = Date.now()): ProtectedAutomationJobRow {
  stableId(id, "job id"); positiveRevision(expectedRevision, "expected revision");
  if (typeof enabling !== "boolean") throw new WorkspaceStoreError("Protected automation lifecycle value is invalid");
  const timestamp = finiteTimestamp(now, "lifecycle time")!;
  return commitStoreMutation((draft) => {
    const row = draft.protectedAutomationJobs.find((candidate) => candidate.id === id);
    if (!row) throw new WorkspaceStoreError("Protected automation job not found", 404);
    if (row.revision !== expectedRevision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
    if (row.deleted_at !== null) throw new WorkspaceStoreError("Protected automation job is tombstoned", 409);
    if (enabling) requireCurrentPair(draft, row.project_id, row.agent_profile_id, row.capability_revision);
    row.revision = nextRevision(row.revision); row.enabled = enabling; row.blocked_reason = enabling ? null : "paused";
    row.updated_at = Math.max(timestamp, row.updated_at, row.created_at); row.schedule_cursor_at = row.updated_at;
    row.last_occurrence_key = null; row.next_run_at = null;
    if (!enabling) cancelQueuedDraft(draft, row.id, row.updated_at, "job_paused");
    return cloneJob(row);
  });
}

export function rebindProtectedAutomationJob(
  id: string,
  expectedRevision: number,
  currentCapabilityRevision: number,
  now = Date.now(),
): ProtectedAutomationJobRow {
  stableId(id, "job id"); positiveRevision(expectedRevision, "expected revision");
  positiveRevision(currentCapabilityRevision, "current capability revision");
  const timestamp = finiteTimestamp(now, "rebind time")!;
  return commitStoreMutation((draft) => {
    const row = draft.protectedAutomationJobs.find((candidate) => candidate.id === id);
    if (!row) throw new WorkspaceStoreError("Protected automation job not found", 404);
    if (row.revision !== expectedRevision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
    if (row.deleted_at !== null) throw new WorkspaceStoreError("Protected automation job is tombstoned", 409);
    requireCurrentPair(draft, row.project_id, row.agent_profile_id, currentCapabilityRevision);
    if (currentCapabilityRevision === row.capability_revision && row.blocked_reason === "paused") {
      throw new WorkspaceStoreError("Protected automation job already uses current derived authority", 409);
    }
    row.revision = nextRevision(row.revision);
    row.capability_revision = currentCapabilityRevision;
    row.enabled = false;
    row.blocked_reason = "paused";
    row.updated_at = Math.max(timestamp, row.updated_at, row.created_at);
    row.schedule_cursor_at = row.updated_at;
    row.last_occurrence_key = null;
    row.next_run_at = null;
    cancelQueuedDraft(draft, row.id, row.updated_at, "job_rebound");
    return cloneJob(row);
  });
}

export function tombstoneProtectedAutomationJob(id: string, expectedRevision: number, now = Date.now()): ProtectedAutomationJobRow {
  stableId(id, "job id"); positiveRevision(expectedRevision, "expected revision"); const timestamp = finiteTimestamp(now, "deletion time")!;
  return commitStoreMutation((draft) => {
    const row = draft.protectedAutomationJobs.find((candidate) => candidate.id === id);
    if (!row) throw new WorkspaceStoreError("Protected automation job not found", 404);
    if (row.revision !== expectedRevision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
    if (row.deleted_at !== null) throw new WorkspaceStoreError("Protected automation job is already tombstoned", 409);
    row.revision = nextRevision(row.revision); row.enabled = false; row.blocked_reason = "tombstoned";
    row.deleted_at = Math.max(timestamp, row.updated_at, row.created_at); row.updated_at = row.deleted_at; row.next_run_at = null;
    cancelQueuedDraft(draft, row.id, row.updated_at, "job_tombstoned"); return cloneJob(row);
  });
}

function createRunDraft(draft: StoreData, job: ProtectedAutomationJobRow, values: {
  trigger: ProtectedAutomationTrigger; scheduledFor: number | null; occurrenceKey: string | null; startedAt: number;
  status: ProtectedAutomationRunStatus; outcomeCode: string | null; finishedAt: number | null; exitCode: number | null; id?: string;
}, retired: ProtectedAutomationRunStorageIdentity[]): ProtectedAutomationRunRow {
  validateScheduleAttribution(values.trigger, values.scheduledFor, values.occurrenceKey, values.startedAt);
  if (values.occurrenceKey !== null && draft.protectedAutomationRuns.some((run) => run.job_id === job.id && run.occurrence_key === values.occurrenceKey)) {
    throw new WorkspaceStoreError("Protected automation occurrence was already claimed", 409);
  }
  retired.push(...pruneRunsDraft(draft, job.id));
  const id = values.id === undefined ? randomUUID() : stableId(values.id, "run id");
  if (draft.protectedAutomationRuns.some((run) => run.id === id)) throw new WorkspaceStoreError("Protected automation run ID already exists", 409);
  const row: ProtectedAutomationRunRow = {
    id, job_id: job.id, project_id: job.project_id, agent_profile_id: job.agent_profile_id, job_revision: job.revision,
    capability_revision: job.capability_revision, trigger: values.trigger, scheduled_for: values.scheduledFor, occurrence_key: values.occurrenceKey,
    started_at: values.startedAt, finished_at: values.finishedAt, status: values.status, outcome_code: values.outcomeCode, exit_code: values.exitCode,
  };
  draft.protectedAutomationRuns.push(row);
  job.last_run_at = job.last_run_at === null ? row.started_at : Math.max(job.last_run_at, row.started_at);
  if (row.scheduled_for !== null && row.scheduled_for >= job.schedule_cursor_at) {
    job.schedule_cursor_at = row.scheduled_for;
    job.last_occurrence_key = row.occurrence_key;
  }
  job.updated_at = Math.max(job.updated_at, row.finished_at ?? row.started_at);
  return row;
}

export function enqueueProtectedAutomationRun(input: { jobId: string; expectedRevision: number; trigger: ProtectedAutomationTrigger;
  scheduledFor: number | null; occurrenceKey: string | null; now?: number }): ProtectedAutomationRunRow {
  if (input.trigger !== "manual" && input.trigger !== "schedule") throw new WorkspaceStoreError("Invalid protected automation run trigger");
  positiveRevision(input.expectedRevision, "expected revision");
  const now = finiteTimestamp(input.now ?? Date.now(), "enqueue time")!;
  const retired: ProtectedAutomationRunStorageIdentity[] = [];
  const committed = commitStoreMutation((draft) => {
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === input.jobId);
    if (!job) throw new WorkspaceStoreError("Protected automation job not found", 404);
    if (job.revision !== input.expectedRevision || job.deleted_at !== null) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
    if (!job.enabled) throw new WorkspaceStoreError("Protected automation job is paused", 409);
    requireCurrentPair(draft, job.project_id, job.agent_profile_id, job.capability_revision);
    const active = draft.protectedAutomationRuns.some((run) => run.job_id === job.id && (run.status === "queued" || run.status === "running"));
    return cloneRun(createRunDraft(draft, job, { trigger: input.trigger, scheduledFor: input.scheduledFor, occurrenceKey: input.occurrenceKey,
      startedAt: now, status: active ? "skipped" : "queued", outcomeCode: active ? "overlap_skipped" : null,
      finishedAt: active ? now : null, exitCode: null }, retired));
  });
  retireCommittedRuns(retired);
  return committed;
}

export function advanceProtectedAutomationSkippedCursor(
  jobId: string,
  expectedRevision: number,
  scheduledFor: number,
  key: string,
  now = Date.now(),
): ProtectedAutomationJobRow {
  const timestamp = finiteTimestamp(now, "skip cursor time")!;
  const occurrence = occurrenceKey(key, false)!;
  validateScheduleAttribution("schedule", scheduledFor, occurrence, timestamp);
  return commitStoreMutation((draft) => {
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.revision !== expectedRevision || !job.enabled || job.deleted_at !== null) {
      throw new WorkspaceStoreError("Protected automation lifecycle is not current", 409);
    }
    requireCurrentPair(draft, job.project_id, job.agent_profile_id, job.capability_revision);
    job.schedule_cursor_at = Math.max(job.schedule_cursor_at, scheduledFor);
    job.updated_at = Math.max(job.updated_at, timestamp);
    return cloneJob(job);
  });
}

export function recordProtectedAutomationScheduledSkip(jobId: string, expectedRevision: number, scheduledFor: number, key: string,
  outcomeCode: "missed_run_skipped" | "overlap_skipped", now = Date.now()): ProtectedAutomationRunRow {
  const retired: ProtectedAutomationRunStorageIdentity[] = [];
  const committed = commitStoreMutation((draft) => {
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.revision !== expectedRevision || !job.enabled || job.deleted_at !== null) throw new WorkspaceStoreError("Protected automation lifecycle is not current", 409);
    requireCurrentPair(draft, job.project_id, job.agent_profile_id, job.capability_revision);
    return cloneRun(createRunDraft(draft, job, { trigger: "schedule", scheduledFor, occurrenceKey: key, startedAt: now,
      status: "skipped", outcomeCode, finishedAt: now, exitCode: null }, retired));
  });
  retireCommittedRuns(retired);
  return committed;
}

export function claimProtectedAutomationRun(runId: string, now = Date.now()): ProtectedAutomationRunRow | null {
  return commitStoreMutation((draft) => {
    const run = draft.protectedAutomationRuns.find((candidate) => candidate.id === runId);
    if (!run || run.status !== "queued") return null;
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === run.job_id);
    if (!job || !job.enabled || job.deleted_at !== null || job.revision !== run.job_revision || job.capability_revision !== run.capability_revision) {
      run.status = "denied"; run.finished_at = Math.max(now, run.started_at); run.outcome_code = "stale_job_revision";
      if (job) job.updated_at = Math.max(job.updated_at, run.finished_at); return cloneRun(run);
    }
    try { requireCurrentPair(draft, job.project_id, job.agent_profile_id, job.capability_revision); } catch {
      run.status = "denied"; run.finished_at = Math.max(now, run.started_at); run.outcome_code = "authority_unavailable";
      job.updated_at = Math.max(job.updated_at, run.finished_at); return cloneRun(run);
    }
    run.status = "running"; return cloneRun(run);
  });
}

export function finishProtectedAutomationRun(runId: string,
  status: Extract<ProtectedAutomationRunStatus, "completed" | "failed" | "cancelled" | "needs_user" | "interrupted" | "denied">,
  outcomeCode: string, exitCode: number | null, now = Date.now()): ProtectedAutomationRunRow | null {
  boundedText(outcomeCode, "outcome_code", MAX_PROTECTED_AUTOMATION_OUTCOME_CODE_BYTES);
  if (!(exitCode === null || (Number.isSafeInteger(exitCode) && exitCode >= 0 && exitCode <= 255))) {
    throw new WorkspaceStoreError("Protected automation exit_code is invalid");
  }
  return commitStoreMutation((draft) => {
    const run = draft.protectedAutomationRuns.find((candidate) => candidate.id === runId);
    if (!run || TERMINAL.has(run.status)) return run ? cloneRun(run) : null;
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === run.job_id);
    let finalStatus = status;
    let finalOutcome = outcomeCode;
    let finalExitCode = exitCode;
    if (status !== "interrupted") {
      let authorized = !!job && job.enabled && job.deleted_at === null && job.revision === run.job_revision
        && job.capability_revision === run.capability_revision;
      if (authorized && job) {
        try { requireCurrentPair(draft, job.project_id, job.agent_profile_id, job.capability_revision); } catch { authorized = false; }
      }
      if (!authorized) { finalStatus = "denied"; finalOutcome = "authority_revoked"; finalExitCode = null; }
    }
    run.status = finalStatus; run.finished_at = Math.max(now, run.started_at); run.outcome_code = finalOutcome; run.exit_code = finalExitCode;
    if (job) job.updated_at = Math.max(job.updated_at, run.finished_at); return cloneRun(run);
  });
}

export function requestProtectedAutomationRunCancellation(runId: string, now = Date.now()): ProtectedAutomationRunRow | null {
  return commitStoreMutation((draft) => {
    const run = draft.protectedAutomationRuns.find((candidate) => candidate.id === runId);
    if (!run || TERMINAL.has(run.status)) return run ? cloneRun(run) : null;
    const prior = run.status;
    run.status = "cancelled";
    run.finished_at = Math.max(now, run.started_at);
    run.outcome_code = prior === "queued" ? "cancelled_before_start" : "cancelled";
    run.exit_code = null;
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === run.job_id);
    if (job) job.updated_at = Math.max(job.updated_at, run.finished_at);
    return cloneRun(run);
  });
}

export function recoverProtectedAutomationRuns(now = Date.now()): { queued: ProtectedAutomationRunRow[]; interrupted: number } {
  return commitStoreMutation((draft) => {
    let interrupted = 0;
    for (const run of draft.protectedAutomationRuns) if (run.status === "running") {
      run.status = "interrupted"; run.finished_at = Math.max(now, run.started_at); run.outcome_code = "service_restart"; run.exit_code = null;
      const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === run.job_id);
      if (job) job.updated_at = Math.max(job.updated_at, run.finished_at); interrupted += 1;
    }
    return { queued: draft.protectedAutomationRuns.filter((run) => run.status === "queued").map(cloneRun), interrupted };
  });
}

export function updateProtectedAutomationScheduleMetadata(jobId: string, expectedRevision: number,
  values: Partial<Pick<ProtectedAutomationJobRow, "schedule_cursor_at" | "last_occurrence_key" | "last_run_at" | "next_run_at">>): ProtectedAutomationJobRow {
  return commitStoreMutation((draft) => {
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === jobId);
    if (!job) throw new WorkspaceStoreError("Protected automation job not found", 404);
    if (job.revision !== expectedRevision) throw new WorkspaceStoreError("Protected automation job revision conflict", 409);
    if (values.schedule_cursor_at !== undefined) job.schedule_cursor_at = values.schedule_cursor_at;
    if (values.last_occurrence_key !== undefined) job.last_occurrence_key = values.last_occurrence_key;
    if (values.last_run_at !== undefined) job.last_run_at = values.last_run_at;
    if (values.next_run_at !== undefined) job.next_run_at = job.enabled ? values.next_run_at : null;
    return cloneJob(job);
  });
}

/** Strict compatibility primitive for synthetic callers; production uses enqueue/claim/finish. */
export function createProtectedAutomationRun(input: ProtectedAutomationRunCreateInput): ProtectedAutomationRunRow {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new WorkspaceStoreError("Protected automation run input must be an object");
  exactKeys(input, RUN_CREATE_KEYS, "Protected automation run input", false);
  for (const key of RUN_CREATE_KEYS) if (key !== "id" && !Object.hasOwn(input, key)) throw new WorkspaceStoreError("Protected automation run input is missing required fields");
  if (input.trigger !== "manual" && input.trigger !== "schedule") throw new WorkspaceStoreError("Invalid protected automation run trigger");
  if (!["queued", "running", "completed", "failed", "skipped", "cancelled", "needs_user", "interrupted", "denied"].includes(input.status)) {
    throw new WorkspaceStoreError("Invalid protected automation run status");
  }
  const startedAt = finiteTimestamp(input.started_at, "started_at")!; const scheduledFor = finiteTimestamp(input.scheduled_for, "scheduled_for", true);
  const key = occurrenceKey(input.occurrence_key, true); validateScheduleAttribution(input.trigger, scheduledFor, key, startedAt);
  const finishedAt = finiteTimestamp(input.finished_at, "finished_at", true);
  const terminal = TERMINAL.has(input.status);
  if (terminal ? finishedAt === null || finishedAt < startedAt || input.outcome_code === null : finishedAt !== null || input.outcome_code !== null) {
    throw new WorkspaceStoreError("Protected automation run terminal state is inconsistent");
  }
  if (input.outcome_code !== null) boundedText(input.outcome_code, "outcome_code", MAX_PROTECTED_AUTOMATION_OUTCOME_CODE_BYTES);
  if (!(input.exit_code === null || (Number.isSafeInteger(input.exit_code) && input.exit_code >= 0 && input.exit_code <= 255))) {
    throw new WorkspaceStoreError("Protected automation exit_code is invalid");
  }
  const retired: ProtectedAutomationRunStorageIdentity[] = [];
  const committed = commitStoreMutation((draft) => {
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === input.job_id);
    if (!job) throw new WorkspaceStoreError("Protected automation job not found", 404);
    if (input.project_id !== job.project_id || input.agent_profile_id !== job.agent_profile_id || input.job_revision !== job.revision
      || input.capability_revision !== job.capability_revision) throw new WorkspaceStoreError("Protected automation run attribution does not match the exact current job revision", 409);
    return cloneRun(createRunDraft(draft, job, { trigger: input.trigger, scheduledFor, occurrenceKey: key, startedAt,
      status: input.status, outcomeCode: input.outcome_code, finishedAt, exitCode: input.exit_code, id: input.id }, retired));
  });
  retireCommittedRuns(retired);
  return committed;
}

export function getProtectedAutomationProjectReferences(projectId: string): ProtectedAutomationReferences {
  stableId(projectId, "project_id"); const store = getStore();
  return { jobs: store.protectedAutomationJobs.filter((row) => row.project_id === projectId).map((row) => row.id).sort(),
    runs: store.protectedAutomationRuns.filter((row) => row.project_id === projectId).map((row) => row.id).sort() };
}
export function getProtectedAutomationProfileReferences(profileId: string): ProtectedAutomationReferences {
  stableId(profileId, "agent_profile_id"); const store = getStore();
  return { jobs: store.protectedAutomationJobs.filter((row) => row.agent_profile_id === profileId).map((row) => row.id).sort(),
    runs: store.protectedAutomationRuns.filter((row) => row.agent_profile_id === profileId).map((row) => row.id).sort() };
}

/**
 * Final durable step of PIN-confirmed purge. Filesystem artifacts must already
 * be staged privately by the production coordinator. Project files are never
 * addressed by this primitive.
 */
export function purgeTombstonedProtectedAutomationJob(input: {
  jobId: string;
  projectId: string;
  agentProfileId: string;
  expectedRevision: number;
}): { purgedJobId: string; purgedRunIds: string[] } {
  const jobId = stableId(input.jobId, "job id");
  const projectId = stableId(input.projectId, "project_id");
  const agentProfileId = stableId(input.agentProfileId, "agent_profile_id");
  positiveRevision(input.expectedRevision, "expected revision");
  return commitStoreMutation((draft) => {
    const job = draft.protectedAutomationJobs.find((candidate) => candidate.id === jobId);
    if (!job || job.project_id !== projectId || job.agent_profile_id !== agentProfileId) {
      throw new WorkspaceStoreError("Protected automation job not found", 404);
    }
    if (job.revision !== input.expectedRevision || job.deleted_at === null || job.enabled) {
      throw new WorkspaceStoreError("Protected automation tombstone revision conflict", 409);
    }
    const runs = draft.protectedAutomationRuns.filter((run) => run.job_id === job.id);
    if (runs.some((run) => run.status === "queued" || run.status === "running")) {
      throw new WorkspaceStoreError("Protected automation job still has an active run", 409);
    }
    const purgedRunIds = runs.map((run) => run.id).sort();
    draft.protectedAutomationRuns = draft.protectedAutomationRuns.filter((run) => run.job_id !== job.id);
    draft.protectedAutomationJobs = draft.protectedAutomationJobs.filter((candidate) => candidate.id !== job.id);
    return { purgedJobId: job.id, purgedRunIds };
  });
}
