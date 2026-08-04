import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { commitWorkspaceCapabilityActivation } from "../workspace-capabilities.js";
import { ProtectedAutomationManager } from "./manager.js";
import { ProtectedAutomationScheduler, protectedAutomationOccurrenceKey } from "./scheduler.js";
import { captureProtectedAutomationSnapshot } from "./snapshots.js";
import {
  claimProtectedAutomationRun,
  createProtectedAutomationJob,
  enqueueProtectedAutomationRun,
  getProtectedAutomationJob,
  listProtectedAutomationRuns,
  transitionProtectedAutomationJobLifecycle,
  updateProtectedAutomationJob,
} from "./store.js";
import type { ProtectedAutomationJobCreateInput, ProtectedAutomationRunnerResult } from "./types.js";

let root = "";
let projectRoot = "";
beforeEach(() => {
  close(); root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-lifecycle-")); projectRoot = path.join(root, "project");
  fs.mkdirSync(path.join(projectRoot, "source"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "source", "main.mjs"), "console.log('synthetic')\n");
  process.env.WAYANG_DATA_DIR = path.join(root, "data"); init();
});
afterEach(() => {
  close(); delete process.env.WAYANG_DATA_DIR;
  const unlock = (target: string): void => { let metadata: fs.Stats; try { metadata = fs.lstatSync(target); } catch { return; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return; try { fs.chmodSync(target, 0o700); } catch { return; }
    for (const name of fs.readdirSync(target)) unlock(path.join(target, name)); };
  unlock(root); fs.rmSync(root, { recursive: true, force: true });
});
function fixture(missed: "skip" | "run_once" = "run_once", cronExpr = "* * * * *") {
  const profile = createAgentProfile({ name: "Lifecycle owner" });
  const project = createProject({ cwd: projectRoot, default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] } });
  const association = commitWorkspaceCapabilityActivation({ capability_id: "wayang.protected-automation.v1",
    project_id: project.id, agent_profile_id: profile.id, operation_digest: "a".repeat(64) });
  const id = randomUUID();
  const snapshot = captureProtectedAutomationSnapshot({ projectRoot, projectId: project.id, agentProfileId: profile.id,
    jobId: id, revision: 1, sourceDirectory: "source", entrypoint: "main.mjs" });
  const input: ProtectedAutomationJobCreateInput = { id, project_id: project.id, agent_profile_id: profile.id,
    capability_revision: association.revision, name: "Synthetic lifecycle job", source_manifest_sha256: snapshot.manifestSha256,
    entrypoint: "main.mjs", argv: [], uses_browser_profile: false, allowed_https_origins: [], cron_expr: cronExpr,
    timezone: "local", timeout_ms: 5_000, overlap_policy: "skip", missed_run_policy: missed };
  const job = createProtectedAutomationJob(input, 100); return { project, profile, association, job };
}
function additionalJob(owner: ReturnType<typeof fixture>, name: string, cronExpr = "* * * * *") {
  const id = randomUUID();
  const snapshot = captureProtectedAutomationSnapshot({ projectRoot, projectId: owner.project.id, agentProfileId: owner.profile.id,
    jobId: id, revision: 1, sourceDirectory: "source", entrypoint: "main.mjs" });
  return createProtectedAutomationJob({ id, project_id: owner.project.id, agent_profile_id: owner.profile.id,
    capability_revision: owner.association.revision, name, source_manifest_sha256: snapshot.manifestSha256,
    entrypoint: "main.mjs", argv: [], uses_browser_profile: false, allowed_https_origins: [], cron_expr: cronExpr,
    timezone: "local", timeout_ms: 5_000, overlap_policy: "skip", missed_run_policy: "run_once" }, 100);
}

const completed = async (): Promise<ProtectedAutomationRunnerResult> => ({ status: "completed", outcomeCode: "completed",
  exitCode: 0, stdout: Buffer.from("synthetic\n"), stderr: Buffer.alloc(0) });

