import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  close,
  flush,
  getStore,
  getWorkspaceCapabilityStoreProjectionPath,
  init,
  type SessionRow,
} from "./db.js";
import { createAgentProfile, deleteAgentProfile, updateAgentProfile } from "./agent-profiles.js";
import { createProject, deleteProjectRegistration, updateProject } from "./projects.js";
import {
  MAX_WORKSPACE_CAPABILITY_APPROVAL_EVENTS,
  commitWorkspaceCapabilityActivation,
  isSessionCapabilityEligible,
  resolveCurrentWorkspaceCapabilityWitness,
  resolveWorkspaceCapability,
  revokeWorkspaceCapabilityAssociation,
} from "./workspace-capabilities.js";
import { capabilityPairRuntimeSessionIds } from "./runtime-impact.js";

let dataDir = "";
let projectRoot = "";

beforeEach(() => {
  close();
  dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-capabilities-"));
  projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-capability-project-"));
  process.env.WAYANG_DATA_DIR = dataDir;
});

afterEach(() => {
  close();
  delete process.env.WAYANG_DATA_DIR;
  fs.rmSync(dataDir, { recursive: true, force: true });
  fs.rmSync(projectRoot, { recursive: true, force: true });
});

function digest(character = "a"): string {
  return character.repeat(64);
}

function pair(capability_id: "wayang.host-execution.v1" | "wayang.standard-browser.v1" | "wayang.protected-browser.v1" = "wayang.host-execution.v1") {
  const profile = createAgentProfile({ name: "Arbitrary deployment label", resource_mode: "standard" });
  const project = createProject({
    cwd: projectRoot,
    name: "Not an identity selector",
    default_agent_profile_id: profile.id,
    access_policy: capability_id === "wayang.protected-browser.v1"
      ? { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] }
      : { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  return {
    capability_id,
    project_id: project.id,
    agent_profile_id: profile.id,
  } as const;
}

test("fresh stores contain no capability authority", () => {
  init();
  const store = getStore();
  const defaultProfile = store.agentProfiles.find(
    (profile) => profile.id === store.workspaceSettings.default_agent_profile_id,
  );
  assert.ok(defaultProfile);
  assert.equal(defaultProfile.builtin_kind, null);
  assert.equal(defaultProfile.resource_mode, "project_only");
  assert.equal(defaultProfile.memory_access, "none");
  assert.deepEqual(defaultProfile.allowed_tools, []);
  assert.deepEqual(defaultProfile.allowed_extensions, []);
  assert.ok(store.agentProfiles.every((profile) => !(
    "capability_grants" in profile || "authorization_revision" in profile
  )));
  assert.deepEqual(store.workspaceCapabilityAssociations, []);
  assert.deepEqual(store.workspaceCapabilityApprovalEvents, []);
});

test("ordinary CRUD cannot smuggle authority", () => {
  assert.throws(
    () => createAgentProfile({ name: "Smuggled", capability_grants: [] } as never),
    /cannot be changed through ordinary agent profile CRUD/,
  );
  assert.throws(
    () => createProject({ cwd: projectRoot, capability_associations: [] } as never),
    /cannot be changed through ordinary project CRUD/,
  );
});

test("resolver uses one exact active project/profile/capability association and ignores model variation", () => {
  const input = pair();
  assert.deepEqual(resolveWorkspaceCapability(input), { authorized: false, reason: "association_missing" });
  const association = commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  assert.equal(association.revision, 1);
  const authorized = resolveWorkspaceCapability(input);
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  assert.equal(authorized.association.revision, 1);
  assert.equal(Object.isFrozen(authorized), true);
  assert.equal(Object.isFrozen(authorized.association), true);
  updateProject(input.project_id, { default_provider: "other-provider", default_model: "other-model" });
  updateAgentProfile(input.agent_profile_id, { default_provider: "third-provider", default_model: "third-model" });
  assert.equal(resolveWorkspaceCapability(input).authorized, true);
  assert.equal(resolveWorkspaceCapability({ ...input, provider: "fluid", model: "fluid" } as never).authorized, true);
  assert.equal(resolveCurrentWorkspaceCapabilityWitness(authorized).authorized, true);
});

test("revocation and reactivation advance the sole association clock and stale revoke conflicts", () => {
  const input = pair();
  const first = commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest("a"), approved_at: 10 });
  const firstWitness = resolveWorkspaceCapability(input);
  assert.equal(firstWitness.authorized, true);
  const revoked = revokeWorkspaceCapabilityAssociation({ ...input, expected_revision: first.revision, revoked_at: 20 });
  assert.equal(revoked.status, "revoked");
  assert.equal(revoked.association.revision, 2);
  assert.equal(revoked.association.active, false);
  assert.equal(getStore().workspaceCapabilityApprovalEvents[0]!.revoked_at, 20);
  const again = revokeWorkspaceCapabilityAssociation({ ...input, expected_revision: first.revision, revoked_at: 21 });
  assert.equal(again.status, "already_revoked");

  const second = commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest("b"), approved_at: 30 });
  assert.equal(second.revision, 3);
  if (firstWitness.authorized) {
    assert.deepEqual(resolveCurrentWorkspaceCapabilityWitness(firstWitness), {
      authorized: false,
      reason: "stale_association_revision",
    });
  }
  assert.throws(
    () => revokeWorkspaceCapabilityAssociation({ ...input, expected_revision: first.revision, revoked_at: 40 }),
    /revision conflict/,
  );
  assert.equal(resolveWorkspaceCapability(input).authorized, true);
});

