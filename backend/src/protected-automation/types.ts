export const PROTECTED_AUTOMATION_CAPABILITY_ID = "wayang.protected-automation.v1" as const;

export const MAX_PROTECTED_AUTOMATION_JOBS = 4_096;
export const DEFAULT_PROTECTED_AUTOMATION_JOB_LIST_LIMIT = 50;
export const MAX_PROTECTED_AUTOMATION_JOB_LIST_LIMIT = 50;
export const MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB = 500;
export const MAX_PROTECTED_AUTOMATION_SNAPSHOT_REVISIONS_PER_JOB = 32;
export const MAX_PROTECTED_AUTOMATION_SNAPSHOT_BYTES_PER_PROJECT_AGENT = 64 * 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_SNAPSHOT_BYTES_GLOBAL = 256 * 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_NAME_BYTES = 256;
export const MAX_PROTECTED_AUTOMATION_ENTRYPOINT_BYTES = 512;
export const MAX_PROTECTED_AUTOMATION_ARGV_ITEMS = 64;
export const MAX_PROTECTED_AUTOMATION_ARG_BYTES = 4_096;
export const MAX_PROTECTED_AUTOMATION_ARGV_BYTES = 16 * 1_024;
export const MAX_PROTECTED_AUTOMATION_HTTPS_ORIGINS = 32;
export const MAX_PROTECTED_AUTOMATION_ORIGIN_BYTES = 2_048;
export const MAX_PROTECTED_AUTOMATION_CRON_BYTES = 256;
export const MIN_PROTECTED_AUTOMATION_TIMEOUT_MS = 1_000;
export const MAX_PROTECTED_AUTOMATION_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
export const MAX_PROTECTED_AUTOMATION_OUTCOME_CODE_BYTES = 128;
export const MAX_PROTECTED_AUTOMATION_STDOUT_BYTES = 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_STDERR_BYTES = 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_STATE_FILES = 256;
export const MAX_PROTECTED_AUTOMATION_STATE_BYTES = 16 * 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_PER_JOB = 64 * 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_PER_PAIR = 128 * 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_GLOBAL = 512 * 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_INCOMING_FILES = 32;
export const MAX_PROTECTED_AUTOMATION_INCOMING_BYTES = 64 * 1024 * 1024;
export const MAX_PROTECTED_AUTOMATION_BROWSER_FRAME_BYTES = 16 * 1024;
export const PROTECTED_AUTOMATION_TERM_GRACE_MS = 1_000;
/** Legacy Milestone-1 terminal outcomes retained for compatibility tests. */
export const PROTECTED_AUTOMATION_INERT_RUN_STATUSES = ["skipped", "denied"] as const;

export type ProtectedAutomationTrigger = "schedule" | "manual";
export type ProtectedAutomationInertRunStatus = typeof PROTECTED_AUTOMATION_INERT_RUN_STATUSES[number];
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

export interface ProtectedAutomationJobRow {
  id: string;
  project_id: string;
  agent_profile_id: string;
  capability_revision: number;
  /** Overall compare-and-set revision for configuration and lifecycle controls. */
  revision: number;
  /** Immutable snapshot revision; advances only when source/configuration is captured. */
  source_revision: number;
  name: string;
  source_manifest_sha256: string;
  entrypoint: string;
  argv: string[];
  uses_browser_profile: boolean;
  allowed_https_origins: string[];
  cron_expr: string;
  timezone: "local";
  timeout_ms: number;
  overlap_policy: "skip";
  missed_run_policy: "skip" | "run_once";
  enabled: boolean;
  blocked_reason: string | null;
  deleted_at: number | null;
  created_at: number;
  updated_at: number;
  schedule_cursor_at: number;
  last_occurrence_key: string | null;
  last_run_at: number | null;
  next_run_at: number | null;
}

export interface ProtectedAutomationRunRow {
  id: string;
  job_id: string;
  project_id: string;
  agent_profile_id: string;
  job_revision: number;
  capability_revision: number;
  trigger: ProtectedAutomationTrigger;
  scheduled_for: number | null;
  occurrence_key: string | null;
  started_at: number;
  finished_at: number | null;
  status: ProtectedAutomationRunStatus;
  outcome_code: string | null;
  exit_code: number | null;
}

export interface ProtectedAutomationJobCreateInput {
  /** Backend-only snapshot/capture binding; agent tool schemas must not expose this field. */
  id?: string;
  project_id: string;
  agent_profile_id: string;
  capability_revision: number;
  name: string;
  source_manifest_sha256: string;
  entrypoint: string;
  argv: string[];
  uses_browser_profile: boolean;
  allowed_https_origins: string[];
  cron_expr: string;
  timezone: "local";
  timeout_ms: number;
  overlap_policy: "skip";
  missed_run_policy: "skip" | "run_once";
}

export type ProtectedAutomationJobUpdateFields = Pick<ProtectedAutomationJobRow,
  | "name"
  | "source_manifest_sha256"
  | "entrypoint"
  | "argv"
  | "uses_browser_profile"
  | "allowed_https_origins"
  | "cron_expr"
  | "timezone"
  | "timeout_ms"
  | "overlap_policy"
  | "missed_run_policy"
>;

export interface ProtectedAutomationRunCreateInput extends Omit<ProtectedAutomationRunRow, "id"> {
  id?: string;
}

export interface ProtectedAutomationRunnerJob {
  job: ProtectedAutomationJobRow;
  run: ProtectedAutomationRunRow;
  /** Intentional direct writable mount of the whole reviewed Protected project at /workspace. */
  projectRoot: string;
}

export interface ProtectedAutomationRunnerResult {
  status: "completed" | "failed" | "cancelled" | "needs_user";
  outcomeCode: string;
  exitCode: number | null;
  stdout: Buffer;
  stderr: Buffer;
}