class DeterministicSchedulerClock {
  private current: number;
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; callback: () => void }>();

  constructor(now: number) { this.current = now; }

  readonly now = (): number => this.current;
  readonly setTimer = (callback: () => void, delay: number): ReturnType<typeof setTimeout> => {
    const id = this.nextId++;
    this.timers.set(id, { at: this.current + delay, callback });
    return { id } as unknown as ReturnType<typeof setTimeout>;
  };
  readonly clearTimer = (timer: ReturnType<typeof setTimeout>): void => {
    this.timers.delete((timer as unknown as { id: number }).id);
  };

  pendingCount(): number { return this.timers.size; }
  nextAt(): number | undefined { return this.nextEntry()?.[1].at; }
  nextCallback(): (() => void) | undefined { return this.nextEntry()?.[1].callback; }
  fireNext(now = this.nextAt()): (() => void) | undefined {
    const entry = this.nextEntry();
    if (!entry || now === undefined) return undefined;
    this.timers.delete(entry[0]);
    this.current = now;
    entry[1].callback();
    return entry[1].callback;
  }

  private nextEntry(): [number, { at: number; callback: () => void }] | undefined {
    return [...this.timers.entries()].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
  }
}

test("canonical job revision controls lifecycle while source_revision remains snapshot exact", () => {
  const f = fixture();
  assert.equal(f.job.revision, 1); assert.equal(f.job.source_revision, 1); assert.equal(f.job.enabled, false);
  const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 200);
  assert.equal(enabled.revision, 2); assert.equal(enabled.source_revision, 1); assert.equal(enabled.enabled, true);
  assert.throws(() => transitionProtectedAutomationJobLifecycle(f.job.id, 1, false), /revision conflict/);
  const paused = transitionProtectedAutomationJobLifecycle(f.job.id, 2, false, 300);
  assert.equal(paused.revision, 3); assert.equal(paused.source_revision, 1); assert.equal(paused.enabled, false);
  close(); init(); assert.deepEqual(getProtectedAutomationJob(f.job.id), paused);
});

test("queue, claim, overlap, terminal completion, and restart recovery are one canonical store", async () => {
  const f = fixture(); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 200);
  const queued = enqueueProtectedAutomationRun({ jobId: enabled.id, expectedRevision: enabled.revision, trigger: "manual",
    scheduledFor: null, occurrenceKey: null, now: 300 });
  assert.equal(queued.status, "queued"); assert.equal(getStore().protectedAutomationRuns[0]?.status, "queued");
  const running = claimProtectedAutomationRun(queued.id, 301); assert.equal(running?.status, "running");
  const overlap = enqueueProtectedAutomationRun({ jobId: enabled.id, expectedRevision: enabled.revision, trigger: "manual",
    scheduledFor: null, occurrenceKey: null, now: 302 }); assert.equal(overlap.status, "skipped");
  close(); init();
  const manager = new ProtectedAutomationManager({ runner: completed, now: () => 500 });
  const recovery = manager.start(); assert.equal(recovery.interrupted, 1); assert.equal(recovery.queued, 0);
  assert.ok(listProtectedAutomationRuns(enabled.id).some((run) => run.status === "interrupted"));
  await manager.stop();
});

test("restart dispatches durable queued work", async () => {
  const f = fixture(); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 200);
  enqueueProtectedAutomationRun({ jobId: enabled.id, expectedRevision: enabled.revision, trigger: "manual",
    scheduledFor: null, occurrenceKey: null, now: 300 });
  close(); init();
  const manager = new ProtectedAutomationManager({ runner: completed, now: () => 500 });
  const recovery = manager.start(); assert.equal(recovery.queued, 1); assert.equal(recovery.interrupted, 0);
  await manager.waitForIdle(); assert.equal(listProtectedAutomationRuns(enabled.id)[0]?.status, "completed"); await manager.stop();
});

test("manager dispatch and cancel persist terminal state canonically", async () => {
  const f = fixture(); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 200);
  let aborted = false;
  const manager = new ProtectedAutomationManager({ runner: async (_request, options) => await new Promise((resolve) => {
    const stop = () => { aborted = true; resolve({ status: "cancelled", outcomeCode: "cancelled", exitCode: null,
      stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) }); };
    options.signal?.addEventListener("abort", stop, { once: true }); if (options.signal?.aborted) stop();
  }) });
  manager.start(); const run = manager.runNow(enabled.id, enabled.revision); manager.cancel(run.id); await manager.waitForIdle();
  assert.equal(aborted, true); assert.equal(listProtectedAutomationRuns(enabled.id)[0]?.status, "cancelled"); await manager.stop();
});

