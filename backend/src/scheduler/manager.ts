import { performance } from "node:perf_hooks";
import * as piBridge from "../pi-bridge.js";
import {
  createPiSession,
  destroyPiSession,
  runPromptAndWait,
  setCommandGuardMode,
  type CreatePiSessionRuntimeOptions,
} from "../pi-bridge.js";
import { authorizeProjectAction, resolveEffectiveSessionConfig } from "../policy.js";
import { createSession, touchSession, updatePiSessionFile } from "../sessions.js";
import { nextCronOccurrence, previousCronOccurrence } from "./cron.js";
import {
  createScheduledRun,
  getScheduledJob,
  hasRunningRun,
  listScheduledJobs,
  listScheduledRuns,
  markStaleScheduledRunsFailed,
  setJobScheduleMetadata,
  updateScheduledRun,
} from "./store.js";
import type { ScheduledJobRow, ScheduledJobTrigger, ScheduledRunRow } from "./types.js";

const MAX_TIMEOUT_MS = 2_147_000_000; // slightly below signed 32-bit setTimeout cap

/** Closures own one exact runtime object, never a replaceable session-ID lookup. */
export interface SchedulerRuntimeHandle {
  sessionFile?: string;
  cancel(): Promise<void>;
  cleanup(): Promise<void>;
}

/** Exact private cleanup receipt; fulfillment of wait(), not rejection, proves cleanup. */
export interface SchedulerCleanupRecovery {
  retry(): Promise<void>;
  wait(): Promise<void>;
}

/** Runtime-only seam: metadata persistence and authorization remain real. */
export interface SchedulerRuntimeDependencies {
  createPiSession(
    id: string,
    cwd: string,
    provider?: string | null,
    model?: string | null,
    sessionFile?: string | null,
    options?: CreatePiSessionRuntimeOptions & { signal?: AbortSignal },
  ): Promise<SchedulerRuntimeHandle>;
  runPromptAndWait: typeof runPromptAndWait;
  /** Side-effect-free Error-identity lookup. Undefined is an ordinary failure;
   * null denotes uncertainty without a trusted receipt. Never persist the Error
   * or receipt, and never treat a retry rejection as cleanup confirmation. */
  getCleanupRecovery?(error: unknown): SchedulerCleanupRecovery | null | undefined;
}

const productionRuntime: SchedulerRuntimeDependencies = {
  createPiSession: async (...args) => {
    const handle = await createPiSession(...args);
    return {
      sessionFile: handle.sessionFile,
      cancel: () => handle.session.abort(),
      // Requires the bridge's exact-object guard before any ID-scoped effect.
      cleanup: () => destroyPiSession(handle.id, undefined, handle),
    };
  },
  runPromptAndWait,
  getCleanupRecovery: (error) => {
    if (!hasCleanupUnconfirmedMarker(error)) return undefined;
    // Late namespace access keeps test collection independent of paired bridge
    // exports. Missing APIs deny recovery; a code/message alone proves nothing.
    if (!(error instanceof Error)
      || typeof piBridge.retryPiSessionCleanup !== "function"
      || typeof piBridge.waitForPiSessionCleanup !== "function") return null;
    return {
      retry: () => piBridge.retryPiSessionCleanup(error),
      wait: () => piBridge.waitForPiSessionCleanup(error),
    };
  },
};

function hasCleanupUnconfirmedMarker(error: unknown): boolean {
  try {
    return typeof error === "object" && error !== null
      && "code" in error && error.code === "pi_session_cleanup_unconfirmed";
  } catch {
    // An unreadable marker must not authorize release of potentially live work.
    return true;
  }
}

function stillOwnsRunningRow(run: ScheduledRunRow, sessionId: string | null): boolean {
  // Running rows survive terminal-history pruning. Do not use the default
  // 100-row projection: newer overlap skips must never hide this ownership.
  const current = listScheduledRuns(run.job_id, Number.MAX_SAFE_INTEGER).find((candidate) => candidate.id === run.id);
  return Boolean(current && current.status === "running" && current.finished_at === null
    && current.session_id === sessionId && current.started_at === run.started_at
    && current.trigger === run.trigger && current.scheduled_for === run.scheduled_for);
}

