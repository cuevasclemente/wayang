import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close, init } from "../db.js";
import { createProject } from "../projects.js";
import { commitWorkspaceCapabilityActivation, resolveWorkspaceCapability } from "../workspace-capabilities.js";
import { ProtectedAutomationManager } from "./manager.js";
import { captureProtectedAutomationSnapshot } from "./snapshots.js";
import { createProtectedAutomationJob, getProtectedAutomationRun, transitionProtectedAutomationJobLifecycle } from "./store.js";
import type { ProtectedAutomationRunnerResult } from "./types.js";

let dataDir = "";
let projectRoot = "";

beforeEach(() => {
  close();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-manager-storage-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-manager-project-"));
  process.env.WAYANG_DATA_DIR = dataDir;
  init();
});

afterEach(() => {
  close();
  delete process.env.WAYANG_DATA_DIR;
  const unlock = (target: string): void => {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(target); } catch { return; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    try { fs.chmodSync(target, 0o700); } catch { return; }
    for (const name of fs.readdirSync(target)) unlock(path.join(target, name));
  };
  unlock(dataDir);
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function configuredJob() {
  const profile = createAgentProfile({ name: "Synthetic runtime owner" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
  });
  const association = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "b".repeat(64),
    approved_at: 1,
  });
  const authority = resolveWorkspaceCapability({
    capability_id: "wayang.protected-automation.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
  });
  if (!authority.authorized) throw new Error("Derived authority unavailable");
  fs.writeFileSync(path.join(projectRoot, "main.mjs"), "export default 'synthetic';\n", { mode: 0o600 });
  const id = randomUUID();
  const snapshot = captureProtectedAutomationSnapshot({
    projectRoot, projectId: project.id, agentProfileId: profile.id, jobId: id,
    revision: 1, sourceDirectory: ".", entrypoint: "main.mjs",
  });
  const created = createProtectedAutomationJob({
    id,
    project_id: project.id,
    agent_profile_id: profile.id,
    capability_revision: authority.association.revision,
    name: "Synthetic runtime storage",
    source_manifest_sha256: snapshot.manifestSha256,
    entrypoint: snapshot.entrypoint,
    argv: [],
    uses_browser_profile: false,
    allowed_https_origins: [],
    cron_expr: "0 8 * * *",
    timezone: "local",
    timeout_ms: 60_000,
    overlap_policy: "skip",
    missed_run_policy: "skip",
  }, 2);
  return transitionProtectedAutomationJobLifecycle(created.id, created.revision, true, 3);
}

function completed(stdout = "diagnostic"): ProtectedAutomationRunnerResult {
  return {
    status: "completed", outcomeCode: "completed", exitCode: 0,
    stdout: Buffer.from(stdout), stderr: Buffer.alloc(0),
  };
}

test("manager publishes only authorized completed state, preserves whole-project writes, and retires scratch", async () => {
  const job = configuredJob();
  const observedState: Array<string | null> = [];
  const runRoots: string[] = [];
  let invocation = 0;
  let clock = 10;
  const manager = new ProtectedAutomationManager({
    now: () => clock++,
    runner: async (request, options) => {
      invocation += 1;
      runRoots.push(options.runRoot);
      const cursor = path.join(options.stateRoot, "cursor");
      observedState.push(fs.existsSync(cursor) ? fs.readFileSync(cursor, "utf8") : null);
      fs.writeFileSync(cursor, String(invocation), { mode: 0o600 });
      fs.writeFileSync(path.join(request.projectRoot, `intentional-${invocation}`), "project-write", { mode: 0o600 });
      return invocation === 2
        ? { ...completed(), status: "failed", outcomeCode: "synthetic_failure", exitCode: 1 }
        : completed(`diagnostic-${invocation}`);
    },
  });
  manager.start();

  const first = manager.runNow(job.id, job.revision);
  await manager.waitForIdle();
  assert.equal(getProtectedAutomationRun(first.id)?.status, "completed");
  assert.equal(manager.hasRunStorage(first.id), true, "backend diagnostics remain run-owned");
  assert.equal(fs.existsSync(runRoots[0]!), false, "child scratch is deleted after completion");
  assert.equal(fs.readFileSync(path.join(projectRoot, "intentional-1"), "utf8"), "project-write");

  const second = manager.runNow(job.id, job.revision);
  await manager.waitForIdle();
  assert.equal(getProtectedAutomationRun(second.id)?.status, "failed");
  assert.equal(fs.existsSync(runRoots[1]!), false);

  const third = manager.runNow(job.id, job.revision);
  await manager.waitForIdle();
  assert.equal(getProtectedAutomationRun(third.id)?.status, "completed");
  assert.deepEqual(observedState, [null, "1", "1"], "failed staged state was never published");
  await manager.stop();
});

test("a cancellation race cannot publish a runner result that arrives afterward", async () => {
  const job = configuredJob();
  let entered!: () => void;
  const started = new Promise<void>((resolve) => { entered = resolve; });
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  const manager = new ProtectedAutomationManager({
    runner: async (_request, options) => {
      entered();
      await blocked;
      fs.writeFileSync(path.join(options.stateRoot, "must-not-publish"), "cancelled", { mode: 0o600 });
      return completed();
    },
  });
  manager.start();
  const row = manager.runNow(job.id, job.revision);
  await started;
  manager.cancel(row.id);
  release();
  await manager.waitForIdle();
  assert.equal(getProtectedAutomationRun(row.id)?.status, "cancelled");
  assert.equal(manager.hasRunStorage(row.id), false, "cancelled output and scratch are not retained");
  await manager.stop();
});
