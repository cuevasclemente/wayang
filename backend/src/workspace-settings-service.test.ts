import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, failNextCommitStoreMutationPersistenceForTests, getStore, init } from "./db.js";
import { createAgentProfile } from "./agent-profiles.js";
import {
  createOpenInterview,
  getInterviewForSession,
  submitInterview,
} from "./interviews.js";
import { WAYANG_WEBSOCKET_SUBMISSION_CONTEXT } from "./interview-provenance.js";
import { createProject, deleteProjectRegistration, getProject, getProjectRegistrationReferences } from "./projects.js";
import { createSession } from "./sessions.js";
import { lockRuntimeMutationSession, unlockRuntimeMutationSession } from "./pi-bridge.js";
import { WorkspaceSettingsService, type WorkspaceCapabilityInvalidationPort } from "./workspace-settings-service.js";
import { commitWorkspaceCapabilityActivation } from "./workspace-capabilities.js";
import {
  canonicalizeWorkspaceMutation,
  WORKSPACE_APPROVAL_TTL_MS,
  workspaceApprovalQuestion,
  workspaceOperationDigest,
  workspaceSha256,
  type WorkspaceApprovalPreview,
  type WorkspaceMutationEnvelope,
} from "./workspace-control.js";

function fixture(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const sourceCwd = path.join(dir, "source");
  fs.mkdirSync(sourceCwd);
  const previousData = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  init();
  const managementProfile = createAgentProfile({ name: "Generic Management", resource_mode: "standard" });
  const sourceProject = createProject({ cwd: sourceCwd, default_agent_profile_id: managementProfile.id });
  const source = createSession(sourceCwd, { agentProfileId: managementProfile.id });
  return {
    dir,
    sourceCwd,
    sourceProject,
    source,
    managementProfile,
    cleanup() {
      close();
      if (previousData === undefined) delete process.env.WAYANG_DATA_DIR;
      else process.env.WAYANG_DATA_DIR = previousData;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function fabricatedProfileCreatePreview(sourceSessionId: string, name: string, expiresAt: string): WorkspaceApprovalPreview {
  const canonical = canonicalizeWorkspaceMutation({ mutation_type: "agent_profile_create", mutation: { name } });
  assert.equal(canonical.mutation_type, "agent_profile_create");
  if (canonical.mutation_type !== "agent_profile_create") throw new Error("unexpected synthetic mutation type");
  const precondition = {
    kind: "profile_name_absent",
    sha256: workspaceSha256({ casefold_name: name.toLowerCase(), existing_profile_id: null }),
  };
  const instructionHash = workspaceSha256("");
  const summary = `create restricted agent profile ${name} (project_only, memory none, instruction bytes 0, instruction sha256 ${instructionHash})`;
  const envelope: WorkspaceMutationEnvelope = {
    schema_version: 1,
    source_session_id: sourceSessionId,
    mutation_type: canonical.mutation_type,
    mutation: canonical.mutation,
    precondition,
    expires_at: expiresAt,
  };
  const operationDigest = workspaceOperationDigest(envelope);
  return {
    mutation_type: canonical.mutation_type,
    summary,
    target: { label: name },
    precondition_sha256: precondition.sha256,
    operation_digest: operationDigest,
    expires_at: expiresAt,
    questionnaire: workspaceApprovalQuestion({ digest: operationDigest, summary, sourceSessionId, expiresAt }),
  };
}

function approve(sessionId: string, preview: ReturnType<WorkspaceSettingsService["previewAgentMutation"]>, requestId: string, custom = false) {
  createOpenInterview({
    requestId,
    sessionId,
    toolName: "questionnaire",
    questions: preview.questionnaire,
  });
  const submitted = submitInterview(sessionId, requestId, [{
    id: preview.questionnaire[0]!.id,
    value: "APPROVE",
    wasCustom: custom,
  }], WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
  assert.equal(submitted.ok, true);
  if (!submitted.ok) throw new Error("synthetic approval was not accepted");
  return submitted.record.submission_id!;
}

test("exact server-issued preview and WebSocket approval succeeds, is redacted, and replay fails", async () => {
  const f = fixture("wayang-workspace-approval-");
  try {
    const service = new WorkspaceSettingsService();
    const privateText = "SYNTHETIC_PRIVATE_PROFILE_INSTRUCTIONS_DO_NOT_PROMPT";
    const proposal = {
      mutation_type: "agent_profile_create",
      mutation: {
        name: "Synthetic Restricted",
        description: "Synthetic profile",
        resource_mode: "project_only",
        instructions: privateText,
        memory_access: "read",
        default_provider: null,
        default_model: null,
      },
    };
    const preview = service.previewAgentMutation(f.source.id, proposal);
    const serializedPreview = JSON.stringify(preview);
    assert.equal(serializedPreview.includes(privateText), false);
    assert.match(preview.summary, /instruction bytes/);
    assert.match(preview.summary, /instruction sha256/);

    const submissionId = approve(f.source.id, preview, "approved-create");
    const committed = await service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "approved-create",
      submissionId,
      expiresAt: preview.expires_at,
    }) as any;
    assert.equal(JSON.stringify(committed).includes(privateText), false);
    assert.equal(committed.mutation_type, "agent_profile_create");
    const created = getStore().agentProfiles.find((profile) => profile.name === "Synthetic Restricted" && profile.instructions === privateText)!;
    const listed = service.read(f.source.id, { action: "list_agent_profiles" });
    assert.equal(JSON.stringify(listed).includes(privateText), false);
    const detailed = service.read(f.source.id, { action: "get_agent_profile", id: created.id }) as any;
    assert.equal(detailed.instructions, privateText);

    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "approved-create",
      submissionId,
      expiresAt: preview.expires_at,
    }), /already exists/);
  } finally { f.cleanup(); }
});