test("audit saturation blocks activation but never blocks explicit denial", () => {
  const input = pair();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const store = getStore();
  for (let index = 1; index < MAX_WORKSPACE_CAPABILITY_APPROVAL_EVENTS; index += 1) {
    store.workspaceCapabilityApprovalEvents.push({
      id: `synthetic-${index}`,
      project_id: `deleted-project-${index}`,
      agent_profile_id: `deleted-profile-${index}`,
      capability_id: "wayang.host-execution.v1",
      association_revision: 1,
      operation_digest: digest(index % 2 === 0 ? "b" : "c"),
      approved_at: index,
      revoked_at: index,
    });
  }
  assert.throws(
    () => commitWorkspaceCapabilityActivation({
      ...input, capability_id: "wayang.standard-resources.v1", operation_digest: digest("d"),
    }),
    /history is full/,
  );
  const revoked = revokeWorkspaceCapabilityAssociation({ ...input, expected_revision: 1 });
  assert.equal(revoked.status, "revoked");
});

test("profile edits and disable preserve associations; reenable restores only the durable resolver", () => {
  const input = pair();
  const association = commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  updateAgentProfile(input.agent_profile_id, { name: "Renamed", instructions: "changed", memory_access: "read" });
  assert.equal(resolveWorkspaceCapability(input).authorized, true);

  const replacement = createAgentProfile({ name: "Default replacement" });
  updateProject(input.project_id, { default_agent_profile_id: replacement.id, access_policy: {
    privacy_mode: "standard",
    allowed_agent_profile_ids: [input.agent_profile_id, replacement.id],
  } });
  updateAgentProfile(input.agent_profile_id, { enabled: false });
  assert.deepEqual(resolveWorkspaceCapability(input), { authorized: false, reason: "profile_disabled" });
  assert.deepEqual(getStore().workspaceCapabilityAssociations[0], association);
  flush(); // active association plus disabled subject is a valid durable denial state
  updateAgentProfile(input.agent_profile_id, { enabled: true });
  const restored = resolveWorkspaceCapability(input);
  assert.equal(restored.authorized, true);
  if (restored.authorized) assert.equal(restored.association.revision, association.revision);
});

test("allowlist mutation tombstones only newly excluded pairs and widening never revives", () => {
  const input = pair();
  const second = createAgentProfile({ name: "Second" });
  updateProject(input.project_id, { access_policy: {
    privacy_mode: "standard",
    allowed_agent_profile_ids: [input.agent_profile_id, second.id],
  } });
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest("a") });
  commitWorkspaceCapabilityActivation({ ...input, agent_profile_id: second.id, operation_digest: digest("b") });

  updateProject(input.project_id, { access_policy: {
    privacy_mode: "standard",
    allowed_agent_profile_ids: [input.agent_profile_id],
  } });
  assert.equal(resolveWorkspaceCapability(input).authorized, true);
  assert.deepEqual(
    resolveWorkspaceCapability({ ...input, agent_profile_id: second.id }),
    { authorized: false, reason: "profile_not_allowed" },
  );
  const excluded = getStore().workspaceCapabilityAssociations.find((row) => row.agent_profile_id === second.id)!;
  assert.equal(excluded.active, false);
  assert.equal(excluded.revision, 2);

  updateProject(input.project_id, { access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null } });
  assert.deepEqual(
    resolveWorkspaceCapability({ ...input, agent_profile_id: second.id }),
    { authorized: false, reason: "association_inactive" },
  );
});

