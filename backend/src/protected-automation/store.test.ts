import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { close, failNextCommitStoreMutationPersistenceForTests, getStore, init } from "../db.js";
import { createProject } from "../projects.js";
import { commitWorkspaceCapabilityActivation, revokeWorkspaceCapabilityAssociation } from "../workspace-capabilities.js";
import { captureProtectedAutomationSnapshot } from "./snapshots.js";
import {
  createProtectedAutomationJob,
  createProtectedAutomationRun,
  enqueueProtectedAutomationRun,
  getProtectedAutomationJob,
  listProtectedAutomationRuns,
  rebindProtectedAutomationJob,
  tombstoneProtectedAutomationJob,
  transitionProtectedAutomationJobLifecycle,
  updateProtectedAutomationJob,
} from "./store.js";
import { ProtectedAutomationRuntimeStorage } from "./runtime-storage.js";
import {
  MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB,
  type ProtectedAutomationJobCreateInput,
  type ProtectedAutomationRunRow,
} from "./types.js";

let dataDir = "";
let projectRoot = "";

beforeEach(() => {
  close();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-store-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-project-"));
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

function fixture() {
  const profile = createAgentProfile({ name: "Automation owner" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
  });
  const association = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "a".repeat(64),
    approved_at: 10,
  });
  fs.mkdirSync(path.join(projectRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "src", "main.mjs"), "export default 'synthetic';\n");
  const jobId = randomUUID();
  const captureRevision = (revision: number, ownerJobId = jobId) => captureProtectedAutomationSnapshot({
    projectRoot,
    projectId: project.id,
    agentProfileId: profile.id,
    jobId: ownerJobId,
    revision,
    sourceDirectory: ".",
    entrypoint: "src/main.mjs",
  });
  const snapshot = captureRevision(1);
  const input: ProtectedAutomationJobCreateInput = {
    id: jobId,
    project_id: project.id,
    agent_profile_id: profile.id,
    capability_revision: association.revision,
    name: "Synthetic daily import",
    source_manifest_sha256: snapshot.manifestSha256,
    entrypoint: snapshot.entrypoint,
    argv: ["--mode", "synthetic"],
    uses_browser_profile: true,
    allowed_https_origins: ["https://example.test"],
    cron_expr: "0 8 * * *",
    timezone: "local",
    timeout_ms: 60_000,
    overlap_policy: "skip",
    missed_run_policy: "skip",
  };
  return { profile, project, association, input, captureRevision };
}

test("create/update/tombstone use overall and source CAS revisions", () => {
  const f = fixture();
  const created = createProtectedAutomationJob(f.input, 100);
  assert.equal(created.revision, 1);
  assert.equal(created.enabled, false);
  assert.equal(created.blocked_reason, "paused");
  assert.equal(created.source_revision, 1);
  assert.equal(created.schedule_cursor_at, 100);
  assert.equal(created.next_run_at, null);
  assert.equal(created.project_id, f.project.id);
  assert.equal(created.agent_profile_id, f.profile.id);
  assert.equal(created.capability_revision, f.association.revision);

  const secondSnapshot = f.captureRevision(2);
  const updated = updateProtectedAutomationJob(created.id, 1, {
    source_manifest_sha256: secondSnapshot.manifestSha256,
    cron_expr: "30 8 * * *",
    missed_run_policy: "run_once",
  }, 200);
  assert.equal(updated.revision, 2);
  assert.equal(updated.source_revision, 2);
  assert.equal(updated.schedule_cursor_at, 200);
  assert.equal(updated.last_occurrence_key, null);
  assert.equal(updated.enabled, false);
  assert.throws(() => updateProtectedAutomationJob(created.id, 1, { name: "stale" }), /revision conflict/);
  assert.throws(
    () => updateProtectedAutomationJob(created.id, 2, { project_id: "forged" } as never),
    /unsupported fields/,
  );

  const deleted = tombstoneProtectedAutomationJob(created.id, 2, 300);
  assert.equal(deleted.revision, 3);
  assert.equal(deleted.deleted_at, 300);
  assert.equal(deleted.blocked_reason, "tombstoned");
  assert.throws(() => tombstoneProtectedAutomationJob(created.id, 2), /revision conflict/);
  assert.throws(() => updateProtectedAutomationJob(created.id, 3, { name: "resurrect" }), /tombstoned/);

  close();
  init();
  assert.deepEqual(getProtectedAutomationJob(created.id), deleted);
});