test("transient runtime conflict retains exact issuance for a later successful retry", async () => {
  const f = fixture("wayang-workspace-preview-retry-");
  try {
    const service = new WorkspaceSettingsService();
    const proposal = {
      mutation_type: "project_update",
      mutation: { id: f.sourceProject.id, updates: { description: "approved after transient conflict" } },
    };
    const preview = service.previewAgentMutation(f.source.id, proposal);
    const submissionId = approve(f.source.id, preview, "runtime-conflict-retry");
    assert.equal(lockRuntimeMutationSession(f.source.id), true);
    try {
      await assert.rejects(() => service.commitAgentMutation({
        sourceSessionId: f.source.id,
        raw: proposal,
        requestId: "runtime-conflict-retry",
        submissionId,
        expiresAt: preview.expires_at,
      }), /active|conflict|change/);
    } finally {
      unlockRuntimeMutationSession(f.source.id);
    }

    await service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "runtime-conflict-retry",
      submissionId,
      expiresAt: preview.expires_at,
    });
    assert.equal(getProject(f.sourceProject.id)?.description, "approved after transient conflict");
  } finally {
    unlockRuntimeMutationSession(f.source.id);
    f.cleanup();
  }
});

test("fabricated exact questionnaire and WebSocket APPROVE fail without prior server preview issuance", async () => {
  const f = fixture("wayang-workspace-fabricated-preview-");
  try {
    const service = new WorkspaceSettingsService();
    const name = "Fabricated Profile";
    const proposal = { mutation_type: "agent_profile_create", mutation: { name } };
    const fabricated = fabricatedProfileCreatePreview(
      f.source.id,
      name,
      new Date(Date.now() + 9 * 60 * 1000).toISOString(),
    );
    const submissionId = approve(f.source.id, fabricated, "fabricated-preview");

    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "fabricated-preview",
      submissionId,
      expiresAt: fabricated.expires_at,
    }), /server-issued preview/);
    assert.equal(getStore().agentProfiles.some((profile) => profile.name === name), false);
  } finally { f.cleanup(); }
});

