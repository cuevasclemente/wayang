import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import {
  close,
  failNextHostExecutionPositiveProjectionForTests,
  flush,
  getStore,
  getWorkspaceCapabilityStoreProjectionPath,
  init,
  MAX_HOST_EXECUTION_QUESTIONNAIRE_SUBMISSIONS,
  observeNextHostExecutionProjectionDenialForTests,
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
import { createOpenInterview, markDelivered, submitInterview } from "./interviews.js";
import { WAYANG_WEBSOCKET_SUBMISSION_CONTEXT } from "./interview-provenance.js";

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

function syntheticSession(input: {
  id: string;
  projectId: string;
  profileId: string;
  cwd?: string;
  quarantined?: boolean;
}): SessionRow {
  return {
    id: input.id,
    pi_session_file: null,
    title: `Synthetic ${input.id}`,
    title_source: "explicit",
    cwd: input.cwd ?? projectRoot,
    project_id: input.projectId,
    provider: "synthetic-provider",
    model: "synthetic-model",
    agent_profile_id: input.profileId,
    pending_agent_switch: null,
    legacy_private_session_quarantine: input.quarantined ?? false,
    legacy_capability_ineligible: input.quarantined ?? false,
    created_at: 1,
    last_active: 1,
    archived: 0,
    archived_at: null,
    goal: null,
    goal_status: null,
    scheduled_job_id: null,
    scheduled_run_id: null,
    error: null,
  };
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

test("resolver derives authority from exact project privacy and enabled allowed profile", () => {
  const input = pair();
  const authorized = resolveWorkspaceCapability(input);
  assert.equal(authorized.authorized, true);
  if (!authorized.authorized) return;
  const derivedRevision = authorized.association.revision;
  assert.ok(Number.isSafeInteger(derivedRevision) && derivedRevision > 0);
  assert.equal(Object.isFrozen(authorized), true);
  assert.equal(Object.isFrozen(authorized.association), true);
  assert.equal(getStore().workspaceCapabilityAssociations.length, 0);
  updateProject(input.project_id, { default_provider: "other-provider", default_model: "other-model" });
  updateAgentProfile(input.agent_profile_id, { default_provider: "third-provider", default_model: "third-model" });
  const afterDefaults = resolveWorkspaceCapability(input);
  assert.equal(afterDefaults.authorized, true);
  if (afterDefaults.authorized) assert.equal(afterDefaults.association.revision, derivedRevision);
  assert.equal(resolveWorkspaceCapability({ ...input, provider: "fluid", model: "fluid" } as never).authorized, true);
  assert.equal(resolveCurrentWorkspaceCapabilityWitness(authorized).authorized, true);
});

test("privacy directly selects the complete Standard and Protected authority sets", () => {
  const input = pair();
  for (const capability_id of [
    "wayang.standard-resources.v1",
    "wayang.standard-browser.v1",
    "wayang.host-execution.v1",
  ] as const) {
    assert.equal(resolveWorkspaceCapability({ ...input, capability_id }).authorized, true, capability_id);
  }
  for (const capability_id of ["wayang.protected-browser.v1", "wayang.protected-automation.v1"] as const) {
    assert.deepEqual(resolveWorkspaceCapability({ ...input, capability_id }), {
      authorized: false,
      reason: "incompatible_privacy_mode",
    });
  }
  updateProject(input.project_id, {
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [input.agent_profile_id] },
  });
  for (const capability_id of ["wayang.protected-browser.v1", "wayang.protected-automation.v1"] as const) {
    assert.equal(resolveWorkspaceCapability({ ...input, capability_id }).authorized, true, capability_id);
  }
  for (const capability_id of [
    "wayang.standard-resources.v1",
    "wayang.standard-browser.v1",
    "wayang.host-execution.v1",
  ] as const) {
    assert.deepEqual(resolveWorkspaceCapability({ ...input, capability_id }), {
      authorized: false,
      reason: "incompatible_privacy_mode",
    });
  }
});

test("legacy revocation and reactivation rows are inert to derived authority", () => {
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
    const current = resolveCurrentWorkspaceCapabilityWitness(firstWitness);
    assert.equal(current.authorized, true);
    if (current.authorized) assert.equal(current.association.revision, firstWitness.association.revision);
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

test("profile edits preserve derived authority while disable and reenable remove and restore it", () => {
  const input = pair();
  const before = resolveWorkspaceCapability(input);
  assert.equal(before.authorized, true);
  const association = commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  updateAgentProfile(input.agent_profile_id, { name: "Renamed", instructions: "changed", memory_access: "read" });
  assert.equal(resolveWorkspaceCapability(input).authorized, true);

  const replacement = createAgentProfile({ name: "Default replacement" });
  updateProject(input.project_id, { default_agent_profile_id: replacement.id, access_policy: {
    privacy_mode: "standard",
    allowed_agent_profile_ids: [input.agent_profile_id, replacement.id],
  } });
  const beforeDisable = resolveWorkspaceCapability(input);
  const expectedRestoredRevision = beforeDisable.authorized ? beforeDisable.association.revision : 0;
  updateAgentProfile(input.agent_profile_id, { enabled: false });
  assert.deepEqual(resolveWorkspaceCapability(input), { authorized: false, reason: "profile_disabled" });
  assert.deepEqual(getStore().workspaceCapabilityAssociations[0], association);
  flush(); // active association plus disabled subject is a valid durable denial state
  updateAgentProfile(input.agent_profile_id, { enabled: true });
  const restored = resolveWorkspaceCapability(input);
  assert.equal(restored.authorized, true);
  if (restored.authorized) assert.equal(restored.association.revision, expectedRestoredRevision);
  assert.equal(getStore().workspaceCapabilityAssociations[0]?.revision, association.revision, "legacy row remains inert");
});

test("allowlist mutation denies excluded pairs and widening restores derived authority", () => {
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
  assert.equal(
    resolveWorkspaceCapability({ ...input, agent_profile_id: second.id }).authorized,
    true,
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
  assert.deepEqual(resolveWorkspaceCapability(input), { authorized: false, reason: "incompatible_privacy_mode" });
  assert.equal(resolveWorkspaceCapability({ ...input, capability_id: "wayang.protected-browser.v1" }).authorized, true);
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
  assert.equal(resolveWorkspaceCapability({ ...input, agent_profile_id: replacement.id }).authorized, true);
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
  assert.equal(resolveWorkspaceCapability({ ...input, project_id: replacement.id }).authorized, true);
  flush();
});

test("pair runtime query resolves cwd from immutable Project ID", () => {
  const input = pair();
  const store = getStore();
  store.sessions.push({
    id: "matching", pi_session_file: null, title: "Matching", title_source: "explicit", cwd: projectRoot, project_id: input.project_id, provider: "p", model: "m",
    agent_profile_id: input.agent_profile_id, pending_agent_switch: null,
    legacy_private_session_quarantine: false, legacy_capability_ineligible: false,
    created_at: 1, last_active: 1, archived: 0, archived_at: null, goal: null, goal_status: null,
    scheduled_job_id: null, scheduled_run_id: null, error: null,
  });
  store.sessions.push({
    id: "wrong-profile", pi_session_file: null, title: "Wrong", title_source: "explicit", cwd: projectRoot, project_id: input.project_id, provider: "p", model: "m",
    agent_profile_id: getStore().workspaceSettings.default_agent_profile_id, pending_agent_switch: null,
    legacy_private_session_quarantine: false, legacy_capability_ineligible: false,
    created_at: 1, last_active: 1, archived: 0, archived_at: null, goal: null, goal_status: null,
    scheduled_job_id: null, scheduled_run_id: null, error: null,
  });
  assert.deepEqual(capabilityPairRuntimeSessionIds(input.project_id, input.agent_profile_id), ["matching"]);
  assert.deepEqual(capabilityPairRuntimeSessionIds("unknown-project", input.agent_profile_id), []);
});

test("pair projection contains derived-authority revision and no provider/model evidence", () => {
  const input = pair();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const projectionPath = getWorkspaceCapabilityStoreProjectionPath(input);
  const projection = fs.readFileSync(projectionPath, "utf8");
  const authority = resolveWorkspaceCapability(input);
  assert.equal(authority.authorized, true);
  assert.match(projection, new RegExp(`"association_revision": ${authority.authorized ? authority.association.revision : -1}`));
  assert.equal(projection.includes("provider"), false);
  assert.equal(projection.includes("model"), false);
  assert.equal(projection.includes("operation_digest"), false);
  assert.equal(projection.includes("workspaceCapabilityApprovalEvents"), false);
});

test("host pair projection includes only canonical pair-owned questionnaire submissions and exact provenance", () => {
  const input = pair();
  const otherRoot = path.join(projectRoot, "unrelated-project");
  fs.mkdirSync(otherRoot);
  const otherProject = createProject({
    cwd: otherRoot,
    default_agent_profile_id: input.agent_profile_id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [input.agent_profile_id] },
  });
  const otherProfile = createAgentProfile({ name: "Unrelated profile" });
  getStore().sessions.push(
    syntheticSession({ id: "pair-a", projectId: input.project_id, profileId: input.agent_profile_id }),
    syntheticSession({ id: "pair-z", projectId: input.project_id, profileId: input.agent_profile_id }),
    syntheticSession({ id: "wrong-project", projectId: otherProject.id, profileId: input.agent_profile_id, cwd: otherRoot }),
    syntheticSession({ id: "wrong-profile", projectId: input.project_id, profileId: otherProfile.id }),
    syntheticSession({ id: "quarantined", projectId: input.project_id, profileId: input.agent_profile_id, quarantined: true }),
  );
  flush();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });

  const questions = [{
    id: "scope",
    label: "Scope",
    prompt: "Choose the synthetic scope",
    options: [
      { value: "small", label: "Small", description: "Synthetic small option" },
      { value: "large", label: "Large" },
    ],
    allowOther: true,
  }];
  const createAndSubmit = (requestId: string, sessionId: string, value = "small", wasCustom = false) => {
    createOpenInterview({
      requestId,
      sessionId,
      toolName: "questionnaire",
      toolCallId: `call-${requestId}`,
      questions,
    });
    const result = submitInterview(sessionId, requestId, [{ id: "scope", value, wasCustom }], WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
    assert.equal(result.ok, true);
    return result;
  };
  createAndSubmit("z-request", "pair-z");
  const custom = createAndSubmit("a-request", "pair-a", "Synthetic custom answer", true);
  assert.equal(custom.ok, true);
  markDelivered("z-request", "tool_result", "entry-z");
  createAndSubmit("wrong-project-request", "wrong-project");
  createAndSubmit("wrong-profile-request", "wrong-profile");
  createAndSubmit("quarantined-request", "quarantined");
  createOpenInterview({ requestId: "open-request", sessionId: "pair-a", toolName: "questionnaire", questions });
  createOpenInterview({ requestId: "non-questionnaire", sessionId: "pair-a", toolName: "interview", questions });
  assert.equal(submitInterview(
    "pair-a",
    "non-questionnaire",
    [{ id: "scope", value: "large", wasCustom: false }],
    WAYANG_WEBSOCKET_SUBMISSION_CONTEXT,
  ).ok, true);

  for (const requestId of ["z-request", "a-request"]) {
    const record = getStore().interviews.find((candidate) => candidate.request_id === requestId)!;
    record.created_at = 10;
    record.submitted_at = 20;
    if (record.status === "delivered") record.delivered_at = 30;
  }
  flush();

  const projectionPath = getWorkspaceCapabilityStoreProjectionPath(input);
  const projection = JSON.parse(fs.readFileSync(projectionPath, "utf8")) as Record<string, any>;
  assert.equal(fs.statSync(projectionPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(projectionPath)).mode & 0o777, 0o700);
  assert.equal(projection.schema_version, 3);
  assert.equal(projection.questionnaire_submissions.schema_version, 1);
  assert.equal(projection.questionnaire_submissions.available, true);
  assert.deepEqual(
    projection.questionnaire_submissions.records.map((record: Record<string, unknown>) => record.request_id),
    ["a-request", "z-request"],
  );
  const [customProjection, deliveredProjection] = projection.questionnaire_submissions.records;
  assert.deepEqual(Object.keys(customProjection).sort(), [
    "answers", "authenticated_principal", "created_at", "origin_tool_call_id", "origin_tool_name",
    "questions", "request_id", "session_id", "status", "submission_channel", "submission_id", "submitted_at",
  ].sort());
  assert.equal(customProjection.session_id, "pair-a");
  assert.equal(customProjection.origin_tool_name, "questionnaire");
  assert.equal(customProjection.origin_tool_call_id, "call-a-request");
  assert.equal(customProjection.status, "submitted");
  assert.equal(customProjection.created_at, 10);
  assert.equal(customProjection.submitted_at, 20);
  assert.equal(customProjection.submission_channel, "WAYANG_WEBSOCKET");
  assert.equal(customProjection.authenticated_principal, "WAYANG_SINGLE_USER");
  assert.equal(typeof customProjection.submission_id, "string");
  assert.deepEqual(customProjection.answers, [{
    id: "scope",
    value: "Synthetic custom answer",
    label: "Synthetic custom answer",
    wasCustom: true,
  }]);
  assert.deepEqual(deliveredProjection.answers, [{ id: "scope", value: "small", label: "Small", wasCustom: false, index: 0 }]);
  assert.equal(deliveredProjection.delivery_mode, "tool_result");
  assert.equal(deliveredProjection.delivery_entry_id, "entry-z");
  assert.equal(deliveredProjection.delivered_at, 30);
  assert.deepEqual(deliveredProjection.questions, [{ ...questions[0], allowOther: true }]);
  const questionnaireBytes = JSON.stringify(projection.questionnaire_submissions);
  for (const excluded of [
    "wrong-project-request", "wrong-profile-request", "quarantined-request", "open-request", "non-questionnaire",
    "synthetic-provider", "synthetic-model", "operation_digest", "project_id", "agent_profile_id",
  ]) assert.equal(questionnaireBytes.includes(excluded), false, excluded);

  const browserInput = { ...input, capability_id: "wayang.standard-browser.v1" as const };
  commitWorkspaceCapabilityActivation({ ...browserInput, operation_digest: digest("b") });
  const browserProjection = fs.readFileSync(getWorkspaceCapabilityStoreProjectionPath(browserInput), "utf8");
  assert.equal(browserProjection.includes("questionnaire_submissions"), false);
  assert.equal(browserProjection.includes("a-request"), false);

  revokeWorkspaceCapabilityAssociation({ ...input, expected_revision: 1 });
  const afterLegacyRevoke = JSON.parse(fs.readFileSync(projectionPath, "utf8")) as Record<string, any>;
  assert.equal(afterLegacyRevoke.schema_version, 3);
  assert.equal(afterLegacyRevoke.active, true);
  assert.equal(afterLegacyRevoke.available, true);
  assert.equal(JSON.stringify(afterLegacyRevoke).includes("a-request"), true,
    "legacy row revocation does not alter derived host authority");
});

test("host questionnaire projection fails closed for noncanonical provenance and bounded saturation", () => {
  const input = pair();
  getStore().sessions.push(syntheticSession({ id: "owner", projectId: input.project_id, profileId: input.agent_profile_id }));
  flush();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const questions = [{
    id: "q",
    label: "Question",
    prompt: "Synthetic question?",
    options: [{ value: "yes", label: "Yes" }],
    allowOther: true,
  }];
  const answer = [{ id: "q", value: "yes", label: "Yes", wasCustom: false, index: 0 }];
  getStore().interviews.push({
    request_id: "legacy-provenance",
    submission_id: "legacy-submission",
    session_id: "owner",
    origin_tool_name: "questionnaire",
    origin_tool_call_id: "legacy-call",
    questions,
    answers: answer,
    status: "submitted",
    created_at: 1,
    submitted_at: 2,
  });
  flush();
  const projectionPath = getWorkspaceCapabilityStoreProjectionPath(input);
  let projection = JSON.parse(fs.readFileSync(projectionPath, "utf8")) as Record<string, any>;
  assert.deepEqual(projection.questionnaire_submissions, { schema_version: 1, available: false, records: [] });

  getStore().interviews = [];
  for (let index = 0; index <= MAX_HOST_EXECUTION_QUESTIONNAIRE_SUBMISSIONS; index += 1) {
    getStore().interviews.push({
      request_id: `bounded-${String(index).padStart(3, "0")}`,
      submission_id: `submission-${index}`,
      submission_channel: "WAYANG_WEBSOCKET",
      authenticated_principal: "WAYANG_SINGLE_USER",
      session_id: "owner",
      origin_tool_name: "questionnaire",
      origin_tool_call_id: `call-${index}`,
      questions,
      answers: answer,
      status: "submitted",
      created_at: index + 1,
      submitted_at: index + 2,
    });
  }
  flush();
  projection = JSON.parse(fs.readFileSync(projectionPath, "utf8")) as Record<string, any>;
  assert.deepEqual(projection.questionnaire_submissions, { schema_version: 1, available: false, records: [] });
});

test("host questionnaire projection fails closed on aggregate byte overflow", () => {
  const input = pair();
  getStore().sessions.push(syntheticSession({ id: "owner", projectId: input.project_id, profileId: input.agent_profile_id }));
  flush();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const prompt = "x".repeat(16_000);
  const questions = [{
    id: "q",
    label: "Question",
    prompt,
    options: [{ value: "yes", label: "Yes" }],
    allowOther: true,
  }];
  for (let index = 0; index < 80; index += 1) {
    getStore().interviews.push({
      request_id: `bytes-${String(index).padStart(3, "0")}`,
      submission_id: `bytes-submission-${index}`,
      submission_channel: "WAYANG_WEBSOCKET",
      authenticated_principal: "WAYANG_SINGLE_USER",
      session_id: "owner",
      origin_tool_name: "questionnaire",
      origin_tool_call_id: `bytes-call-${index}`,
      questions,
      answers: [{ id: "q", value: "yes", label: "Yes", wasCustom: false, index: 0 }],
      status: "submitted",
      created_at: index + 1,
      submitted_at: index + 2,
    });
  }
  flush();
  const projection = JSON.parse(fs.readFileSync(getWorkspaceCapabilityStoreProjectionPath(input), "utf8"));
  assert.deepEqual(projection.questionnaire_submissions, { schema_version: 1, available: false, records: [] });
});

test("host questionnaire publication is denial-first and positive failure leaves durable denial", () => {
  const input = pair();
  getStore().sessions.push(syntheticSession({ id: "owner", projectId: input.project_id, profileId: input.agent_profile_id }));
  flush();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const questions = [{
    id: "q", label: "Question", prompt: "Synthetic question?",
    options: [{ value: "yes", label: "Yes" }], allowOther: true,
  }];
  const first = createOpenInterview({ requestId: "first", sessionId: "owner", toolName: "questionnaire", questions });
  assert.equal(submitInterview("owner", first.request_id, [{ id: "q", value: "yes", wasCustom: false }], WAYANG_WEBSOCKET_SUBMISSION_CONTEXT).ok, true);
  const projectionPath = getWorkspaceCapabilityStoreProjectionPath(input);
  assert.equal(JSON.parse(fs.readFileSync(projectionPath, "utf8")).questionnaire_submissions.records.length, 1);

  const second = createOpenInterview({ requestId: "second", sessionId: "owner", toolName: "questionnaire", questions });
  let observedDenial = false;
  observeNextHostExecutionProjectionDenialForTests(() => {
    const denied = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
    observedDenial = denied.available === false && !("questionnaire_submissions" in denied);
  });
  failNextHostExecutionPositiveProjectionForTests();
  const submitted = submitInterview("owner", second.request_id, [{ id: "q", value: "yes", wasCustom: false }], WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
  assert.equal(submitted.ok, true);
  assert.equal(observedDenial, true);
  const denied = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  assert.equal(denied.available, false);
  assert.equal("questionnaire_submissions" in denied, false);

  flush();
  const recovered = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  assert.equal(recovered.available, true);
  assert.deepEqual(recovered.questionnaire_submissions.records.map((record: any) => record.request_id), ["first", "second"]);
});

test("startup denial-first rebuild removes stale positive questionnaire evidence", () => {
  const input = pair();
  getStore().sessions.push(syntheticSession({ id: "owner", projectId: input.project_id, profileId: input.agent_profile_id }));
  flush();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const questions = [{
    id: "q", label: "Question", prompt: "Synthetic question?",
    options: [{ value: "yes", label: "Yes" }], allowOther: true,
  }];
  const opened = createOpenInterview({ requestId: "stale", sessionId: "owner", toolName: "questionnaire", questions });
  assert.equal(submitInterview("owner", opened.request_id, [{ id: "q", value: "yes", wasCustom: false }], WAYANG_WEBSOCKET_SUBMISSION_CONTEXT).ok, true);
  const projectionPath = getWorkspaceCapabilityStoreProjectionPath(input);
  assert.equal(JSON.parse(fs.readFileSync(projectionPath, "utf8")).questionnaire_submissions.records.length, 1);

  close();
  const storePath = path.join(dataDir, "store.json");
  const persisted = JSON.parse(fs.readFileSync(storePath, "utf8"));
  persisted.interviews = [];
  fs.writeFileSync(storePath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
  init();
  const rebuilt = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  assert.equal(rebuilt.available, true);
  assert.deepEqual(rebuilt.questionnaire_submissions.records, []);
});

test("derived projection tracks profile and session eligibility changes", () => {
  const input = pair();
  getStore().sessions.push(syntheticSession({ id: "owner", projectId: input.project_id, profileId: input.agent_profile_id }));
  flush();
  commitWorkspaceCapabilityActivation({ ...input, operation_digest: digest() });
  const questions = [{
    id: "q", label: "Question", prompt: "Synthetic question?",
    options: [{ value: "yes", label: "Yes" }], allowOther: true,
  }];
  const opened = createOpenInterview({ requestId: "eligibility", sessionId: "owner", toolName: "questionnaire", questions });
  assert.equal(submitInterview("owner", opened.request_id, [{ id: "q", value: "yes", wasCustom: false }], WAYANG_WEBSOCKET_SUBMISSION_CONTEXT).ok, true);
  const projectionPath = getWorkspaceCapabilityStoreProjectionPath(input);
  const initialAuthority = resolveWorkspaceCapability(input);
  assert.equal(JSON.parse(fs.readFileSync(projectionPath, "utf8")).association_revision,
    initialAuthority.authorized ? initialAuthority.association.revision : -1);

  const replacementDefault = createAgentProfile({ name: "Replacement default", resource_mode: "standard" });
  getStore().workspaceSettings.default_agent_profile_id = replacementDefault.id;
  updateProject(input.project_id, {
    default_agent_profile_id: replacementDefault.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
  });
  updateAgentProfile(input.agent_profile_id, { enabled: false });
  let projection = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  assert.equal(projection.association_revision, 1);
  assert.equal(projection.available, false);
  updateAgentProfile(input.agent_profile_id, { enabled: true });
  projection = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  const restoredAuthority = resolveWorkspaceCapability(input);
  assert.equal(projection.association_revision,
    restoredAuthority.authorized ? restoredAuthority.association.revision : -1);
  assert.equal(projection.questionnaire_submissions.records.length, 1);

  getStore().sessions.find((session) => session.id === "owner")!.legacy_capability_ineligible = true;
  flush();
  projection = JSON.parse(fs.readFileSync(projectionPath, "utf8"));
  assert.equal(projection.association_revision,
    restoredAuthority.authorized ? restoredAuthority.association.revision : -1);
  assert.deepEqual(projection.questionnaire_submissions.records, []);
});

test("missing legacy eligibility state and quarantine fail closed", () => {
  const base = {
    id: "legacy", pi_session_file: null, title: "Legacy", title_source: "legacy_unknown", cwd: projectRoot, provider: "p", model: "m",
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
  delete initial.transcriptRecoveryJournal;
  delete initial.protectedAutomationJobs;
  delete initial.protectedAutomationRuns;
  delete initial.messagingEndpoints;
  delete initial.messagingEvents;
  delete initial.messagingTransactions;
  delete initial.messagingDeliveries;
  delete initial.browserProfiles;
  delete initial.projectBrowserDefaults;
  delete initial.sessionBrowserStates;
  delete initial.browserCleanups;
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
  }, {
    id: "blank-legacy", pi_session_file: null, title: " \n\t ", cwd: projectRoot,
    provider: null, model: null, agent_profile_id: defaultProfileId,
    pending_agent_switch: null, finance_private_data_taint: false, created_at: 1, last_active: 1,
    archived: 0, archived_at: null, goal: null, goal_status: null, scheduled_job_id: null,
    scheduled_run_id: null, error: null,
  }];
  fs.writeFileSync(path.join(dataDir, "store.json"), JSON.stringify(initial), { mode: 0o600 });

  init();
  const migrated = getStore();
  assert.equal(migrated.schema_version, 8);
  assert.deepEqual(migrated.workspaceCapabilityAssociations, []);
  assert.deepEqual(migrated.workspaceCapabilityApprovalEvents, []);
  assert.deepEqual(migrated.protectedAutomationJobs, []);
  assert.deepEqual(migrated.protectedAutomationRuns, []);
  assert.deepEqual(migrated.messagingEndpoints, []);
  assert.deepEqual(migrated.messagingEvents, []);
  assert.deepEqual(migrated.transcriptRecoveryJournal, []);
  assert.ok(migrated.agentProfiles.every((profile) => !("capability_grants" in profile) && !("authorization_revision" in profile)));
  assert.ok(migrated.projects.every((project) => !("capability_grants" in project) && !("authorization_revision" in project)));
  assert.equal(migrated.sessions[0]!.title_source, "legacy_unknown");
  assert.equal(migrated.sessions[1]!.title_source, "provisional");
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
