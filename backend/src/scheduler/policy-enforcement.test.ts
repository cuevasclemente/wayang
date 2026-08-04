import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "../agent-profiles.js";
import { close, init } from "../db.js";
import { createProject, updateProject } from "../projects.js";
import { assertScheduledRuntimeAuthorized, SchedulerManager } from "./manager.js";
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

function protect(projectId: string, defaultAgentProfileId: string): void {
  updateProject(projectId, {
    access_policy: {
      privacy_mode: "protected",
      allowed_agent_profile_ids: [defaultAgentProfileId],
    },
  });
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

test("protected project policy denies scheduled job create and update before persistence", async () => {
  await withStore((root) => {
    const protectedCwd = path.join(root, "protected");
    const standardCwd = path.join(root, "standard");
    fs.mkdirSync(protectedCwd);
    fs.mkdirSync(standardCwd);
    const protectedDefault = createAgentProfile({ name: "Protected project default" });
    createProject({
      cwd: protectedCwd,
      default_agent_profile_id: protectedDefault.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [protectedDefault.id] },
    });
    assert.throws(() => createScheduledJob(input(protectedCwd)), /Protected projects do not allow scheduled access/);

    const project = createProject({ cwd: standardCwd });
    const job = createScheduledJob(input(standardCwd));
    protect(project.id, project.default_agent_profile_id);
    assert.throws(() => createScheduledJob(input(standardCwd)), /Protected projects do not allow scheduled access/);
    const before = getScheduledJob(job.id)!;
    assert.throws(() => updateScheduledJob(job.id, { name: "must not persist" }), /Protected projects/);
    assert.equal(getScheduledJob(job.id)?.name, before.name);
  });
});

test("manual run and timer fire reauthorize the latest job and project policy", async () => {
  await withStore((root) => {
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const project = createProject({ cwd });
    const job = createScheduledJob(input(cwd, { enabled: true }));
    protect(project.id, project.default_agent_profile_id);
    const manager = new SchedulerManager();
    assert.throws(() => manager.triggerRun(job.id), /Protected projects do not allow scheduled access/);

    const internals = manager as unknown as {
      beginRun(job: ScheduledJobRow, trigger: "schedule", scheduledFor: number): ScheduledRunRow;
    };
    const timerRun = internals.beginRun(job, "schedule", Date.now());
    assert.equal(timerRun.status, "skipped");
    assert.match(timerRun.error_message ?? "", /Protected projects do not allow scheduled access/);
  });
});

test("scheduled execution reauthorizes immediately before Pi runtime creation", async () => {
  await withStore((root) => {
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const project = createProject({ cwd });
    assert.doesNotThrow(() => assertScheduledRuntimeAuthorized(cwd, project.default_agent_profile_id));
    protect(project.id, project.default_agent_profile_id);
    assert.throws(
      () => assertScheduledRuntimeAuthorized(cwd, project.default_agent_profile_id),
      /Protected projects do not allow scheduled access/,
    );
  });
});

test("permission_mode bypass never overrides a denied project policy decision", async () => {
  await withStore((root) => {
    const cwd = path.join(root, "project");
    fs.mkdirSync(cwd);
    const project = createProject({ cwd });
    const job = createScheduledJob(input(cwd, { permission_mode: "bypass" }));
    assert.equal(job.permission_mode, "bypass");
    protect(project.id, project.default_agent_profile_id);
    assert.throws(() => new SchedulerManager().triggerRun(job.id), /Protected projects do not allow scheduled access/);
  });
});