test("altered expiry fails even when its fabricated questionnaire has authoritative WebSocket approval", async () => {
  const f = fixture("wayang-workspace-altered-expiry-");
  try {
    const service = new WorkspaceSettingsService();
    const name = "Altered Expiry Profile";
    const proposal = { mutation_type: "agent_profile_create", mutation: { name } };
    const issued = service.previewAgentMutation(f.source.id, proposal, Date.now() - 1_000);
    const alteredExpiry = new Date(Date.parse(issued.expires_at) + 500).toISOString();
    const altered = fabricatedProfileCreatePreview(f.source.id, name, alteredExpiry);
    assert.notEqual(altered.operation_digest, issued.operation_digest);
    const submissionId = approve(f.source.id, altered, "altered-expiry");

    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "altered-expiry",
      submissionId,
      expiresAt: alteredExpiry,
    }), /server-issued preview/);
    assert.equal(getStore().agentProfiles.some((profile) => profile.name === name), false);
  } finally { f.cleanup(); }
});

test("preview issuance from a different service instance fails closed like a restart", async () => {
  const f = fixture("wayang-workspace-restart-preview-");
  try {
    const issuer = new WorkspaceSettingsService();
    const restarted = new WorkspaceSettingsService();
    const proposal = { mutation_type: "agent_profile_create", mutation: { name: "Restart Profile" } };
    const preview = issuer.previewAgentMutation(f.source.id, proposal);
    const submissionId = approve(f.source.id, preview, "restart-preview");

    await assert.rejects(() => restarted.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "restart-preview",
      submissionId,
      expiresAt: preview.expires_at,
    }), /server-issued preview/);
    assert.equal(getStore().agentProfiles.some((profile) => profile.name === "Restart Profile"), false);
  } finally { f.cleanup(); }
});

test("questionnaire created and submitted before exact preview issuance fails temporal binding", async () => {
  const f = fixture("wayang-workspace-pre-preview-approval-");
  try {
    const service = new WorkspaceSettingsService();
    const name = "Pre Preview Profile";
    const proposal = { mutation_type: "agent_profile_create", mutation: { name } };
    const issuedAt = Date.now() + 1_000;
    const expiresAt = new Date(issuedAt + WORKSPACE_APPROVAL_TTL_MS).toISOString();
    const predicted = fabricatedProfileCreatePreview(f.source.id, name, expiresAt);
    const submissionId = approve(f.source.id, predicted, "pre-preview-approval");
    const issued = service.previewAgentMutation(f.source.id, proposal, issuedAt);
    assert.equal(issued.operation_digest, predicted.operation_digest);

    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "pre-preview-approval",
      submissionId,
      expiresAt,
    }), /stale or expired/);
    assert.equal(getStore().agentProfiles.some((profile) => profile.name === name), false);
  } finally { f.cleanup(); }
});