test("null to allowlist tombstones only profiles excluded by the new decision", () => {
  const target = createAgentProfile({ name: "Target" });
  const defaultId = getStore().workspaceSettings.default_agent_profile_id;
  const project = createProject({ cwd: projectRoot, access_policy: {
    privacy_mode: "standard",
    allowed_agent_profile_ids: null,
  } });
  const input = {
    capability_id: "wayang.host-execution.v1" as const,
    project_id: project.id,
    agent_profile_id: target.id,
  };
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  updateProject(project.id, { access_policy: {
    privacy_mode: "standard",
    allowed_agent_profile_ids: [defaultId],
  } });
  assert.equal(getStore().workspaceCapabilityAssociations[0]!.active, false);
  assert.deepEqual(resolveWorkspaceCapability(input), { authorized: false, reason: "profile_not_allowed" });
});

test("privacy changes tombstone only incompatible capabilities", () => {
  const input = pair();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  updateProject(input.project_id, { access_policy: {
    privacy_mode: "protected",
    allowed_agent_profile_ids: [input.agent_profile_id],
  } });
  const row = getStore().workspaceCapabilityAssociations[0]!;
  assert.equal(row.active, false);
  assert.equal(row.revision, 2);
  assert.throws(
    () => commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest("b") }),
    /incompatible with project privacy mode/,
  );
});

test("profile deletion tombstones before cleanup and leaves orphaned tombstone/audit history valid", () => {
  const input = pair();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const replacement = createAgentProfile({ name: "Replacement" });
  deleteAgentProfile(input.agent_profile_id, replacement.id);
  const row = getStore().workspaceCapabilityAssociations[0]!;
  assert.equal(row.active, false);
  assert.equal(row.revision, 2);
  assert.equal(getStore().agentProfiles.some((profile) => profile.id === input.agent_profile_id), false);
  assert.equal(getStore().workspaceCapabilityApprovalEvents[0]!.agent_profile_id, input.agent_profile_id);
  assert.deepEqual(resolveWorkspaceCapability({ ...input, agent_profile_id: replacement.id }), {
    authorized: false,
    reason: "association_missing",
  });
  flush();
});

test("project deletion tombstones before cleanup and retains deleted stable IDs", () => {
  const input = pair();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  deleteProjectRegistration(input.project_id);
  assert.equal(getStore().projects.some((project) => project.id === input.project_id), false);
  assert.equal(getStore().workspaceCapabilityAssociations[0]!.active, false);
  const replacement = createProject({
    cwd: projectRoot,
    default_agent_profile_id: input.agent_profile_id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [input.agent_profile_id] },
  });
  assert.deepEqual(resolveWorkspaceCapability({ ...input, project_id: replacement.id }), {
    authorized: false,
    reason: "association_missing",
  });
  flush();
});

test("pair runtime query resolves cwd from immutable Project ID", () => {
  const input = pair();
  const store = getStore();
  store.sessions.push({
    id: "matching", pi_session_file: null, title: "Matching", cwd: projectRoot, provider: "p", model: "m",
    agent_profile_id: input.agent_profile_id, pending_agent_switch: null,
    legacy_private_session_quarantine: false, legacy_capability_ineligible: false,
    created_at: 1, last_active: 1, archived: 0, archived_at: null, goal: null, goal_status: null,
    scheduled_job_id: null, scheduled_run_id: null, error: null,
  });
  store.sessions.push({
    id: "wrong-profile", pi_session_file: null, title: "Wrong", cwd: projectRoot, provider: "p", model: "m",
    agent_profile_id: getStore().workspaceSettings.default_agent_profile_id, pending_agent_switch: null,
    legacy_private_session_quarantine: false, legacy_capability_ineligible: false,
    created_at: 1, last_active: 1, archived: 0, archived_at: null, goal: null, goal_status: null,
    scheduled_job_id: null, scheduled_run_id: null, error: null,
  });
  assert.deepEqual(capabilityPairRuntimeSessionIds(input.project_id, input.agent_profile_id), ["matching"]);
  assert.deepEqual(capabilityPairRuntimeSessionIds("unknown-project", input.agent_profile_id), []);
});

