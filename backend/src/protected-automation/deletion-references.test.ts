import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile, deleteAgentProfile, updateAgentProfile } from "../agent-profiles.js";
import { close, getStore, init } from "../db.js";
import {
  createProject,
  deleteProjectRegistration,
  getProjectRegistrationReferences,
  updateProject,
} from "../projects.js";
import { commitWorkspaceCapabilityActivation } from "../workspace-capabilities.js";
import { WorkspaceSettingsService } from "../workspace-settings-service.js";
import { captureProtectedAutomationSnapshot } from "./snapshots.js";
import {
  createProtectedAutomationJob,
  createProtectedAutomationRun,
  tombstoneProtectedAutomationJob,
} from "./store.js";

let dataDir = "";
let projectRoot = "";

beforeEach(() => {
  close();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-references-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-reference-project-"));
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

function captureFixtureSnapshot(input: {
  projectRoot: string;
  projectId: string;
  agentProfileId: string;
  jobId: string;
}) {
  fs.writeFileSync(path.join(input.projectRoot, "main.mjs"), "export default 'synthetic reference';\n");
  return captureProtectedAutomationSnapshot({
    ...input,
    revision: 1,
    sourceDirectory: ".",
    entrypoint: "main.mjs",
  });
}

function fixture(withRun = false) {
  const owner = createAgentProfile({ name: "Exact automation owner" });
  const replacement = createAgentProfile({ name: "Replacement without ownership" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: owner.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [owner.id, replacement.id] },
  });
  const association = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1",
    project_id: project.id,
    agent_profile_id: owner.id,
    operation_digest: "c".repeat(64),
  });
  const jobId = randomUUID();
  const snapshot = captureFixtureSnapshot({
    projectRoot,
    projectId: project.id,
    agentProfileId: owner.id,
    jobId,
  });
  const job = createProtectedAutomationJob({
    id: jobId,
    project_id: project.id,
    agent_profile_id: owner.id,
    capability_revision: association.revision,
    name: "Reference owner",
    source_manifest_sha256: snapshot.manifestSha256,
    entrypoint: snapshot.entrypoint,
    argv: [],
    uses_browser_profile: false,
    allowed_https_origins: [],
    cron_expr: "0 8 * * *",
    timezone: "local",
    timeout_ms: 30_000,
    overlap_policy: "skip",
    missed_run_policy: "skip",
  });
  const run = withRun ? createProtectedAutomationRun({
    job_id: job.id,
    project_id: project.id,
    agent_profile_id: owner.id,
    job_revision: job.revision,
    capability_revision: job.capability_revision,
    trigger: "manual",
    scheduled_for: null,
    occurrence_key: null,
    started_at: job.created_at,
    finished_at: job.created_at + 1,
    status: "denied",
    outcome_code: "milestone_1_inert",
    exit_code: null,
  }) : null;
  return { owner, replacement, project, association, job, run };
}

test("project deletion is blocked by exact automation job/run IDs including tombstones", () => {
  const f = fixture(true);
  const live = getProjectRegistrationReferences(f.project.id);
  assert.deepEqual(live.protected_automation_jobs, [f.job.id]);
  assert.deepEqual(live.protected_automation_runs, [f.run!.id]);
  assert.throws(() => deleteProjectRegistration(f.project.id), /protected_automation_jobs|protected_automation_runs/);

  tombstoneProtectedAutomationJob(f.job.id, f.job.revision);
  const tombstoned = getProjectRegistrationReferences(f.project.id);
  assert.deepEqual(tombstoned.protected_automation_jobs, [f.job.id]);
  assert.deepEqual(tombstoned.protected_automation_runs, [f.run!.id]);
  assert.throws(() => deleteProjectRegistration(f.project.id), /protected_automation_jobs|protected_automation_runs/);
});

test("profile deletion never transfers automation ownership to a replacement stable ID", async () => {
  const f = fixture(true);
  updateProject(f.project.id, {
    default_agent_profile_id: f.replacement.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [f.owner.id, f.replacement.id] },
  });
  assert.throws(
    () => deleteAgentProfile(f.owner.id, f.replacement.id),
    /protected automation history references its exact stable ID/,
  );
  const row = getStore().protectedAutomationJobs.find((candidate) => candidate.id === f.job.id)!;
  assert.equal(row.agent_profile_id, f.owner.id);
  assert.notEqual(row.agent_profile_id, f.replacement.id);

  const service = new WorkspaceSettingsService();
  await assert.rejects(
    () => service.deleteAgentProfileForUi(f.owner.id, f.replacement.id),
    /protected automation history references its exact stable ID/,
  );
  assert.equal(getStore().protectedAutomationRuns[0]!.agent_profile_id, f.owner.id);
});

test("privacy/allowlist incompatibility and profile disable persistently block without changing owner IDs", () => {
  const f = fixture();
  updateProject(f.project.id, {
    default_agent_profile_id: f.replacement.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [f.replacement.id] },
  });
  let row = getStore().protectedAutomationJobs.find((candidate) => candidate.id === f.job.id)!;
  assert.equal(row.enabled, false);
  assert.equal(row.blocked_reason, "project_policy_incompatible");
  assert.equal(row.agent_profile_id, f.owner.id);
  assert.equal(row.capability_revision, f.association.revision);

  // A separate exact pair proves profile disable is also a durable denial and
  // never rewrites ownership through project/profile defaults.
  const otherRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-automation-disable-project-"));
  try {
    const profile = createAgentProfile({ name: "Disable owner" });
    const project = createProject({
      cwd: otherRoot,
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id, f.replacement.id] },
    });
    const association = commitWorkspaceCapabilityActivation({
      capability_id: "wayang.protected-automation.v1",
      project_id: project.id,
      agent_profile_id: profile.id,
      operation_digest: "e".repeat(64),
    });
    const jobId = randomUUID();
    const snapshot = captureFixtureSnapshot({
      projectRoot: otherRoot,
      projectId: project.id,
      agentProfileId: profile.id,
      jobId,
    });
    const job = createProtectedAutomationJob({
      id: jobId,
      project_id: project.id,
      agent_profile_id: profile.id,
      capability_revision: association.revision,
      name: "Disable reference",
      source_manifest_sha256: snapshot.manifestSha256,
      entrypoint: snapshot.entrypoint,
      argv: [],
      uses_browser_profile: false,
      allowed_https_origins: [],
      cron_expr: "0 8 * * *",
      timezone: "local",
      timeout_ms: 30_000,
      overlap_policy: "skip",
      missed_run_policy: "skip",
    });
    updateProject(project.id, {
      default_agent_profile_id: f.replacement.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id, f.replacement.id] },
    });
    updateAgentProfile(profile.id, { enabled: false });
    row = getStore().protectedAutomationJobs.find((candidate) => candidate.id === job.id)!;
    assert.equal(row.blocked_reason, "agent_profile_disabled");
    assert.equal(row.agent_profile_id, profile.id);
    assert.equal(row.enabled, false);
  } finally {
    fs.rmSync(otherRoot, { recursive: true, force: true });
  }
});
