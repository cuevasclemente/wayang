import { createPiSession, runPromptAndWait, setCommandGuardMode } from "../pi-bridge.js";
import { authorizeProjectAction, resolveEffectiveSessionConfig } from "../policy.js";
import { createSession, touchSession, updatePiSessionFile } from "../sessions.js";
import { nextCronOccurrence, previousCronOccurrence } from "./cron.js";
import {
  createScheduledRun,
  getScheduledJob,
  hasRunningRun,
  listScheduledJobs,
  markStaleScheduledRunsFailed,
  setJobScheduleMetadata,
  updateScheduledRun,
} from "./store.js";
import type { ScheduledJobRow, ScheduledJobTrigger, ScheduledRunRow } from "./types.js";

const MAX_TIMEOUT_MS = 2_147_000_000; // slightly below signed 32-bit setTimeout cap

export class SchedulerManager {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  start(): void {
    if (this.started) return;
    this.started = true;
    const stale = markStaleScheduledRunsFailed();
    if (stale > 0) console.log(`[scheduler] marked ${stale} stale scheduled runs failed`);
    for (const job of listScheduledJobs()) {
      this.reloadJob(job.id);
    }
    console.log("[scheduler] started");
  }

  stop(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.started = false;
    console.log("[scheduler] stopped");
  }

  reloadJob(jobId: string): void {
    this.clearJob(jobId);
    const job = getScheduledJob(jobId);
    if (!this.started || !job || !job.enabled) {
      if (job) setJobScheduleMetadata(job.id, { next_run_at: null });
      return;
    }
    this.scheduleJob(job);
  }

  triggerRun(jobId: string): ScheduledRunRow {
    const job = getScheduledJob(jobId);
    if (!job) throw new Error("Scheduled job not found");
    return this.beginRun(job, "manual", null);
  }

  private scheduleJob(job: ScheduledJobRow): void {
    const nextRunAt = nextCronOccurrence(job.cron_expr, Date.now());
    setJobScheduleMetadata(job.id, { next_run_at: nextRunAt });
    if (!nextRunAt) {
      console.warn(`[scheduler] no future occurrence for job ${job.id} (${job.name})`);
      return;
    }

    const delay = Math.max(0, nextRunAt - Date.now());
    const timeoutMs = Math.min(delay, MAX_TIMEOUT_MS);
    const timer = setTimeout(() => {
      this.timers.delete(job.id);
      if (delay > MAX_TIMEOUT_MS) {
        const latest = getScheduledJob(job.id);
        if (latest?.enabled) this.scheduleJob(latest);
        return;
      }

      const latest = getScheduledJob(job.id);
      if (latest?.enabled) {
        this.beginRun(latest, "schedule", nextRunAt);
        this.scheduleJob(latest);
      }
    }, timeoutMs);
    this.timers.set(job.id, timer);
  }

  private beginRun(job: ScheduledJobRow, trigger: ScheduledJobTrigger, scheduledFor: number | null): ScheduledRunRow {
    const latest = getScheduledJob(job.id);
    if (!latest) throw new Error("Scheduled job not found");
    if (trigger === "schedule" && !latest.enabled) {
      return createScheduledRun({
        jobId: latest.id,
        trigger,
        scheduledFor,
        status: "skipped",
        errorMessage: "job disabled",
      });
    }

    const authorization = authorizeProjectAction({
      cwd: latest.cwd,
      actor: "scheduled",
      agentProfileId: latest.agent_profile_id,
    });
    if (!authorization.allowed) {
      if (trigger === "manual") throw new Error(authorization.reason ?? "Scheduled project access denied");
      return createScheduledRun({
        jobId: latest.id,
        trigger,
        scheduledFor,
        status: "skipped",
        errorMessage: authorization.reason ?? "scheduled project access denied",
      });
    }

    if (trigger === "schedule" && latest.last_run_at !== null) {
      const previous = previousCronOccurrence(latest.cron_expr, (scheduledFor ?? Date.now()) + 1000);
      if (previous !== null && latest.last_run_at >= previous) {
        return createScheduledRun({
          jobId: latest.id,
          trigger,
          scheduledFor,
          status: "skipped",
          errorMessage: "duplicate scheduled fire skipped",
        });
      }
    }

    if (hasRunningRun(latest.id)) {
      return createScheduledRun({
        jobId: latest.id,
        trigger,
        scheduledFor,
        status: "skipped",
        errorMessage: "previous run is still running",
      });
    }

    const run = createScheduledRun({ jobId: latest.id, trigger, scheduledFor, status: "running" });
    void this.executeRun(latest, run).catch((err) => {
      console.error(`[scheduler] unhandled run failure for ${run.id}:`, err);
      updateScheduledRun(run.id, {
        status: "failed",
        finished_at: Date.now(),
        error_message: err instanceof Error ? err.message : String(err),
      });
    });
    return run;
  }