test("lifecycle revisions advance overall CAS without consuming source revisions", () => {
  const f = fixture();
  const created = createProtectedAutomationJob(f.input, 100);
  const enabled = transitionProtectedAutomationJobLifecycle(created.id, 1, true, 150);
  assert.equal(enabled.revision, 2);
  assert.equal(enabled.source_revision, 1);
  const paused = transitionProtectedAutomationJobLifecycle(created.id, 2, false, 175);
  assert.equal(paused.revision, 3);
  assert.equal(paused.source_revision, 1);
  const snapshot = f.captureRevision(2);
  const updated = updateProtectedAutomationJob(created.id, 3, {
    source_manifest_sha256: snapshot.manifestSha256,
    name: "Source revision two",
  }, 200);
  assert.equal(updated.revision, 4);
  assert.equal(updated.source_revision, 2);
  assert.equal(updated.enabled, false);
});

test("backend capture may preallocate the stable job ID and duplicate IDs fail atomically", () => {
  const f = fixture();
  const preallocatedId = "018f4f2c-7d91-7a42-8c13-2d19dd9b8a61";
  const snapshot = f.captureRevision(1, preallocatedId);
  const created = createProtectedAutomationJob({
    ...f.input,
    id: preallocatedId,
    source_manifest_sha256: snapshot.manifestSha256,
  }, 100);
  assert.equal(created.id, preallocatedId);
  assert.equal(getProtectedAutomationJob(preallocatedId)?.revision, 1);
  assert.throws(
    () => createProtectedAutomationJob({ ...f.input, id: preallocatedId }, 101),
    /job ID already exists/,
  );
  assert.equal(getStore().protectedAutomationJobs.length, 1);
});

test("create and update require the exact owner/job/revision snapshot hash and entrypoint", () => {
  const f = fixture();
  assert.throws(
    () => createProtectedAutomationJob({ ...f.input, source_manifest_sha256: "0".repeat(64) }, 100),
    /manifest hash mismatch/,
  );
  assert.throws(
    () => createProtectedAutomationJob({ ...f.input, entrypoint: "src/other.mjs" }, 100),
    /entrypoint does not match/,
  );
  assert.deepEqual(getStore().protectedAutomationJobs, []);

  const created = createProtectedAutomationJob(f.input, 100);
  assert.throws(
    () => updateProtectedAutomationJob(created.id, created.revision, { name: "snapshot revision is absent" }, 200),
    /removed or replaced/,
  );
  assert.equal(getProtectedAutomationJob(created.id)!.revision, created.revision);

  const secondSnapshot = f.captureRevision(2);
  assert.throws(
    () => updateProtectedAutomationJob(created.id, created.revision, {
      source_manifest_sha256: secondSnapshot.manifestSha256,
      entrypoint: "src/other.mjs",
    }, 200),
    /entrypoint does not match/,
  );
  assert.equal(getProtectedAutomationJob(created.id)!.revision, created.revision);
});

test("explicit capability revocation and matching job denial share one durable commit", () => {
  const f = fixture();
  const job = createProtectedAutomationJob(f.input, 100);
  failNextCommitStoreMutationPersistenceForTests();
  assert.throws(() => revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.protected-automation.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    expected_revision: f.association.revision,
    revoked_at: 200,
  }), /Synthetic store persistence failure/);
  assert.equal(getStore().workspaceCapabilityAssociations.find((row) => row.capability_id === "wayang.protected-automation.v1")!.active, true);
  assert.deepEqual(getProtectedAutomationJob(job.id), job);

  const revoked = revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.protected-automation.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    expected_revision: f.association.revision,
    revoked_at: 200,
  });
  assert.equal(revoked.status, "revoked");
  const blocked = getProtectedAutomationJob(job.id)!;
  assert.equal(blocked.revision, job.revision + 1);
  assert.equal(blocked.blocked_reason, "capability_revoked");
  assert.equal(blocked.next_run_at, null);

  close();
  init();
  assert.equal(getStore().workspaceCapabilityAssociations.find((row) => row.capability_id === "wayang.protected-automation.v1")!.active, false);
  assert.deepEqual(getProtectedAutomationJob(job.id), blocked);
});

