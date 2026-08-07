import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import {
  ProtectedAutomationRuntimeStorage,
  type ProtectedAutomationRuntimeStorageLimits,
} from "./runtime-storage.js";
import type { ProtectedAutomationJobRow, ProtectedAutomationRunRow, ProtectedAutomationRunStatus } from "./types.js";

function job(id = "job-a"): ProtectedAutomationJobRow {
  return {
    id, project_id: "project-a", agent_profile_id: "profile-a", capability_revision: 1,
    revision: 2, source_revision: 1, name: "Synthetic", source_manifest_sha256: "a".repeat(64),
    entrypoint: "main.mjs", argv: [], uses_browser_profile: false, allowed_https_origins: [],
    cron_expr: "0 8 * * *", timezone: "local", timeout_ms: 10_000, overlap_policy: "skip",
    missed_run_policy: "skip", enabled: true, blocked_reason: null, deleted_at: null,
    created_at: 1, updated_at: 1, schedule_cursor_at: 1, last_occurrence_key: null,
    last_run_at: null, next_run_at: null,
  };
}

function run(owner: ProtectedAutomationJobRow, id: string, status: ProtectedAutomationRunStatus = "running"): ProtectedAutomationRunRow {
  return {
    id, job_id: owner.id, project_id: owner.project_id, agent_profile_id: owner.agent_profile_id,
    job_revision: owner.revision, capability_revision: owner.capability_revision, trigger: "manual",
    scheduled_for: null, occurrence_key: null, started_at: 2, finished_at: status === "running" ? null : 3,
    status, outcome_code: status === "running" ? null : status, exit_code: null,
  };
}

function fixture(limits: Partial<ProtectedAutomationRuntimeStorageLimits> = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-runtime-storage-"));
  const storage = new ProtectedAutomationRuntimeStorage({ root, limits });
  const cleanup = () => {
    const unlock = (target: string): void => {
      let metadata: fs.Stats;
      try { metadata = fs.lstatSync(target); } catch { return; }
      if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
      fs.chmodSync(target, 0o700);
      for (const name of fs.readdirSync(target)) unlock(path.join(target, name));
    };
    unlock(root);
    fs.rmSync(root, { recursive: true, force: true });
  };
  return { root, storage, cleanup };
}

function identity(owner: ProtectedAutomationJobRow, row: ProtectedAutomationRunRow) {
  return { projectId: owner.project_id, agentProfileId: owner.agent_profile_id, jobId: owner.id, runId: row.id };
}

test("state publication is staged, atomic, and copied only after a durable publishable status", () => {
  const f = fixture();
  try {
    const owner = job();
    const first = run(owner, "run-first");
    const firstRoots = f.storage.prepareRun(owner, first);
    const runOwner = path.join(path.dirname(firstRoots.runRoot), "OWNER.json");
    const stateOwner = path.join(path.dirname(firstRoots.stateRoot), "OWNER.json");
    assert.equal(fs.statSync(runOwner).mode & 0o777, 0o400);
    assert.equal(fs.statSync(stateOwner).mode & 0o777, 0o400);
    assert.equal(firstRoots.runRoot.includes("OWNER.json"), false, "backend owner markers are outside child mounts");
    fs.writeFileSync(path.join(firstRoots.stateRoot, "cursor.json"), "one", { mode: 0o600 });
    f.storage.sealState(identity(owner, first), "completed");

    const before = run(owner, "run-before-publication");
    const beforeRoots = f.storage.prepareRun(owner, before);
    assert.equal(fs.existsSync(path.join(beforeRoots.stateRoot, "cursor.json")), false,
      "sealed staging state is not visible before CURRENT publication");
    f.storage.discardStagedState(identity(owner, before));

    f.storage.publishState(identity(owner, first), "completed");
    f.storage.cleanupRunScratch(identity(owner, first));
    assert.equal(fs.existsSync(firstRoots.runRoot), false, "child-mounted scratch is retired");

    const second = run(owner, "run-second");
    const secondRoots = f.storage.prepareRun(owner, second);
    assert.equal(fs.readFileSync(path.join(secondRoots.stateRoot, "cursor.json"), "utf8"), "one");
    assert.notEqual(path.dirname(firstRoots.runRoot), path.dirname(firstRoots.stateRoot));
  } finally { f.cleanup(); }
});

test("startup reconciliation publishes a sealed completed generation and discards interrupted state and scratch", () => {
  const f = fixture();
  try {
    const owner = job();
    const completedRunning = run(owner, "run-crashed-complete");
    const completedRoots = f.storage.prepareRun(owner, completedRunning);
    fs.writeFileSync(path.join(completedRoots.stateRoot, "checkpoint"), "durable", { mode: 0o600 });
    f.storage.sealState(identity(owner, completedRunning), "completed");
    const completed = { ...completedRunning, status: "completed", finished_at: 4, outcome_code: "completed" } as ProtectedAutomationRunRow;
    f.storage.reconcile([owner], [completed]);
    assert.equal(fs.existsSync(completedRoots.runRoot), false);

    const next = run(owner, "run-after-crash");
    const nextRoots = f.storage.prepareRun(owner, next);
    assert.equal(fs.readFileSync(path.join(nextRoots.stateRoot, "checkpoint"), "utf8"), "durable");
    f.storage.discardStagedState(identity(owner, next));
    f.storage.cleanupRunScratch(identity(owner, next));

    const interruptedRunning = run(owner, "run-interrupted");
    const interruptedRoots = f.storage.prepareRun(owner, interruptedRunning);
    fs.writeFileSync(path.join(interruptedRoots.stateRoot, "checkpoint"), "must-not-publish", { mode: 0o600 });
    const interrupted = { ...interruptedRunning, status: "interrupted", finished_at: 5, outcome_code: "service_restart" } as ProtectedAutomationRunRow;
    f.storage.reconcile([owner], [completed, interrupted]);
    const after = run(owner, "run-after-interruption");
    const afterRoots = f.storage.prepareRun(owner, after);
    assert.equal(fs.readFileSync(path.join(afterRoots.stateRoot, "checkpoint"), "utf8"), "durable");
  } finally { f.cleanup(); }
});