  private async executeRun(job: ScheduledJobRow, run: ScheduledRunRow): Promise<void> {
    let sessionId: string | null = null;
    let protectRunDetails = false;
    try {
      // Re-fetch after dispatch so edits between timer/manual trigger and the
      // asynchronous executor cannot retain stale authority.
      const latest = getScheduledJob(job.id);
      if (!latest) throw new Error("Scheduled job not found");
      const authorization = authorizeProjectAction({
        cwd: latest.cwd,
        actor: "scheduled",
        agentProfileId: latest.agent_profile_id,
      });
      protectRunDetails = authorization.project?.access_policy.privacy_mode === "protected";
      if (!authorization.allowed || !authorization.project || !authorization.agentProfile) {
        throw new Error(authorization.reason ?? "Scheduled project access denied");
      }
      const effective = resolveEffectiveSessionConfig({
        project: authorization.project,
        agentProfile: authorization.agentProfile,
        explicitProvider: latest.provider,
        explicitModel: latest.model,
        purpose: "scheduled",
      });
      const session = createSession(latest.cwd, {
        title: `[scheduled] ${latest.name}`,
        provider: effective.provider ?? undefined,
        model: effective.model ?? undefined,
        agentProfileId: effective.agent_profile_id,
        scheduledJobId: latest.id,
        scheduledRunId: run.id,
      });
      sessionId = session.id;
      updateScheduledRun(run.id, { session_id: sessionId });
      // This is the final authorization boundary before Pi can read project
      // resources or transcript bytes. permission_mode never participates.
      assertScheduledRuntimeAuthorized(session.cwd, session.agent_profile_id ?? null);
      const handle = await createPiSession(
        session.id,
        session.cwd,
        session.provider,
        session.model,
        session.pi_session_file,
      );
      if (handle.sessionFile) updatePiSessionFile(session.id, handle.sessionFile);
      applyScheduledCommandGuardMode(session.id, latest);

      const result = await runPromptAndWait(session.id, latest.prompt, {
        timeoutMs: latest.timeout_ms,
      });
      touchSession(session.id);

      const finishedAt = Date.now();
      updateScheduledRun(run.id, {
        status: "completed",
        finished_at: finishedAt,
        error_message: null,
        // Protected assistant output stays only in its linked Protected session.
        // The shared scheduler row remains content-free for cross-project views.
        result_summary: scheduledRunResultSummary(protectRunDetails, result.resultSummary),
      });
      setJobScheduleMetadata(latest.id, {
        last_run_at: run.scheduled_for ?? run.started_at,
        next_run_at: nextCronOccurrence(latest.cron_expr, finishedAt),
      });
    } catch (err) {
      updateScheduledRun(run.id, {
        status: "failed",
        finished_at: Date.now(),
        error_message: scheduledRunErrorMessage(protectRunDetails, err),
      });
      if (run.trigger === "schedule") {
        setJobScheduleMetadata(job.id, { last_run_at: run.scheduled_for ?? run.started_at });
      }
    } finally {
      // Keep the live SDK session available so opening the linked session shows
      // the scheduled run transcript. Existing app cleanup releases it on shutdown.
    }
  }

  private clearJob(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer) clearTimeout(timer);
    this.timers.delete(jobId);
  }
}

export function scheduledRunResultSummary(protectedProject: boolean, summary: string | null): string | null {
  return protectedProject ? null : summary;
}

export function scheduledRunErrorMessage(protectedProject: boolean, error: unknown): string {
  if (protectedProject) return "Protected scheduled run failed; inspect the linked Protected session";
  return error instanceof Error ? error.message : String(error);
}

export function assertScheduledRuntimeAuthorized(cwd: string, agentProfileId: string | null): void {
  const decision = authorizeProjectAction({ cwd, actor: "scheduled", agentProfileId });
  if (!decision.allowed) {
    throw new Error(decision.reason ?? "Scheduled project access denied before runtime creation");
  }
}

function applyScheduledCommandGuardMode(sessionId: string, job: ScheduledJobRow): void {
  if (job.command_guard_mode === "default") return;
  const mode = job.command_guard_mode === "off" ? "off" : job.command_guard_mode;
  const state = setCommandGuardMode(sessionId, mode, { announce: false });
  if (!state.available) {
    console.warn(`[scheduler] command guard mode ${job.command_guard_mode} requested for job ${job.id}, but guard is unavailable: ${state.error ?? "unknown error"}`);
  }
}

export const schedulerManager = new SchedulerManager();