test("custom APPROVE, cross-session approval, legacy provenance, and stale envelopes fail closed", async () => {
  const f = fixture("wayang-workspace-adversarial-");
  try {
    const service = new WorkspaceSettingsService();
    const other = createSession(f.sourceCwd, { agentProfileId: f.managementProfile.id });
    const proposal = { mutation_type: "agent_profile_create", mutation: { name: "Denied Profile" } };

    const customPreview = service.previewAgentMutation(f.source.id, proposal);
    const customSubmission = approve(f.source.id, customPreview, "custom-approve", true);
    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "custom-approve",
      submissionId: customSubmission,
      expiresAt: customPreview.expires_at,
    }), /predefined APPROVE/);

    const crossPreview = service.previewAgentMutation(f.source.id, proposal);
    const crossSubmission = approve(f.source.id, crossPreview, "cross-session");
    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: other.id,
      raw: proposal,
      requestId: "cross-session",
      submissionId: crossSubmission,
      expiresAt: crossPreview.expires_at,
    }), /server-issued preview|not submitted|does not match/);

    const mismatchedPreview = service.previewAgentMutation(f.source.id, proposal);
    approve(f.source.id, mismatchedPreview, "submission-mismatch");
    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "submission-mismatch",
      submissionId: "forged-submission-id",
      expiresAt: mismatchedPreview.expires_at,
    }), /submission does not match/);

    const changedQuestionPreview = service.previewAgentMutation(f.source.id, proposal);
    const changedQuestionSubmission = approve(f.source.id, changedQuestionPreview, "changed-question");
    const changedRecord = getStore().interviews.find((record) => record.request_id === "changed-question")!;
    (changedRecord.questions[0] as any).options.reverse();
    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "changed-question",
      submissionId: changedQuestionSubmission,
      expiresAt: changedQuestionPreview.expires_at,
    }), /question does not match/);

    const rejectPreview = service.previewAgentMutation(f.source.id, proposal);
    createOpenInterview({ requestId: "rejected", sessionId: f.source.id, toolName: "questionnaire", questions: rejectPreview.questionnaire });
    const rejected = submitInterview(f.source.id, "rejected", [{ id: rejectPreview.questionnaire[0]!.id, value: "REJECT", wasCustom: false }], WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
    assert.equal(rejected.ok, true);
    if (!rejected.ok) throw new Error("synthetic rejection was not stored");
    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "rejected",
      submissionId: rejected.record.submission_id!,
      expiresAt: rejectPreview.expires_at,
    }), /not approved/);

    const legacyPreview = service.previewAgentMutation(f.source.id, proposal);
    getStore().interviews.push({
      request_id: "legacy",
      submission_id: "legacy-submission",
      session_id: f.source.id,
      origin_tool_name: "questionnaire",
      questions: legacyPreview.questionnaire,
      answers: [{ id: legacyPreview.questionnaire[0]!.id, value: "APPROVE", label: "APPROVE", wasCustom: false, index: 0 }],
      status: "submitted",
      created_at: Date.now(),
      submitted_at: Date.now(),
    });
    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "legacy",
      submissionId: "legacy-submission",
      expiresAt: legacyPreview.expires_at,
    }), /provenance/);

    const stalePreview = service.previewAgentMutation(f.source.id, proposal, Date.now() - 2 * 10 * 60 * 1000);
    const staleSubmission = approve(f.source.id, stalePreview, "stale");
    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "stale",
      submissionId: staleSubmission,
      expiresAt: stalePreview.expires_at,
    }), /server-issued preview|stale or expired/);
  } finally { f.cleanup(); }
});

test("failed interview persistence publishes no submission ID, duplicate acknowledgement, or instruction authority", async () => {
  const f = fixture("wayang-workspace-interview-persistence-");
  try {
    const service = new WorkspaceSettingsService();
    const instructionPath = path.join(f.sourceCwd, "AGENTS.md");
    const proposal = {
      mutation_type: "project_instructions_write",
      mutation: { project_id: f.sourceProject.id, text: "synthetic durable instructions\n", expected_sha256: null, create_if_missing: true },
    };
    const preview = service.previewAgentMutation(f.source.id, proposal);
    createOpenInterview({ requestId: "failed-persistence", sessionId: f.source.id, toolName: "questionnaire", questions: preview.questionnaire });
    const answers = [{ id: preview.questionnaire[0]!.id, value: "APPROVE", wasCustom: false }];
    failNextCommitStoreMutationPersistenceForTests(new Error("synthetic interview persistence failure"));
    assert.throws(
      () => submitInterview(f.source.id, "failed-persistence", answers, WAYANG_WEBSOCKET_SUBMISSION_CONTEXT),
      /synthetic interview persistence failure/,
    );

    const retained = getInterviewForSession(f.source.id, "failed-persistence")!;
    assert.equal(retained.status, "open");
    assert.equal(retained.submission_id, undefined);
    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "failed-persistence",
      submissionId: "fabricated-after-failure",
      expiresAt: preview.expires_at,
    }), /not submitted/);
    assert.equal(fs.existsSync(instructionPath), false);

    const retry = submitInterview(f.source.id, "failed-persistence", answers, WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
    assert.equal(retry.ok, true);
    if (retry.ok) assert.equal(retry.kind, "accepted", "failed persistence must not be acknowledged as a duplicate");
  } finally {
    f.cleanup();
  }
});

