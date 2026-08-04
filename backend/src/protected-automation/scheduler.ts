import { nextCronOccurrence, previousCronOccurrence } from "../scheduler/cron.js";
import { protectedAutomationJobAuthorityIsCurrent } from "./authority.js";
import { ProtectedAutomationManager } from "./manager.js";
import {
  advanceProtectedAutomationSkippedCursor,
  getProtectedAutomationJob,
  listProtectedAutomationJobs,
  updateProtectedAutomationScheduleMetadata,
} from "./store.js";
import type { ProtectedAutomationJobRow } from "./types.js";

const MAX_TIMER_MS = 2_147_000_000;

export interface ProtectedAutomationSchedulerOptions {
  now?: () => number;
  setTimer?: (callback: () => void, delay: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

export function protectedAutomationOccurrenceKey(timestamp: number): string {
  const date = new Date(timestamp);
  const pad = (value: number, length = 2) => String(value).padStart(length, "0");
  return `${pad(date.getFullYear(), 4)}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
    + `T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

interface ArmedProtectedAutomationTimer {
  handle?: ReturnType<typeof setTimeout>;
  revision: number;
}

/** Host-local cron cursor with one bounded timer per enabled job. */
export class ProtectedAutomationScheduler {
  private readonly timers = new Map<string, ArmedProtectedAutomationTimer>();
  private readonly now: () => number;
  private readonly setTimer: NonNullable<ProtectedAutomationSchedulerOptions["setTimer"]>;
  private readonly clearTimer: NonNullable<ProtectedAutomationSchedulerOptions["clearTimer"]>;
  private started = false;

  constructor(
    private readonly manager: ProtectedAutomationManager,
    options: ProtectedAutomationSchedulerOptions = {},
  ) {
    this.now = options.now ?? Date.now;
    this.setTimer = options.setTimer ?? ((callback, delay) => setTimeout(callback, delay));
    this.clearTimer = options.clearTimer ?? clearTimeout;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
    for (const job of listProtectedAutomationJobs()) {
      if (!job.enabled || job.deleted_at !== null) continue;
      try {
        this.catchUpAndSchedule(job);
      } catch {
        // One corrupt or concurrently changed job must not prevent other jobs
        // from being evaluated. Lifecycle and occurrence mutations fail closed.
      }
    }
  }

  stop(): void {
    this.started = false;
    for (const timer of this.timers.values()) {
      if (timer.handle !== undefined) this.clearTimer(timer.handle);
    }
    this.timers.clear();
  }

  reload(jobId: string): void {
    const timer = this.timers.get(jobId);
    if (timer?.handle !== undefined) this.clearTimer(timer.handle);
    this.timers.delete(jobId);
    if (!this.started) return;
    const durable = getProtectedAutomationJob(jobId);
    if (!durable || !durable.enabled || durable.deleted_at !== null) return;
    try {
      this.catchUpAndSchedule(durable);
    } catch {
      // Reload is lifecycle-adjacent and remains fail-closed on revision drift.
    }
  }

  /** Evaluate the durable host-local interval (cursor, now], then re-arm. */
  private catchUpAndSchedule(job: ProtectedAutomationJobRow): void {
    if (!protectedAutomationJobAuthorityIsCurrent(job)) {
      updateProtectedAutomationScheduleMetadata(job.id, job.revision, { next_run_at: null });
      return;
    }
    const now = this.now();
    const firstDue = nextCronOccurrence(job.cron_expr, job.schedule_cursor_at);
    if (firstDue !== null && firstDue <= now) {
      const latestDue = previousCronOccurrence(job.cron_expr, now + 1);
      if (latestDue !== null && latestDue >= firstDue) {
        const key = protectedAutomationOccurrenceKey(latestDue);
        try {
          if (job.missed_run_policy === "run_once") {
            this.manager.enqueueScheduled(job.id, job.revision, latestDue, key);
          } else {
            advanceProtectedAutomationSkippedCursor(job.id, job.revision, latestDue, key, now);
          }
        } catch {
          // A repeated host-local wall minute during DST fallback has the same
          // occurrence key. Its first timestamp owns the run; still advance the
          // durable timestamp cursor through the repeated minute.
          const current = getProtectedAutomationJob(job.id);
          if (current?.enabled && current.deleted_at === null && current.revision === job.revision
            && current.last_occurrence_key === key && current.schedule_cursor_at < latestDue
            && protectedAutomationJobAuthorityIsCurrent(current)) {
            try {
              advanceProtectedAutomationSkippedCursor(current.id, current.revision, latestDue, key, now);
            } catch {
              // Concurrent lifecycle changes remain fail-closed.
            }
          }
        }
        const latest = getProtectedAutomationJob(job.id);
        if (!latest) return;
        job = latest;
      }
    }
    this.scheduleNext(job);
  }

  private scheduleNext(job: ProtectedAutomationJobRow): void {
    if (!this.started || !job.enabled || job.deleted_at !== null) return;
    const now = this.now();
    const next = nextCronOccurrence(job.cron_expr, Math.max(now, job.schedule_cursor_at));
    updateProtectedAutomationScheduleMetadata(job.id, job.revision, { next_run_at: next });
    if (next === null) return;

    const armed: ArmedProtectedAutomationTimer = { revision: job.revision };
    this.timers.set(job.id, armed);
    try {
      armed.handle = this.setTimer(() => {
        // Native timers are one-shot, but stale/duplicate synthetic delivery is
        // harmless and cannot remove a newer arm for this job.
        if (this.timers.get(job.id) !== armed) return;
        this.timers.delete(job.id);
        if (!this.started) return;
        const durable = getProtectedAutomationJob(job.id);
        if (!durable || !durable.enabled || durable.deleted_at !== null || durable.revision !== armed.revision) return;
        try {
          this.catchUpAndSchedule(durable);
        } catch {
          // A wake failure is isolated to this job. There is deliberately no
          // automatic retry; lifecycle reload or service restart may re-arm it.
        }
      }, Math.min(Math.max(0, next - now), MAX_TIMER_MS));
    } catch {
      if (this.timers.get(job.id) === armed) this.timers.delete(job.id);
    }
  }
}

let assembledScheduler: ProtectedAutomationScheduler | null = null;

export function setProtectedAutomationScheduler(scheduler: ProtectedAutomationScheduler | null): void {
  assembledScheduler = scheduler;
}

export function getProtectedAutomationScheduler(): ProtectedAutomationScheduler | null {
  return assembledScheduler;
}
