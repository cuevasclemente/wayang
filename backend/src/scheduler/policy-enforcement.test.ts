import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "../agent-profiles.js";
import { close, init } from "../db.js";
import { createProject, updateProject } from "../projects.js";
import { classifySessionPrivacy, listStandardSessions } from "../session-interop.js";
import { createSession } from "../sessions.js";
import {
  assertScheduledRuntimeAuthorized,
  scheduledRunErrorMessage,
  scheduledRunResultSummary,
  SchedulerManager,
} from "./manager.js";
import { createScheduledJob, getScheduledJob, updateScheduledJob } from "./store.js";
import type { ScheduledJobInput, ScheduledJobRow, ScheduledRunRow } from "./types.js";

async function withStore(run: (root: string) => void | Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-scheduler-policy-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = root;
  close();
  try {
    init();
    await run(root);
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function input(cwd: string, overrides: Partial<ScheduledJobInput> = {}): ScheduledJobInput {
  return {
    name: "Synthetic scheduled job",
    cron_expr: "0 9 * * *",
    prompt: "synthetic prompt",
    cwd,
    enabled: false,
    ...overrides,
  };
}

test("protected projects allow scheduled jobs only for an exact allowed profile", async () => {
  await withStore((root) => {
    const cwd = path.join(root, "protected");
    fs.mkdirSync(cwd);
    const allowed = createAgentProfile({ name: "Protected scheduled profile" });
    const denied = createAgentProfile({ name: "Unlisted scheduled profile" });
    createProject({
      cwd,
      default_agent_profile_id: allowed.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [allowed.id] },
    });

    assert.throws(() => createScheduledJob(input(cwd)), /require an explicit agent profile/);
    const job = createScheduledJob(input(cwd, { agent_profile_id: allowed.id }));
    assert.equal(job.agent_profile_id, allowed.id);
    assert.equal(updateScheduledJob(job.id, { name: "Protected scheduled update" })?.name, "Protected scheduled update");
    assert.throws(
      () => createScheduledJob(input(cwd, { agent_profile_id: denied.id })),
      /not allowed for this project/,
    );
    assert.equal(getScheduledJob(job.id)?.name, "Protected scheduled update");
  });
});

test("manual run and timer fire reauthorize the latest protected allowlist", async () => {
  await withStore((root) => {
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const original = createAgentProfile({ name: "Original protected scheduler" });
    const replacement = createAgentProfile({ name: "Replacement protected scheduler" });
    const project = createProject({
      cwd,
      default_agent_profile_id: original.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [original.id] },
    });
    const job = createScheduledJob(input(cwd, { enabled: true, agent_profile_id: original.id }));
    updateProject(project.id, {
      default_agent_profile_id: replacement.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [replacement.id] },
    });

    const manager = new SchedulerManager();
    assert.throws(() => manager.triggerRun(job.id), /not allowed for this project/);

    const internals = manager as unknown as {
      beginRun(job: ScheduledJobRow, trigger: "schedule", scheduledFor: number): ScheduledRunRow;
    };
    const timerRun = internals.beginRun(job, "schedule", Date.now());
    assert.equal(timerRun.status, "skipped");
    assert.match(timerRun.error_message ?? "", /not allowed for this project/);
  });
});

test("scheduled execution reauthorizes a protected project immediately before Pi runtime creation", async () => {
  await withStore((root) => {
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const original = createAgentProfile({ name: "Original protected runtime" });
    const replacement = createAgentProfile({ name: "Replacement protected runtime" });
    const project = createProject({
      cwd,
      default_agent_profile_id: original.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [original.id] },
    });
    assert.doesNotThrow(() => assertScheduledRuntimeAuthorized(cwd, original.id));
    updateProject(project.id, {
      default_agent_profile_id: replacement.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [replacement.id] },
    });
    assert.throws(() => assertScheduledRuntimeAuthorized(cwd, original.id), /not allowed for this project/);
  });
});

test("permission_mode bypass never overrides a denied protected policy decision", async () => {
  await withStore((root) => {
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const original = createAgentProfile({ name: "Protected bypass profile" });
    const replacement = createAgentProfile({ name: "Protected bypass replacement" });
    const project = createProject({
      cwd,
      default_agent_profile_id: original.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [original.id] },
    });
    const job = createScheduledJob(input(cwd, {
      permission_mode: "bypass",
      agent_profile_id: original.id,
    }));
    assert.equal(job.permission_mode, "bypass");
    updateProject(project.id, {
      default_agent_profile_id: replacement.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [replacement.id] },
    });
    assert.throws(() => new SchedulerManager().triggerRun(job.id), /not allowed for this project/);
  });
});

test("protected scheduled output remains content-free and its linked session stays cross-project private", async () => {
  assert.equal(scheduledRunResultSummary(true, "private assistant output"), null);
  assert.equal(scheduledRunResultSummary(false, "standard assistant output"), "standard assistant output");
  assert.equal(
    scheduledRunErrorMessage(true, new Error("private provider response")),
    "Protected scheduled run failed; inspect the linked Protected session",
  );
  assert.equal(scheduledRunErrorMessage(false, new Error("standard provider error")), "standard provider error");

  await withStore((root) => {
    const protectedCwd = path.join(root, "protected-output");
    const standardCwd = path.join(root, "standard-output");
    fs.mkdirSync(protectedCwd);
    fs.mkdirSync(standardCwd);
    const protectedProfile = createAgentProfile({ name: "Protected output profile" });
    createProject({
      cwd: protectedCwd,
      default_agent_profile_id: protectedProfile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [protectedProfile.id] },
    });
    const protectedJob = createScheduledJob(input(protectedCwd, { agent_profile_id: protectedProfile.id }));
    const protectedSession = createSession(protectedCwd, {
      agentProfileId: protectedProfile.id,
      scheduledJobId: protectedJob.id,
      scheduledRunId: "synthetic-protected-run",
    });
    createProject({ cwd: standardCwd });
    const standardSession = createSession(standardCwd);

    assert.equal(classifySessionPrivacy(protectedSession), "protected");
    const visible = listStandardSessions({ limit: 100 }).sessions.map((session) => session.id);
    assert.ok(visible.includes(standardSession.id));
    assert.equal(visible.includes(protectedSession.id), false,
      "Protected scheduled sessions must not enter the cross-session Standard catalog");
  });
});