test("changed state invalidates an approved update without exposing instruction text", async () => {
  const f = fixture("wayang-workspace-state-binding-");
  try {
    const service = new WorkspaceSettingsService();
    const proposal = {
      mutation_type: "project_update",
      mutation: { id: f.sourceProject.id, updates: { description: "first approved description" } },
    };
    const preview = service.previewAgentMutation(f.source.id, proposal);
    const submissionId = approve(f.source.id, preview, "state-change");
    const project = getStore().projects.find((candidate) => candidate.id === f.sourceProject.id)!;
    project.color = "changed-outside-preview";
    project.updated_at += 1;

    await assert.rejects(() => service.commitAgentMutation({
      sourceSessionId: f.source.id,
      raw: proposal,
      requestId: "state-change",
      submissionId,
      expiresAt: preview.expires_at,
    }), /server-issued preview|question does not match|state changed/);
    assert.equal(getProject(f.sourceProject.id)?.description, null);
  } finally { f.cleanup(); }
});

test("approved project and profile update/delete operations use shared repository semantics", async () => {
  const f = fixture("wayang-workspace-crud-");
  try {
    const service = new WorkspaceSettingsService();
    const profile = service.createAgentProfileForUi({ name: "CRUD Profile", instructions: "old synthetic text" });
    const profileUpdate = {
      mutation_type: "agent_profile_update",
      mutation: { id: profile.id, updates: { description: "updated", instructions: "new synthetic private text" } },
    };
    const profileUpdatePreview = service.previewAgentMutation(f.source.id, profileUpdate);
    assert.equal(JSON.stringify(profileUpdatePreview).includes("new synthetic private text"), false);
    const profileUpdateSubmission = approve(f.source.id, profileUpdatePreview, "crud-profile-update");
    await service.commitAgentMutation({ sourceSessionId: f.source.id, raw: profileUpdate, requestId: "crud-profile-update", submissionId: profileUpdateSubmission, expiresAt: profileUpdatePreview.expires_at });
    assert.equal(getStore().agentProfiles.find((row) => row.id === profile.id)?.instructions, "new synthetic private text");

    const profileDelete = { mutation_type: "agent_profile_delete", mutation: { id: profile.id } };
    const profileDeletePreview = service.previewAgentMutation(f.source.id, profileDelete);
    const profileDeleteSubmission = approve(f.source.id, profileDeletePreview, "crud-profile-delete");
    await service.commitAgentMutation({ sourceSessionId: f.source.id, raw: profileDelete, requestId: "crud-profile-delete", submissionId: profileDeleteSubmission, expiresAt: profileDeletePreview.expires_at });
    assert.equal(getStore().agentProfiles.some((row) => row.id === profile.id), false);

    const targetCwd = path.join(f.dir, "crud-project");
    fs.mkdirSync(targetCwd);
    const project = service.createProjectForUi({ cwd: targetCwd });
    const projectUpdate = { mutation_type: "project_update", mutation: { id: project.id, updates: { name: "CRUD Updated", description: "synthetic description" } } };
    const projectUpdatePreview = service.previewAgentMutation(f.source.id, projectUpdate);
    const projectUpdateSubmission = approve(f.source.id, projectUpdatePreview, "crud-project-update");
    await service.commitAgentMutation({ sourceSessionId: f.source.id, raw: projectUpdate, requestId: "crud-project-update", submissionId: projectUpdateSubmission, expiresAt: projectUpdatePreview.expires_at });
    assert.equal(getProject(project.id)?.name, "CRUD Updated");

    const projectDelete = { mutation_type: "project_delete_registration", mutation: { id: project.id } };
    const projectDeletePreview = service.previewAgentMutation(f.source.id, projectDelete);
    const projectDeleteSubmission = approve(f.source.id, projectDeletePreview, "crud-project-delete");
    await service.commitAgentMutation({ sourceSessionId: f.source.id, raw: projectDelete, requestId: "crud-project-delete", submissionId: projectDeleteSubmission, expiresAt: projectDeletePreview.expires_at });
    assert.equal(getProject(project.id), undefined);
    assert.equal(fs.existsSync(targetCwd), true);
  } finally { f.cleanup(); }
});