export class SchedulerManager {
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private started = false;

  constructor(private readonly runtime: SchedulerRuntimeDependencies = productionRuntime) {}

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

    // Acceptance precedes persistence and every asynchronous runtime operation.
    const deadline = performance.now() + latest.timeout_ms;
    const run = createScheduledRun({ jobId: latest.id, trigger, scheduledFor, status: "running" });
    void this.executeRun(latest, run, deadline).catch(() => {
      // An unexpected bookkeeping failure is not evidence of runtime cleanup.
      // Keep the overlap guard and never log raw Protected runtime errors here.
      console.error(`[scheduler] run ${run.id} bookkeeping failed; cleanup state unknown`);
      // Do not resurrect or mutate a row after an asynchronous executor has
      // lost ownership. Known cleanup uncertainty is recorded inside it below.
    });
    return run;
  }

  private async executeRun(job: ScheduledJobRow, run: ScheduledRunRow, deadline: number): Promise<void> {
    const controller = new AbortController();
    const timeoutError = new Error(`Scheduled run timed out after ${job.timeout_ms}ms`);
    let handle: SchedulerRuntimeHandle | undefined;
    let ownedSessionId = run.session_id;
    let protectRunDetails = false;
    let expired = false;
    let cancellation: Promise<void> | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const clearDeadline = () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
    };
    const pendingMessage = (cleanupFailed = false) => protectRunDetails
      ? `Protected scheduled run ${expired ? "timed out" : "failed"}; cleanup ${cleanupFailed ? "unconfirmed" : "pending"}; inspect the linked Protected session before retrying`
      : `Scheduled run ${expired ? "timed out" : "failed"}; cleanup ${cleanupFailed ? "unconfirmed" : "pending"}; overlap remains blocked until cleanup completes`;
    const recordPending = (cleanupFailed = false) => {
      try {
        if (!stillOwnsRunningRow(run, ownedSessionId)) return;
        updateScheduledRun(run.id, { error_message: pendingMessage(cleanupFailed) });
      } catch {
        console.error(`[scheduler] could not record cleanup-pending state for run ${run.id}`);
      }
    };
    const cancelRuntime = () => {
      if (!handle || cancellation) return;
      // Invoke the exact runtime's abort synchronously. Rejection is observed,
      // but only later successful cleanup can prove release of ownership.
      try { cancellation = handle.cancel().catch(() => undefined); }
      catch { cancellation = Promise.resolve(); }
    };
    const expire = () => {
      if (!expired) {
        expired = true;
        controller.abort(timeoutError);
        cancelRuntime();
        recordPending();
      } else {
        cancelRuntime();
      }
    };
    const remainingBudget = () => {
      const remaining = deadline - performance.now();
      if (expired || remaining <= 0) {
        expire();
        throw timeoutError;
      }
      return remaining;
    };
    const armDeadline = () => {
      const remaining = deadline - performance.now();
      if (remaining <= 0) expire();
      else timer = setTimeout(armDeadline, Math.min(remaining, MAX_TIMEOUT_MS));
    };
    const cleanupRecovery = (error: unknown): SchedulerCleanupRecovery | null | undefined => {
      try {
        const receipt = this.runtime.getCleanupRecovery?.(error);
        return receipt === undefined && hasCleanupUnconfirmedMarker(error) ? null : receipt;
      } catch {
        return null;
      }
    };
    const awaitConfirmedCleanup = async (receipt: SchedulerCleanupRecovery | null | undefined): Promise<boolean> => {
      // Work already failed. Its acceptance timer must not relabel uncertainty,
      // repeat cancellation, or schedule additional cleanup attempts while waiting.
      clearDeadline();
      recordPending(true);
      if (!receipt) return false;
      try {
        const wait = receipt.wait;
        const retry = receipt.retry;
        if (typeof wait !== "function" || typeof retry !== "function") return false;
        const confirmation = wait.call(receipt);
        if (!(confirmation instanceof Promise)) return false;
        // Subscribe before retrying, including before a synchronous retry failure.
        // Observe rejection immediately; it is uncertainty, never confirmation.
        const confirmed = confirmation.then(() => true, () => false);
        try {
          void Promise.resolve(retry.call(receipt)).catch(() => undefined);
        } catch { /* The retained observer still sees later explicit-owner cleanup. */ }
        return await confirmed;
      } catch {
        // Malformed/accessor-throwing receipts cannot release the overlap guard.
        return false;
      }
    };

    try {
      // Arm before creation and before the first await. Long budgets are chunked
      // at the platform timer cap without restarting the acceptance deadline.
      armDeadline();
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
      remainingBudget();
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
      ownedSessionId = session.id;
      updateScheduledRun(run.id, { session_id: session.id });
      // Keep current policy/generation fences: a deadline never grants authority.
      assertScheduledRuntimeAuthorized(session.cwd, session.agent_profile_id ?? null);
      remainingBudget();
      // A cleanup-unconfirmed rejection retains an exact private bridge receipt.
      // Never race this promise against a timeout and discard its ownership.
      handle = await this.runtime.createPiSession(
        session.id,
        session.cwd,
        session.provider,
        session.model,
        session.pi_session_file,
        { signal: controller.signal },
      );
      remainingBudget();
      if (handle.sessionFile) updatePiSessionFile(session.id, handle.sessionFile);
      applyScheduledCommandGuardMode(session.id, latest);
      const result = await this.runtime.runPromptAndWait(session.id, latest.prompt, {
        // Strictly positive: an expired budget must never disable prompt timeout.
        timeoutMs: remainingBudget(),
      });
      remainingBudget();
      if (!stillOwnsRunningRow(run, ownedSessionId)) return;
      touchSession(session.id);

      const finishedAt = Date.now();
      updateScheduledRun(run.id, {
        status: "completed",
        finished_at: finishedAt,
        error_message: null,
        result_summary: scheduledRunResultSummary(protectRunDetails, result.resultSummary),
      });
      setJobScheduleMetadata(latest.id, {
        last_run_at: run.scheduled_for ?? run.started_at,
        next_run_at: nextCronOccurrence(latest.cron_expr, finishedAt),
      });
    } catch (err) {
      clearDeadline();
      // A rejected creation may reach this continuation before an overdue timer
      // gets an event-loop turn. Still request cancellation at the elapsed budget.
      if (!expired && performance.now() >= deadline) expire();
      const receipt = cleanupRecovery(err);
      let cleanupWasUnconfirmed = receipt !== undefined;
      if (cleanupWasUnconfirmed) {
        if (!await awaitConfirmedCleanup(receipt)) return;
      } else if (expired || performance.now() >= deadline) {
        expire();
        // The original creation/prompt await has now settled. Preserve the
        // existing abort -> prompt settlement -> final bookkeeping ordering.
        await cancellation;
        if (handle) {
          try { await handle.cleanup(); }
          catch (cleanupError) {
            cleanupWasUnconfirmed = true;
            if (!await awaitConfirmedCleanup(cleanupRecovery(cleanupError))) return;
          }
        }
      }
      // Receipt completion may arrive long after a newer authoritative terminal
      // decision. Recheck the exact linked running row immediately before all
      // terminal/run-schedule writes, with no intervening await.
      if (!stillOwnsRunningRow(run, ownedSessionId)) return;
      const failure = expired ? timeoutError : cleanupWasUnconfirmed
        ? new Error("Scheduled run failed; runtime cleanup confirmed")
        : err;
      updateScheduledRun(run.id, {
        status: "failed",
        finished_at: Date.now(),
        error_message: scheduledRunErrorMessage(protectRunDetails, failure),
      });
      if (run.trigger === "schedule") {
        setJobScheduleMetadata(job.id, { last_run_at: run.scheduled_for ?? run.started_at });
      }
    } finally {
      clearDeadline();
      // Successful (and ordinary failed) linked runtimes remain available.
      // A timed-out runtime is retained only until exact cleanup is proven.
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