test("current on-time occurrence and duplicate timer delivery claim exactly once", async () => {
  const f = fixture(); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 100);
  const clock = new DeterministicSchedulerClock(59_000);
  const manager = new ProtectedAutomationManager({ runner: completed, now: clock.now }); manager.start();
  const scheduler = new ProtectedAutomationScheduler(manager, clock);
  scheduler.start(); assert.equal(clock.pendingCount(), 1); assert.equal(clock.nextAt(), 60_000);
  const delivered = clock.fireNext(60_000); delivered?.(); await manager.waitForIdle();
  const scheduled = listProtectedAutomationRuns(enabled.id).filter((run) => run.occurrence_key === protectedAutomationOccurrenceKey(60_000));
  assert.equal(scheduled.length, 1); assert.equal(getProtectedAutomationJob(enabled.id)?.schedule_cursor_at, 60_000);
  assert.equal(clock.pendingCount(), 1); assert.equal(clock.nextAt(), 120_000);
  scheduler.stop(); await manager.stop();
});

test("delayed run_once wake claims only the latest durable interval occurrence", async () => {
  const f = fixture(); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 100);
  const clock = new DeterministicSchedulerClock(59_000);
  const manager = new ProtectedAutomationManager({ runner: completed, now: clock.now }); manager.start();
  const scheduler = new ProtectedAutomationScheduler(manager, clock); scheduler.start();
  clock.fireNext(300_001); await manager.waitForIdle();
  const runs = listProtectedAutomationRuns(enabled.id);
  assert.equal(runs.length, 1); assert.equal(runs[0]?.scheduled_for, 300_000);
  assert.equal(getProtectedAutomationJob(enabled.id)?.schedule_cursor_at, 300_000);
  assert.equal(clock.nextAt(), 360_000);
  scheduler.stop(); await manager.stop();
});

test("delayed skip wake advances through the latest occurrence without running", async () => {
  const f = fixture("skip"); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 100);
  const clock = new DeterministicSchedulerClock(59_000); let executions = 0;
  const manager = new ProtectedAutomationManager({ runner: async () => { executions += 1; return await completed(); }, now: clock.now });
  manager.start(); const scheduler = new ProtectedAutomationScheduler(manager, clock); scheduler.start();
  clock.fireNext(300_001); await manager.waitForIdle();
  assert.deepEqual(listProtectedAutomationRuns(enabled.id), []); assert.equal(executions, 0);
  assert.equal(getProtectedAutomationJob(enabled.id)?.schedule_cursor_at, 300_000);
  assert.equal(clock.nextAt(), 360_000);
  scheduler.stop(); await manager.stop();
});

test("early wake after wall clock rollback does not claim and re-arms the same occurrence", async () => {
  const f = fixture(); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 100);
  const clock = new DeterministicSchedulerClock(59_000);
  const manager = new ProtectedAutomationManager({ runner: completed, now: clock.now }); manager.start();
  const scheduler = new ProtectedAutomationScheduler(manager, clock); scheduler.start();
  clock.fireNext(30_000); await manager.waitForIdle();
  assert.deepEqual(listProtectedAutomationRuns(enabled.id), []); assert.equal(clock.nextAt(), 60_000);
  clock.fireNext(60_001); await manager.waitForIdle();
  assert.equal(listProtectedAutomationRuns(enabled.id).length, 1);
  assert.equal(listProtectedAutomationRuns(enabled.id)[0]?.scheduled_for, 60_000);
  scheduler.stop(); await manager.stop();
});

test("DST fallback repeated wall minute is claimed once and advances the timestamp cursor", async () => {
  const priorTimezone = process.env.TZ; process.env.TZ = "America/New_York";
  try {
    const f = fixture("run_once", "30 1 * * *");
    const enabledAt = new Date(2026, 10, 1, 0, 0, 0).getTime();
    const first = Date.parse("2026-11-01T01:30:00-04:00");
    const repeated = Date.parse("2026-11-01T01:30:00-05:00");
    const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, enabledAt);
    const clock = new DeterministicSchedulerClock(first - 1);
    const manager = new ProtectedAutomationManager({ runner: completed, now: clock.now }); manager.start();
    const scheduler = new ProtectedAutomationScheduler(manager, clock); scheduler.start();
    assert.equal(clock.nextAt(), first); clock.fireNext(first + 1); await manager.waitForIdle();
    assert.equal(clock.nextAt(), repeated); clock.fireNext(repeated + 1); await manager.waitForIdle();
    const runs = listProtectedAutomationRuns(enabled.id);
    assert.equal(runs.length, 1); assert.equal(runs[0]?.scheduled_for, first);
    assert.equal(runs[0]?.occurrence_key, "2026-11-01T01:30");
    assert.equal(getProtectedAutomationJob(enabled.id)?.schedule_cursor_at, repeated);
    scheduler.stop(); await manager.stop();
  } finally {
    if (priorTimezone === undefined) delete process.env.TZ; else process.env.TZ = priorTimezone;
  }
});