test("fallback duplicate wall-minute fire is claimed only once", { concurrency: false }, () => {
  const previousTz = process.env.TZ;
  process.env.TZ = "America/New_York";
  try {
    const f = fixture();
    const job = createProtectedAutomationJob(f.input, 100);
    const enabled = transitionProtectedAutomationJobLifecycle(job.id, 1, true, 150);
    const first = new Date("2026-11-01T01:30:00-04:00").getTime();
    const second = new Date("2026-11-01T01:30:00-05:00").getTime();
    enqueueProtectedAutomationRun({ jobId: enabled.id, expectedRevision: enabled.revision, trigger: "schedule",
      scheduledFor: first, occurrenceKey: "2026-11-01T01:30", now: first + 1 });
    assert.throws(() => enqueueProtectedAutomationRun({ jobId: enabled.id, expectedRevision: enabled.revision, trigger: "schedule",
      scheduledFor: second, occurrenceKey: "2026-11-01T01:30", now: second + 1 }), /occurrence was already claimed/);
    assert.equal(listProtectedAutomationRuns(job.id).length, 1);
  } finally {
    if (previousTz === undefined) delete process.env.TZ;
    else process.env.TZ = previousTz;
  }
});

test("queue claims and cursor metadata do not publish when canonical persistence fails", () => {
  const f = fixture();
  const job = createProtectedAutomationJob(f.input, 100);
  const enabled = transitionProtectedAutomationJobLifecycle(job.id, 1, true, 150);
  failNextCommitStoreMutationPersistenceForTests();
  assert.throws(() => enqueueProtectedAutomationRun({
    jobId: enabled.id,
    expectedRevision: enabled.revision,
    trigger: "schedule",
    scheduledFor: new Date(2026, 7, 3, 12, 0).getTime(),
    occurrenceKey: "2026-08-03T12:00",
    now: new Date(2026, 7, 3, 12, 1).getTime(),
  }), /Synthetic store persistence failure/);
  assert.deepEqual(listProtectedAutomationRuns(job.id), []);
  assert.equal(getProtectedAutomationJob(job.id)?.last_occurrence_key, null);
});

test("capability revocation atomically disables the job and cancels queued claims", () => {
  const f = fixture();
  const job = createProtectedAutomationJob(f.input, 100);
  const enabled = transitionProtectedAutomationJobLifecycle(job.id, 1, true, 150);
  const queued = enqueueProtectedAutomationRun({
    jobId: enabled.id,
    expectedRevision: enabled.revision,
    trigger: "manual",
    scheduledFor: null,
    occurrenceKey: null,
    now: 160,
  });
  revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.protected-automation.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    expected_revision: f.association.revision,
    revoked_at: 200,
  });
  const blocked = getProtectedAutomationJob(job.id)!;
  assert.equal(blocked.enabled, false);
  assert.equal(blocked.revision, enabled.revision + 1);
  assert.equal(blocked.source_revision, 1);
  assert.equal(blocked.blocked_reason, "capability_revoked");
  assert.equal(listProtectedAutomationRuns(job.id).find((run) => run.id === queued.id)?.status, "cancelled");
  assert.equal(listProtectedAutomationRuns(job.id).find((run) => run.id === queued.id)?.outcome_code, "authority_blocked");
  close();
  init();
  assert.equal(getProtectedAutomationJob(job.id)?.blocked_reason, "capability_revoked");
  assert.equal(listProtectedAutomationRuns(job.id)[0]?.status, "cancelled");
});

test("capability regrant advances attribution but never silently resumes or adopts retained jobs", () => {
  const f = fixture();
  const job = createProtectedAutomationJob(f.input);
  revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.protected-automation.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    expected_revision: f.association.revision,
  });
  const regranted = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1",
    project_id: f.project.id,
    agent_profile_id: f.profile.id,
    operation_digest: "9".repeat(64),
  });
  assert.equal(regranted.revision, 3);
  const retained = getProtectedAutomationJob(job.id)!;
  assert.equal(retained.enabled, false);
  assert.equal(retained.blocked_reason, "capability_revoked");
  assert.equal(retained.capability_revision, 1);
  assert.equal(retained.revision, job.revision + 1);
  assert.equal(retained.next_run_at, null);
  assert.throws(() => updateProtectedAutomationJob(job.id, job.revision, { name: "must explicitly rebind later" }), /revision conflict/);
  assert.equal(getProtectedAutomationJob(job.id)!.revision, retained.revision);

  const rebound = rebindProtectedAutomationJob(job.id, retained.revision, regranted.revision, 300);
  assert.equal(rebound.capability_revision, regranted.revision);
  assert.equal(rebound.revision, retained.revision + 1);
  assert.equal(rebound.source_revision, retained.source_revision);
  assert.equal(rebound.enabled, false);
  assert.equal(rebound.blocked_reason, "paused");
  const enabled = transitionProtectedAutomationJobLifecycle(job.id, rebound.revision, true, 301);
  assert.equal(enabled.enabled, true);
  assert.equal(enabled.revision, rebound.revision + 1);
});