test("synthetic restricted profile, Protected project, and AGENTS.md complete the approved vertical slice", async () => {
  const f = fixture("wayang-workspace-synthetic-e2e-");
  try {
    const service = new WorkspaceSettingsService();
    const profileProposal = {
      mutation_type: "agent_profile_create",
      mutation: {
        name: "Synthetic Bookkeeper",
        resource_mode: "project_only",
        instructions: "Synthetic bookkeeping identity without real user data.",
        memory_access: "read",
        default_provider: null,
        default_model: null,
      },
    };
    const profilePreview = service.previewAgentMutation(f.source.id, profileProposal);
    const profileSubmission = approve(f.source.id, profilePreview, "e2e-profile");
    await service.commitAgentMutation({ sourceSessionId: f.source.id, raw: profileProposal, requestId: "e2e-profile", submissionId: profileSubmission, expiresAt: profilePreview.expires_at });
    const restricted = getStore().agentProfiles.find((profile) => profile.name === "Synthetic Bookkeeper")!;

    const targetCwd = path.join(f.dir, "synthetic-books");
    fs.mkdirSync(targetCwd);
    const projectProposal = {
      mutation_type: "project_create",
      mutation: {
        cwd: targetCwd,
        name: "Synthetic Books",
        default_agent_profile_id: restricted.id,
        default_provider: null,
        default_model: null,
        access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [restricted.id] },
      },
    };
    const projectPreview = service.previewAgentMutation(f.source.id, projectProposal);
    const projectSubmission = approve(f.source.id, projectPreview, "e2e-project");
    await service.commitAgentMutation({ sourceSessionId: f.source.id, raw: projectProposal, requestId: "e2e-project", submissionId: projectSubmission, expiresAt: projectPreview.expires_at });
    const target = getStore().projects.find((project) => project.cwd === targetCwd)!;

    const instructionText = "# Synthetic instructions\n\nNo real financial or credential data.\n";
    const instructionsProposal = {
      mutation_type: "project_instructions_write",
      mutation: { project_id: target.id, text: instructionText, expected_sha256: null, create_if_missing: true },
    };
    const instructionsPreview = service.previewAgentMutation(f.source.id, instructionsProposal);
    assert.equal(JSON.stringify(instructionsPreview).includes(instructionText), false);
    const instructionsSubmission = approve(f.source.id, instructionsPreview, "e2e-instructions");
    await service.commitAgentMutation({ sourceSessionId: f.source.id, raw: instructionsProposal, requestId: "e2e-instructions", submissionId: instructionsSubmission, expiresAt: instructionsPreview.expires_at });

    assert.equal(restricted.resource_mode, "project_only");
    assert.equal(restricted.memory_access, "read");
    assert.deepEqual(target.access_policy, { privacy_mode: "protected", allowed_agent_profile_ids: [restricted.id] });
    assert.equal(fs.readFileSync(path.join(targetCwd, "AGENTS.md"), "utf8"), instructionText);
    const metadata = service.read(f.source.id, { action: "get_project_instructions_metadata", project_id: target.id }) as any;
    assert.equal(metadata.exists, true);
    assert.equal("text" in metadata, false);

    const restrictedSource = createSession(targetCwd, { agentProfileId: restricted.id });
    assert.throws(() => service.read(restrictedSource.id, { action: "list_projects" }), /Restricted profiles/);
    const scheduledSource = createSession(f.sourceCwd, {
      agentProfileId: f.managementProfile.id,
      scheduledJobId: "synthetic-job",
      scheduledRunId: "synthetic-run",
    });
    assert.throws(() => service.read(scheduledSource.id, { action: "list_projects" }), /Scheduled sessions/);
  } finally { f.cleanup(); }
});