test("DST spring-forward nonexistent wall minute is skipped without a phantom run", async () => {
  const priorTimezone = process.env.TZ; process.env.TZ = "America/New_York";
  try {
    const f = fixture("run_once", "30 2 * * *");
    const enabledAt = new Date(2026, 2, 8, 0, 0, 0).getTime();
    const afterGap = new Date(2026, 2, 8, 3, 30, 1).getTime();
    const nextRealOccurrence = new Date(2026, 2, 9, 2, 30, 0).getTime();
    const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, enabledAt);
    const clock = new DeterministicSchedulerClock(new Date(2026, 2, 8, 1, 59, 59).getTime());
    const manager = new ProtectedAutomationManager({ runner: completed, now: clock.now }); manager.start();
    const scheduler = new ProtectedAutomationScheduler(manager, clock); scheduler.start();
    assert.equal(clock.nextAt(), nextRealOccurrence);
    clock.fireNext(afterGap); await manager.waitForIdle();
    assert.deepEqual(listProtectedAutomationRuns(enabled.id), []);
    assert.equal(getProtectedAutomationJob(enabled.id)?.schedule_cursor_at, enabledAt);
    assert.equal(clock.nextAt(), nextRealOccurrence);
    scheduler.stop(); await manager.stop();
  } finally {
    if (priorTimezone === undefined) delete process.env.TZ; else process.env.TZ = priorTimezone;
  }
});

test("long scheduler delays re-arm at the ceiling and a suspended wake evaluates durable time", async () => {
  const f = fixture("run_once", "0 0 1 1 *");
  const start = new Date(2026, 0, 2, 0, 0, 0).getTime();
  const due = new Date(2027, 0, 1, 0, 0, 0).getTime();
  const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, start);
  const clock = new DeterministicSchedulerClock(start);
  const manager = new ProtectedAutomationManager({ runner: completed, now: clock.now }); manager.start();
  const scheduler = new ProtectedAutomationScheduler(manager, clock); scheduler.start();
  assert.equal(clock.nextAt(), start + 2_147_000_000);
  clock.fireNext(start + 2_147_000_000);
  assert.equal(clock.nextAt(), start + 2 * 2_147_000_000);
  clock.fireNext(due + 1); await manager.waitForIdle();
  const runs = listProtectedAutomationRuns(enabled.id);
  assert.equal(runs.length, 1); assert.equal(runs[0]?.scheduled_for, due);
  assert.equal(getProtectedAutomationJob(enabled.id)?.schedule_cursor_at, due);
  scheduler.stop(); await manager.stop();
});

test("schedule revision drift invalidates the old callback and requires explicit re-enable", async () => {
  const f = fixture("run_once", "*/5 * * * *");
  const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 100);
  const clock = new DeterministicSchedulerClock(1_000);
  const manager = new ProtectedAutomationManager({ runner: completed, now: clock.now }); manager.start();
  const scheduler = new ProtectedAutomationScheduler(manager, clock);
  scheduler.start(); assert.equal(clock.pendingCount(), 1); const staleCallback = clock.nextCallback();
  const snapshot = captureProtectedAutomationSnapshot({ projectRoot, projectId: f.project.id, agentProfileId: f.profile.id,
    jobId: f.job.id, revision: 2, sourceDirectory: "source", entrypoint: "main.mjs" });
  const edited = updateProtectedAutomationJob(f.job.id, enabled.revision, {
    source_manifest_sha256: snapshot.manifestSha256, cron_expr: "*/10 * * * *",
  }, 2_000);
  scheduler.reload(f.job.id); assert.equal(clock.pendingCount(), 0); assert.equal(edited.enabled, false);
  const reenabled = transitionProtectedAutomationJobLifecycle(f.job.id, edited.revision, true, 2_001);
  scheduler.reload(f.job.id); assert.equal(clock.pendingCount(), 1); assert.equal(reenabled.source_revision, 2);
  staleCallback?.(); assert.equal(clock.pendingCount(), 1); assert.deepEqual(listProtectedAutomationRuns(f.job.id), []);
  scheduler.stop(); await manager.stop();
});