test("strict bounded schemas reject executable, environment, path, origin, argv, and enable smuggling", () => {
  const f = fixture();
  assert.throws(() => createProtectedAutomationJob({ ...f.input, enabled: true } as never), /unsupported fields/);
  assert.throws(() => createProtectedAutomationJob({ ...f.input, runtime: "node" } as never), /unsupported fields/);
  assert.throws(() => createProtectedAutomationJob({ ...f.input, environment: { TOKEN: "synthetic" } } as never), /unsupported fields/);
  assert.throws(() => createProtectedAutomationJob({ ...f.input, entrypoint: "../escape.mjs" }), /normalized relative/);
  assert.throws(() => createProtectedAutomationJob({ ...f.input, allowed_https_origins: ["http://example.test"] }), /exact HTTPS origins/);
  assert.throws(() => createProtectedAutomationJob({ ...f.input, allowed_https_origins: ["https://example.test/path"] }), /exact HTTPS origins/);
  assert.throws(() => createProtectedAutomationJob({ ...f.input, argv: ["x".repeat(4_097)] }), /compiled byte bound/);
  assert.throws(() => createProtectedAutomationJob({ ...f.input, timezone: "UTC" as never }), /timezone must be local/);
  assert.throws(() => createProtectedAutomationJob({ ...f.input, overlap_policy: "parallel" as never }), /overlap_policy must be skip/);
  assert.deepEqual(getStore().protectedAutomationJobs, []);
});

test("durable load accepts canonical nonterminal and historical pre-rebind run attribution", () => {
  const f = fixture();
  const job = createProtectedAutomationJob(f.input, 100);
  createProtectedAutomationRun({
    job_id: job.id,
    project_id: job.project_id,
    agent_profile_id: job.agent_profile_id,
    job_revision: job.revision,
    capability_revision: job.capability_revision,
    trigger: "manual",
    scheduled_for: null,
    occurrence_key: null,
    started_at: 200,
    finished_at: 201,
    status: "denied",
    outcome_code: "synthetic_policy_denial",
    exit_code: null,
  });
  close();
  const storePath = path.join(dataDir, "store.json");
  const valid = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;

  const nonterminal = structuredClone(valid) as unknown as { protectedAutomationRuns: Array<Record<string, unknown>> };
  Object.assign(nonterminal.protectedAutomationRuns[0]!, {
    status: "queued",
    finished_at: null,
    outcome_code: null,
  });
  fs.writeFileSync(storePath, JSON.stringify(nonterminal), { mode: 0o600 });
  assert.doesNotThrow(() => init());
  close();

  const rolledBackSource = structuredClone(valid) as unknown as { protectedAutomationJobs: Array<Record<string, unknown>> };
  rolledBackSource.protectedAutomationJobs[0]!.source_revision = 2;
  fs.writeFileSync(storePath, JSON.stringify(rolledBackSource), { mode: 0o600 });
  assert.throws(() => init(), /malformed protected automation job/);
  close();

  const staleCapability = structuredClone(valid) as unknown as {
    protectedAutomationJobs: Array<Record<string, unknown>>;
    protectedAutomationRuns: Array<Record<string, unknown>>;
    workspaceCapabilityAssociations: Array<Record<string, unknown>>;
  };
  staleCapability.protectedAutomationJobs[0]!.capability_revision = 2;
  staleCapability.workspaceCapabilityAssociations.find((row) => row.capability_id === "wayang.protected-automation.v1")!.revision = 2;
  assert.equal(staleCapability.protectedAutomationRuns[0]!.capability_revision, 1);
  fs.writeFileSync(storePath, JSON.stringify(staleCapability), { mode: 0o600 });
  assert.doesNotThrow(() => init());
});