test("profile deletion always leases affected runtimes regardless of legacy deletable metadata", async () => {
  const f = fixture("wayang-workspace-profile-delete-lease-");
  let affectedSessionId: string | undefined;
  try {
    const service = new WorkspaceSettingsService();
    const profile = service.createAgentProfileForUi({ name: "Legacy metadata profile" });
    const replacement = service.createAgentProfileForUi({ name: "Generic replacement" });
    const targetCwd = path.join(f.dir, "delete-lease-project");
    fs.mkdirSync(targetCwd);
    createProject({ cwd: targetCwd, default_agent_profile_id: profile.id });
    const affected = createSession(targetCwd, { agentProfileId: profile.id });
    affectedSessionId = affected.id;
    const stored = getStore().agentProfiles.find((row) => row.id === profile.id)!;
    stored.deletable = false;
    stored.builtin_kind = "wren";
    assert.equal(lockRuntimeMutationSession(affected.id), true);
    await assert.rejects(() => service.deleteAgentProfileForUi(profile.id, replacement.id), /active|conflict|change/);
    assert.ok(getStore().agentProfiles.some((row) => row.id === profile.id));
    unlockRuntimeMutationSession(affected.id);
    affectedSessionId = undefined;
    await service.deleteAgentProfileForUi(profile.id, replacement.id);
    assert.equal(getStore().agentProfiles.some((row) => row.id === profile.id), false);
  } finally {
    if (affectedSessionId) unlockRuntimeMutationSession(affectedSessionId);
    f.cleanup();
  }
});

test("ordinary pair invalidation fails closed without a denial latch and latches the exact tombstone before cleanup", async () => {
  const f = fixture("wayang-workspace-invalidation-");
  try {
    const association = commitWorkspaceCapabilityActivation({
      capability_id: "wayang.host-execution.v1",
      project_id: f.sourceProject.id,
      agent_profile_id: f.managementProfile.id,
      operation_digest: "a".repeat(64),
    });
    const replacement = createAgentProfile({ name: "Replacement default" });
    const exclusion = {
      default_agent_profile_id: replacement.id,
      access_policy: { privacy_mode: "standard" as const, allowed_agent_profile_ids: [replacement.id] },
    };
    await assert.rejects(
      () => new WorkspaceSettingsService().updateProjectForUi(f.sourceProject.id, exclusion, true),
      /runtime latch is unavailable/,
    );
    assert.equal(getProject(f.sourceProject.id)?.default_agent_profile_id, f.managementProfile.id);
    assert.equal(getStore().workspaceCapabilityAssociations[0]!.active, true);

    const events: string[] = [];
    const invalidation: WorkspaceCapabilityInvalidationPort = {
      latchDenied(input) {
        assert.deepEqual(input.associations.map((row) => ({
          projectId: row.projectId,
          agentProfileId: row.agentProfileId,
          revision: row.revision,
          active: row.active,
        })), [{
          projectId: association.project_id,
          agentProfileId: association.agent_profile_id,
          revision: association.revision + 1,
          active: false,
        }]);
        assert.deepEqual(input.runtimeIds, [f.source.id]);
        events.push("latched");
      },
      async cleanupAfterDenial(input) {
        assert.deepEqual(input.runtimeIds, [f.source.id]);
        events.push("cleaned");
      },
    };
    await new WorkspaceSettingsService(invalidation).updateProjectForUi(f.sourceProject.id, exclusion, true);
    assert.deepEqual(events, ["latched", "cleaned"]);
    assert.equal(getProject(f.sourceProject.id)?.default_agent_profile_id, replacement.id);
  } finally { f.cleanup(); }
});