test("startup reconciliation never publishes completed staging after authority is no longer current", () => {
  const f = fixture();
  try {
    const owner = job();
    const running = run(owner, "run-revoked-before-reconcile");
    const roots = f.storage.prepareRun(owner, running);
    fs.writeFileSync(path.join(roots.stateRoot, "revoked"), "must-not-publish", { mode: 0o600 });
    f.storage.sealState(identity(owner, running), "completed");
    const completed = { ...running, status: "completed", finished_at: 4, outcome_code: "completed" } as ProtectedAutomationRunRow;
    f.storage.reconcile([{ ...owner, enabled: false, blocked_reason: "capability_revoked" }], [completed]);
    const next = run(owner, "run-after-revocation");
    const nextRoots = f.storage.prepareRun(owner, next);
    assert.equal(fs.existsSync(path.join(nextRoots.stateRoot, "revoked")), false);
  } finally { f.cleanup(); }
});

test("state rejects symlinks, hardlinks, special entries, and exact-owner collisions", () => {
  const f = fixture();
  try {
    const owner = job();
    const row = run(owner, "run-unsafe");
    const roots = f.storage.prepareRun(owner, row);
    const external = path.join(f.root, "external");
    fs.writeFileSync(external, "external");
    fs.symlinkSync(external, path.join(roots.stateRoot, "linked"));
    assert.throws(() => f.storage.sealState(identity(owner, row), "completed"), /symlink|unsafe/i);
    fs.unlinkSync(path.join(roots.stateRoot, "linked"));
    fs.linkSync(external, path.join(roots.stateRoot, "hardlinked"));
    assert.throws(() => f.storage.sealState(identity(owner, row), "completed"), /linked|unsafe/i);

    const foreign = { ...owner, id: "job-foreign", project_id: "project-foreign" };
    const collision = run(foreign, row.id);
    assert.throws(() => f.storage.prepareRun(foreign, collision), /exact owner/i);
  } finally { f.cleanup(); }
});

test("diagnostics stay outside child mounts and global, pair, and job quotas fail closed", () => {
  for (const limited of ["globalBytes", "pairBytes", "jobBytes"] as const) {
    const f = fixture({ [limited]: 8_192 });
    try {
      const owner = job(`job-${limited}`);
      const row = run(owner, `run-${limited}`);
      f.storage.prepareRun(owner, row);
      assert.throws(() => f.storage.persistDiagnostics(identity(owner, row), Buffer.alloc(16_384), Buffer.alloc(0)), /quota/i);
    } finally { f.cleanup(); }
  }

  const f = fixture();
  try {
    const owner = job();
    const row = run(owner, "run-diagnostics");
    const roots = f.storage.prepareRun(owner, row);
    f.storage.persistDiagnostics(identity(owner, row), Buffer.from("stdout"), Buffer.from("stderr"));
    assert.equal(fs.existsSync(path.join(roots.runRoot, "stdout.log")), false);
    assert.equal(f.storage.hasRunStorage(row.id), true);
  } finally { f.cleanup(); }
});

test("strict purge retirement reports residual failure and startup reconciliation removes it", () => {
  const f = fixture();
  try {
    const owner = job();
    const row = run(owner, "run-strict-retirement");
    const roots = f.storage.prepareRun(owner, row);
    fs.chmodSync(path.join(path.dirname(roots.runRoot), "OWNER.json"), 0o600);
    const jobIdentity = { projectId: owner.project_id, agentProfileId: owner.agent_profile_id, jobId: owner.id };
    assert.throws(
      () => f.storage.retireJob(jobIdentity, new Set(), []),
      /runtime artifact owner is unreadable/i,
    );
    assert.equal(f.storage.hasRunStorage(row.id), true, "failed verified retirement never reports absence");
    f.storage.reconcile([], []);
    assert.equal(f.storage.hasRunStorage(row.id), false, "startup orphan reconciliation removes the residual tree");
  } finally { f.cleanup(); }
});

test("job retirement defers while active and removes private storage after the active set clears", () => {
  const f = fixture();
  try {
    const owner = job();
    const row = run(owner, "run-active");
    f.storage.prepareRun(owner, row);
    const jobIdentity = { projectId: owner.project_id, agentProfileId: owner.agent_profile_id, jobId: owner.id };
    assert.equal(f.storage.retireJob(jobIdentity, new Set([row.id])), false);
    assert.equal(f.storage.hasRunStorage(row.id), true);
    f.storage.flushDeferred(() => new Set());
    assert.equal(f.storage.hasRunStorage(row.id), false);
  } finally { f.cleanup(); }
});