test("run pruning retires private storage only after the canonical store commit is durable", () => {
  const f = fixture();
  const created = createProtectedAutomationJob(f.input, 100);
  const owner = transitionProtectedAutomationJobLifecycle(created.id, created.revision, true, 101);
  const rows: ProtectedAutomationRunRow[] = Array.from({ length: MAX_PROTECTED_AUTOMATION_RUNS_PER_JOB }, (_, index) => ({
    id: `synthetic-prune-${String(index).padStart(4, "0")}`,
    job_id: owner.id,
    project_id: owner.project_id,
    agent_profile_id: owner.agent_profile_id,
    job_revision: owner.revision,
    capability_revision: owner.capability_revision,
    trigger: "manual",
    scheduled_for: null,
    occurrence_key: null,
    started_at: 1_000 + index,
    finished_at: 1_000 + index,
    status: "completed",
    outcome_code: "synthetic",
    exit_code: 0,
  }));
  getStore().protectedAutomationRuns = rows;
  const storage = new ProtectedAutomationRuntimeStorage();
  const oldest = rows[0]!;
  const identity = { projectId: owner.project_id, agentProfileId: owner.agent_profile_id, jobId: owner.id, runId: oldest.id };
  storage.prepareRun(owner, oldest);
  storage.persistDiagnostics(identity, Buffer.from("retained-until-commit"), Buffer.alloc(0));
  storage.cleanupRunScratch(identity);
  assert.equal(storage.hasRunStorage(oldest.id), true);

  failNextCommitStoreMutationPersistenceForTests();
  assert.throws(() => enqueueProtectedAutomationRun({
    jobId: owner.id, expectedRevision: owner.revision, trigger: "manual",
    scheduledFor: null, occurrenceKey: null, now: 2_000,
  }), /Synthetic store persistence failure/);
  assert.equal(storage.hasRunStorage(oldest.id), true, "failed persistence cannot retire canonical run storage");

  enqueueProtectedAutomationRun({
    jobId: owner.id, expectedRevision: owner.revision, trigger: "manual",
    scheduledFor: null, occurrenceKey: null, now: 2_000,
  });
  assert.equal(storage.hasRunStorage(oldest.id), false, "post-commit retirement removes pruned diagnostics");
});

test("run persistence enforces exact revision attribution and unique host-local scheduled occurrences", () => {
  const f = fixture();
  const job = createProtectedAutomationJob(f.input, 100);
  const scheduledFor = new Date(2026, 10, 1, 1, 30).getTime();
  const base = {
    job_id: job.id,
    project_id: job.project_id,
    agent_profile_id: job.agent_profile_id,
    job_revision: job.revision,
    capability_revision: job.capability_revision,
    trigger: "schedule" as const,
    scheduled_for: scheduledFor,
    occurrence_key: "2026-11-01T01:30",
    started_at: scheduledFor + 1,
    finished_at: scheduledFor + 2,
    status: "skipped" as const,
    outcome_code: "inert_test_record",
    exit_code: null,
  };
  const first = createProtectedAutomationRun(base);
  assert.equal(first.job_id, job.id);
  assert.deepEqual(listProtectedAutomationRuns(job.id), [first]);
  assert.equal(getProtectedAutomationJob(job.id)!.last_run_at, base.started_at);
  assert.equal(getProtectedAutomationJob(job.id)!.last_occurrence_key, base.occurrence_key);
  assert.equal(getProtectedAutomationJob(job.id)!.schedule_cursor_at, base.scheduled_for);
  assert.throws(() => createProtectedAutomationRun({ ...base, id: "second-run" }), /occurrence was already claimed/);
  assert.throws(() => createProtectedAutomationRun({ ...base, id: "third-run", occurrence_key: "bad-key" }), /host-local wall-minute/);
  assert.throws(() => createProtectedAutomationRun({ ...base, id: "fourth-run", job_revision: 2 }), /exact current job revision/);
  assert.throws(() => createProtectedAutomationRun({ ...base, id: "fifth-run", project_id: "forged-project" }), /exact current job revision/);
  assert.throws(() => createProtectedAutomationRun({ ...base, id: "sixth-run", prompt: "forbidden" } as never), /unsupported fields/);
  assert.throws(
    () => createProtectedAutomationRun({
      ...base,
      id: "missing-outcome",
      trigger: "manual",
      scheduled_for: null,
      occurrence_key: null,
      outcome_code: null,
    }),
    /terminal state is inconsistent/,
  );

  close();
  init();
  assert.deepEqual(listProtectedAutomationRuns(job.id), [first]);
  assert.equal(getProtectedAutomationJob(job.id)!.last_run_at, base.started_at);
});