test("project model defaults preserve associations and do not require a denial port", async () => {
  const f = fixture("wayang-workspace-model-default-preserve-");
  try {
    const association = commitWorkspaceCapabilityActivation({
      capability_id: "wayang.host-execution.v1",
      project_id: f.sourceProject.id,
      agent_profile_id: f.managementProfile.id,
      operation_digest: "b".repeat(64),
    });
    await new WorkspaceSettingsService().updateProjectForUi(
      f.sourceProject.id,
      { default_provider: "other-provider", default_model: "other-model" },
      false,
    );
    assert.deepEqual(getStore().workspaceCapabilityAssociations[0], association);
  } finally { f.cleanup(); }
});

test("project registration deletion checks every central reference class and never deletes files", () => {
  const f = fixture("wayang-project-delete-");
  try {
    const targetCwd = path.join(f.dir, "target");
    fs.mkdirSync(targetCwd);
    const canary = path.join(targetCwd, "keep.txt");
    fs.writeFileSync(canary, "SYNTHETIC_KEEP\n");
    const target = createProject({ cwd: targetCwd });
    const store = getStore();
    store.sessions.push({ id: "archived-ref", cwd: targetCwd, project_id: target.id, archived: 1 } as any);
    store.scheduledJobs.push({ id: "job-ref", cwd: targetCwd } as any);
    store.scheduledRuns.push({ id: "run-ref", job_id: "job-ref" } as any);
    store.apps.push({ id: "app-ref", project_cwd: targetCwd } as any);
    store.appStates.push({ app_id: "state-ref", project_cwd: targetCwd } as any);
    store.appEvents.push({ id: "event-ref", projectCwd: targetCwd } as any);

    assert.deepEqual(getProjectRegistrationReferences(target.id), {
      sessions: ["archived-ref"],
      scheduled_jobs: ["job-ref"],
      scheduled_runs: ["run-ref"],
      protected_automation_jobs: [],
      protected_automation_runs: [],
      messaging_endpoints: [],
      apps: ["app-ref"],
      app_states: ["state-ref"],
      app_events: ["event-ref"],
    });
    assert.throws(() => deleteProjectRegistration(target.id), /still referenced/);
    assert.ok(getProject(target.id));
    assert.equal(fs.readFileSync(canary, "utf8"), "SYNTHETIC_KEEP\n");

    store.sessions = store.sessions.filter((row) => row.id !== "archived-ref") as typeof store.sessions;
    store.scheduledJobs = store.scheduledJobs.filter((row) => row.id !== "job-ref");
    store.scheduledRuns = store.scheduledRuns.filter((row) => row.id !== "run-ref");
    store.apps = store.apps.filter((row) => row.id !== "app-ref");
    store.appStates = store.appStates.filter((row) => row.app_id !== "state-ref");
    store.appEvents = store.appEvents.filter((row) => row.id !== "event-ref");

    const browserRoot = path.join(targetCwd, ".pi", "browser-workbench");
    fs.mkdirSync(path.join(browserRoot, "profiles", "synthetic"), { recursive: true });
    fs.writeFileSync(path.join(browserRoot, "profiles", "synthetic", "Cookies"), "SYNTHETIC_BROWSER_DATA\n");
    assert.throws(() => deleteProjectRegistration(target.id), /managed browser profile data/);
    assert.throws(
      () => new WorkspaceSettingsService().previewAgentMutation(f.source.id, {
        mutation_type: "project_delete_registration",
        mutation: { id: target.id },
      }),
      /managed browser profile data/,
    );
    assert.ok(getProject(target.id));
    fs.rmSync(browserRoot, { recursive: true });

    deleteProjectRegistration(target.id);
    assert.equal(getProject(target.id), undefined);
    assert.equal(fs.readFileSync(canary, "utf8"), "SYNTHETIC_KEEP\n");
  } finally { f.cleanup(); }
});
