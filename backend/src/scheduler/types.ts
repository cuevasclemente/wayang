export type ScheduledJobScheduleKind = "cron";
export type ScheduledJobStatus = "running" | "completed" | "failed" | "skipped";
export type ScheduledJobTrigger = "schedule" | "manual";
export type ScheduledJobCommandGuardMode = "default" | "off" | "balanced" | "audit" | "strict";

export interface ScheduledJobRow {
  id: string;
  name: string;
  schedule_kind: ScheduledJobScheduleKind;
  cron_expr: string;
  timezone: string | null;
  prompt: string;
  cwd: string;
  provider: string | null;
  model: string | null;
  permission_mode: string;
  command_guard_mode: ScheduledJobCommandGuardMode;
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

export interface ScheduledRunRow {
  id: string;
  job_id: string;
  session_id: string | null;
  trigger: ScheduledJobTrigger;
  scheduled_for: number | null;
  started_at: number;
  finished_at: number | null;
  status: ScheduledJobStatus;
  error_message: string | null;
  result_summary: string | null;
}

export interface ScheduledJobInput {
  name?: string;
  cron_expr?: string;
  prompt?: string;
  cwd?: string;
  provider?: string | null;
  model?: string | null;
  permission_mode?: string;
  command_guard_mode?: ScheduledJobCommandGuardMode;
  timeout_ms?: number;
  prompt_timeout_ms?: number;
  enabled?: boolean;
}

export interface ScheduledJobDetail {
  job: ScheduledJobRow;
  runs: ScheduledRunRow[];
}