test("pair projection contains association revision and no tuple evidence", () => {
  const input = pair();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const projectionPath = getWorkspaceCapabilityStoreProjectionPath(input);
  const projection = fs.readFileSync(projectionPath, "utf8");
  assert.match(projection, /"association_revision": 1/);
  assert.equal(projection.includes("provider"), false);
  assert.equal(projection.includes("model"), false);
  assert.equal(projection.includes("operation_digest"), false);
  assert.equal(projection.includes("workspaceCapabilityApprovalEvents"), false);
});

test("missing legacy eligibility state and quarantine fail closed", () => {
  const base = {
    id: "legacy", pi_session_file: null, title: "Legacy", cwd: projectRoot, provider: "p", model: "m",
    agent_profile_id: "profile", pending_agent_switch: null,
    created_at: 1, last_active: 1, archived: 0, archived_at: null, goal: null, goal_status: null,
    scheduled_job_id: null, scheduled_run_id: null, error: null,
  } satisfies SessionRow;
  assert.equal(isSessionCapabilityEligible(base), false);
  assert.equal(isSessionCapabilityEligible({ ...base, legacy_private_session_quarantine: false, legacy_capability_ineligible: false }), true);
  assert.equal(isSessionCapabilityEligible({ ...base, legacy_private_session_quarantine: true, legacy_capability_ineligible: true }), false);
});

test("schema-1 migration creates zero positive authority and removes subject authority fields", () => {
  init();
  createProject({ cwd: projectRoot });
  const initial = structuredClone(getStore()) as unknown as Record<string, unknown>;
  const defaultProfileId = (initial.workspaceSettings as { default_agent_profile_id: string }).default_agent_profile_id;
  close();
  delete initial.workspaceSettings;
  delete initial.workspaceCapabilityAssociations;
  delete initial.workspaceCapabilityApprovalEvents;
  delete initial.protectedAutomationJobs;
  delete initial.protectedAutomationRuns;
  initial.schema_version = 1;
  initial.agentProfiles = (initial.agentProfiles as Array<Record<string, unknown>>).map((profile) => ({
    ...profile, name: "Finance", capability_grants: [{ provider: "legacy", model: "legacy", active: true }], authorization_revision: 99,
  }));
  initial.projects = (initial.projects as Array<Record<string, unknown>>).map((project) => ({
    ...project, capability_grants: [{ provider: "legacy", model: "legacy", active: true }], authorization_revision: 99,
  }));
  initial.sessions = [{
    id: "private-legacy", pi_session_file: null, title: "Private legacy", cwd: projectRoot,
    provider: "legacy-provider", model: "legacy-model", agent_profile_id: defaultProfileId,
    pending_agent_switch: null, finance_private_data_taint: true, created_at: 1, last_active: 1,
    archived: 0, archived_at: null, goal: null, goal_status: null, scheduled_job_id: null,
    scheduled_run_id: null, error: null,
  }];
  fs.writeFileSync(path.join(dataDir, "store.json"), JSON.stringify(initial), { mode: 0o600 });

  init();
  const migrated = getStore();
  assert.equal(migrated.schema_version, 3);
  assert.deepEqual(migrated.workspaceCapabilityAssociations, []);
  assert.deepEqual(migrated.workspaceCapabilityApprovalEvents, []);
  assert.deepEqual(migrated.protectedAutomationJobs, []);
  assert.deepEqual(migrated.protectedAutomationRuns, []);
  assert.ok(migrated.agentProfiles.every((profile) => !("capability_grants" in profile) && !("authorization_revision" in profile)));
  assert.ok(migrated.projects.every((project) => !("capability_grants" in project) && !("authorization_revision" in project)));
  assert.equal(migrated.sessions[0]!.legacy_private_session_quarantine, true);
  assert.equal(migrated.sessions[0]!.legacy_capability_ineligible, true);
  assert.equal("finance_private_data_taint" in migrated.sessions[0]!, false);
});

test("active orphan rows fail validation while inactive orphan rows survive restart", () => {
  const input = pair();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  close();
  const storePath = path.join(dataDir, "store.json");
  const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as Record<string, unknown>;
  (raw.projects as unknown[]) = [];
  fs.writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });
  assert.throws(() => init(), /active orphan workspace capability association/);
  close();

  const association = (raw.workspaceCapabilityAssociations as Array<Record<string, unknown>>)[0]!;
  association.active = false;
  association.revision = 2;
  association.revoked_at = association.updated_at = Number(association.approved_at) + 1;
  fs.writeFileSync(storePath, JSON.stringify(raw), { mode: 0o600 });
  init();
  assert.equal(getStore().workspaceCapabilityAssociations[0]!.active, false);
});