test("failed scheduled occurrence is not automatically retried", async () => {
  const f = fixture(); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 100);
  const clock = new DeterministicSchedulerClock(59_000); let executions = 0;
  const manager = new ProtectedAutomationManager({ runner: async () => { executions += 1; return {
    status: "failed", outcomeCode: "synthetic_failure", exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0),
  }; }, now: clock.now });
  manager.start(); const scheduler = new ProtectedAutomationScheduler(manager, clock); scheduler.start();
  const delivered = clock.fireNext(60_001); delivered?.(); await manager.waitForIdle();
  const runs = listProtectedAutomationRuns(enabled.id);
  assert.equal(executions, 1); assert.equal(runs.length, 1); assert.equal(runs[0]?.status, "failed");
  assert.equal(clock.pendingCount(), 1); assert.equal(clock.nextAt(), 120_000);
  scheduler.stop(); await manager.stop();
});

test("one scheduler claim failure does not prevent another due job from being claimed", async () => {
  const f = fixture(); const second = additionalJob(f, "Second claimable job");
  const firstEnabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 200);
  const secondEnabled = transitionProtectedAutomationJobLifecycle(second.id, 1, true, 200);
  const clock = new DeterministicSchedulerClock(180_001);
  const manager = new ProtectedAutomationManager({ runner: completed, now: clock.now }); manager.start();
  const enqueueScheduled = manager.enqueueScheduled.bind(manager);
  manager.enqueueScheduled = (jobId, expectedRevision, scheduledFor, occurrenceKey) => {
    if (jobId === firstEnabled.id) throw new Error("synthetic claim failure");
    return enqueueScheduled(jobId, expectedRevision, scheduledFor, occurrenceKey);
  };
  const scheduler = new ProtectedAutomationScheduler(manager, clock); scheduler.start(); await manager.waitForIdle();
  assert.deepEqual(listProtectedAutomationRuns(firstEnabled.id), []);
  assert.equal(listProtectedAutomationRuns(secondEnabled.id)[0]?.status, "completed");
  scheduler.stop(); await manager.stop();
});

test("one failed job does not prevent another due job from completing", async () => {
  const f = fixture(); const second = additionalJob(f, "Second due job");
  const firstEnabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 200);
  const secondEnabled = transitionProtectedAutomationJobLifecycle(second.id, 1, true, 200);
  const manager = new ProtectedAutomationManager({ runner: async (request) => {
    if (request.job.id === firstEnabled.id) throw new Error("synthetic isolated failure");
    return await completed();
  }, now: () => 180_001 });
  manager.start();
  const scheduler = new ProtectedAutomationScheduler(manager, { now: () => 180_001,
    setTimer: () => ({ synthetic: true }) as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
  scheduler.start(); await manager.waitForIdle();
  assert.equal(listProtectedAutomationRuns(firstEnabled.id)[0]?.status, "failed");
  assert.equal(listProtectedAutomationRuns(secondEnabled.id)[0]?.status, "completed");
  scheduler.stop(); await manager.stop();
});

test("startup skip catch-up advances the durable cursor without execution", async () => {
  const f = fixture("skip"); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 200);
  let executions = 0;
  const manager = new ProtectedAutomationManager({ runner: async () => { executions += 1; return await completed(); }, now: () => 180_001 });
  manager.start();
  const scheduler = new ProtectedAutomationScheduler(manager, { now: () => 180_001,
    setTimer: () => ({ synthetic: true }) as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
  scheduler.start();
  assert.deepEqual(listProtectedAutomationRuns(enabled.id), []);
  assert.equal(getProtectedAutomationJob(enabled.id)?.schedule_cursor_at, 180_000);
  assert.equal(executions, 0);
  scheduler.stop(); await manager.stop();
});

test("startup run_once claims the latest host-local occurrence and survives reload", async () => {
  const f = fixture("run_once"); const enabled = transitionProtectedAutomationJobLifecycle(f.job.id, 1, true, 200);
  const manager = new ProtectedAutomationManager({ runner: completed, now: () => 180_001 }); manager.start();
  const scheduler = new ProtectedAutomationScheduler(manager, { now: () => 180_001,
    setTimer: () => ({ synthetic: true }) as unknown as ReturnType<typeof setTimeout>, clearTimer: () => undefined });
  scheduler.start(); await manager.waitForIdle();
  const runs = listProtectedAutomationRuns(enabled.id); assert.equal(runs.length, 1); assert.equal(runs[0]?.scheduled_for, 180_000);
  assert.equal(runs[0]?.status, "completed"); assert.equal(getProtectedAutomationJob(enabled.id)?.schedule_cursor_at, 180_000);
  scheduler.stop(); await manager.stop(); close(); init(); assert.equal(listProtectedAutomationRuns(enabled.id)[0]?.status, "completed");
});
