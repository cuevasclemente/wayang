import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile, deleteAgentProfile } from "../agent-profiles.js";
import { close, failNextCommitStoreMutationPersistenceForTests, getStore, init } from "../db.js";
import { ensureProjectForCwd } from "../projects.js";
import {
  createScheduledJob,
  createScheduledRun,
  getScheduledJob,
  hasRunningRun,
  listScheduledJobs,
  listScheduledRuns,
  markStaleScheduledRunsFailed,
  updateScheduledJob,
  updateScheduledRun,
} from "./store.js";

test("legacy scheduled jobs migrate with a null agent profile", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-scheduler-migration-"));
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  const legacyJob = {
    id: "legacy-job",
    name: "Legacy",
    schedule_kind: "cron",
    cron_expr: "0 9 * * *",
    timezone: null,
    prompt: "synthetic prompt",
    cwd: dir,
    provider: null,
    model: null,
    permission_mode: "bypass",
    command_guard_mode: "default",
    timeout_ms: 600_000,
    prompt_timeout_ms: 60_000,
    overlap_policy: "skip",
    missed_run_policy: "skip",
    enabled: false,
    created_at: 1,
    updated_at: 1,
    last_run_at: null,
    next_run_at: null,
  };
  fs.writeFileSync(path.join(dir, "store.json"), JSON.stringify({
    sessions: [], agentTeams: [], teamMembers: [], goals: [], apps: [], appStates: [], appEvents: [],
    scheduledJobs: [legacyJob], scheduledRuns: [], interviews: [],
  }));
  try {
    init();
    assert.equal(getScheduledJob(legacyJob.id)?.agent_profile_id, null);
    close();
    const persisted = JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf-8")) as {
      scheduledJobs: Array<{ agent_profile_id?: string | null }>;
    };
    assert.equal(persisted.scheduledJobs[0]?.agent_profile_id, null);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduled job attribution updates persist the matching capability marker transactionally", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-scheduler-attribution-"));
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    ensureProjectForCwd(dir);
    const profile = createAgentProfile({ name: "Attribution profile" });
    const job = createScheduledJob({
      name: "Attributed job",
      cron_expr: "0 9 * * *",
      prompt: "synthetic prompt",
      cwd: dir,
      agent_profile_id: profile.id,
      enabled: false,
    });
    const storedJob = () => getStore().scheduledJobs.find((candidate) => candidate.id === job.id);
    const persistedJob = () => {
      const persisted = JSON.parse(fs.readFileSync(path.join(dir, "store.json"), "utf-8")) as {
        scheduledJobs: Array<{
          id: string;
          name: string;
          agent_profile_id: string | null;
          legacy_capability_ineligible: boolean;
        }>;
      };
      return persisted.scheduledJobs.find((candidate) => candidate.id === job.id);
    };

    assert.equal(storedJob()?.agent_profile_id, profile.id);
    assert.equal(storedJob()?.legacy_capability_ineligible, false);

    updateScheduledJob(job.id, { name: "Attribution preserved" });
    assert.equal(storedJob()?.agent_profile_id, profile.id);
    assert.equal(storedJob()?.legacy_capability_ineligible, false);

    updateScheduledJob(job.id, { agent_profile_id: null });
    assert.equal(storedJob()?.agent_profile_id, null);
    assert.equal(storedJob()?.legacy_capability_ineligible, true);
    assert.equal(persistedJob()?.agent_profile_id, null);
    assert.equal(persistedJob()?.legacy_capability_ineligible, true);

    updateScheduledJob(job.id, { name: "Null attribution preserved" });
    assert.equal(storedJob()?.agent_profile_id, null);
    assert.equal(storedJob()?.legacy_capability_ineligible, true);

    close();
    init();
    assert.equal(storedJob()?.agent_profile_id, null);
    assert.equal(storedJob()?.legacy_capability_ineligible, true);

    updateScheduledJob(job.id, { agent_profile_id: profile.id });
    assert.equal(storedJob()?.agent_profile_id, profile.id);
    assert.equal(storedJob()?.legacy_capability_ineligible, false);
    assert.equal(persistedJob()?.agent_profile_id, profile.id);
    assert.equal(persistedJob()?.legacy_capability_ineligible, false);

    failNextCommitStoreMutationPersistenceForTests();
    assert.throws(
      () => updateScheduledJob(job.id, { name: "must not publish", agent_profile_id: null }),
      /Synthetic store persistence failure/,
    );
    assert.equal(storedJob()?.name, "Null attribution preserved");
    assert.equal(storedJob()?.agent_profile_id, profile.id);
    assert.equal(storedJob()?.legacy_capability_ineligible, false);
    assert.equal(persistedJob()?.name, "Null attribution preserved");
    assert.equal(persistedJob()?.agent_profile_id, profile.id);
    assert.equal(persistedJob()?.legacy_capability_ineligible, false);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("run retention preserves the overlap guard and bounds terminal history", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-scheduler-retention-"));
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    ensureProjectForCwd(dir);
    const job = createScheduledJob({
      name: "Retention regression",
      cron_expr: "* * * * *",
      prompt: "synthetic prompt",
      cwd: dir,
      enabled: false,
    });
    let now = Date.now();
    t.mock.method(Date, "now", () => now++);
    const active = createScheduledRun({ jobId: job.id, trigger: "manual", scheduledFor: null });
    const skip = () => createScheduledRun({
      jobId: job.id,
      trigger: "manual",
      scheduledFor: null,
      status: "skipped",
      errorMessage: "previous run is still running",
    });
    const firstSkipped = skip();
    for (let i = 1; i < 500; i++) skip();

    // Exactly 500 newer skips used to evict the still-running overlap guard.
    let runs = listScheduledRuns(job.id, 1000);
    assert.equal(runs.find((run) => run.id === active.id)?.status, "running");
    assert.equal(hasRunningRun(job.id), true);
    assert.equal(runs.filter((run) => run.status !== "running").length, 500);
    assert.equal(runs.length, 501);

    const newestSkipped = skip();
    runs = listScheduledRuns(job.id, 1000);
    assert.equal(runs.find((run) => run.id === active.id)?.status, "running");
    assert.equal(hasRunningRun(job.id), true);
    assert.equal(runs.filter((run) => run.status !== "running").length, 500);
    assert.equal(runs.some((run) => run.id === firstSkipped.id), false);
    assert.equal(runs[0].id, newestSkipped.id);

    // Completion releases the guard; the next creation prunes terminal history
    // by start time as before, even when an old run has only just finished.
    assert.equal(updateScheduledRun(active.id, {
      status: "completed",
      finished_at: Date.now(),
    })?.status, "completed");
    assert.equal(hasRunningRun(job.id), false);
    const nextActive = createScheduledRun({ jobId: job.id, trigger: "manual", scheduledFor: null });
    runs = listScheduledRuns(job.id, 1000);
    assert.equal(runs.some((run) => run.id === active.id), false);
    assert.equal(runs.find((run) => run.id === nextActive.id)?.status, "running");
    assert.equal(hasRunningRun(job.id), true);
    assert.equal(runs.filter((run) => run.status !== "running").length, 500);
    assert.equal(runs.length, 501);
  } finally {
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduled job store supports CRUD metadata and run recovery", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-scheduler-test-"));
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    const { project } = ensureProjectForCwd("/tmp");
    const scheduledProfile = createAgentProfile({ name: "Scheduled job profile" });
    const job = createScheduledJob({
      name: "Daily summary",
      cron_expr: "0 9 * * *",
      prompt: "summarize",
      cwd: "/tmp",
      agent_profile_id: scheduledProfile.id,
      command_guard_mode: "off",
      enabled: true,
    });

    assert.equal(listScheduledJobs().length, 1);
    assert.equal(getScheduledJob(job.id)?.name, "Daily summary");
    assert.equal(getScheduledJob(job.id)?.command_guard_mode, "off");
    assert.equal(getScheduledJob(job.id)?.agent_profile_id, scheduledProfile.id);
    assert.ok(getScheduledJob(job.id)?.next_run_at);

    close();
    init();
    assert.equal(getScheduledJob(job.id)?.agent_profile_id, scheduledProfile.id);

    const updated = updateScheduledJob(job.id, { enabled: false, name: "Disabled summary", command_guard_mode: "balanced" });
    assert.equal(updated?.enabled, false);
    assert.equal(updated?.command_guard_mode, "balanced");
    assert.equal(updated?.next_run_at, null);

    const run = createScheduledRun({ jobId: job.id, trigger: "manual", scheduledFor: null });
    assert.equal(hasRunningRun(job.id), true);
    assert.equal(listScheduledRuns(job.id).length, 1);

    updateScheduledRun(run.id, { status: "completed", finished_at: Date.now(), result_summary: "ok" });
    assert.equal(hasRunningRun(job.id), false);

    createScheduledRun({ jobId: job.id, trigger: "schedule", scheduledFor: Date.now() });
    assert.equal(markStaleScheduledRunsFailed("restart"), 1);
    const latest = listScheduledRuns(job.id)[0];
    assert.equal(latest.status, "failed");
    assert.equal(latest.error_message, "restart");

    const legacyCompatible = createScheduledJob({
      name: "Project-default profile",
      cron_expr: "0 10 * * *",
      prompt: "run with the project default",
      cwd: "/tmp",
    });
    assert.equal(legacyCompatible.agent_profile_id, null);

    const custom = createAgentProfile({ name: "Scheduled specialist" });
    assert.equal(updateScheduledJob(legacyCompatible.id, { agent_profile_id: custom.id })?.agent_profile_id, custom.id);
    assert.throws(
      () => updateScheduledJob(legacyCompatible.id, { name: "must not partially apply", agent_profile_id: "missing-profile" }),
      /Agent profile not found/,
    );
    assert.equal(getScheduledJob(legacyCompatible.id)?.name, "Project-default profile");

    deleteAgentProfile(custom.id, project.default_agent_profile_id);
    assert.equal(getScheduledJob(legacyCompatible.id)?.agent_profile_id, project.default_agent_profile_id);
    assert.equal(updateScheduledJob(legacyCompatible.id, { agent_profile_id: null })?.agent_profile_id, null);
  } finally {
    close();
    if (previousDataDir === undefined) {
      delete process.env.WAYANG_DATA_DIR;
    } else {
      process.env.WAYANG_DATA_DIR = previousDataDir;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
