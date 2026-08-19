import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createAgentProfile } from "./agent-profiles.js";
import { close, commitStoreMutation, getStore, init } from "./db.js";
import { installSyntheticLegacyAgentActivation } from "./legacy-agent-activation.test-helper.js";
import { resolveMaskedHostWorkspaceWitness } from "./masked-host-workspace.js";
import { createProject } from "./projects.js";
import { createSession, getSessionById } from "./sessions.js";
import { commitWorkspaceCapabilityActivation, revokeWorkspaceCapabilityAssociation } from "./workspace-capabilities.js";
import { WREN_AGENT_PROFILE_ID } from "./workspace-types.js";

function withFixture(run: (fixture: { dir: string; cwd: string }) => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-masked-host-workspace-"));
  const cwd = path.join(dir, "project");
  fs.mkdirSync(cwd);
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  try { init(); run({ dir, cwd }); } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("generic masked host workspace requires both exact pair associations", () => withFixture(({ cwd }) => {
  const profile = createAgentProfile({ name: "Generic maintenance profile", resource_mode: "project_only" });
  const project = createProject({
    cwd,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  const session = createSession(cwd, { agentProfileId: profile.id });
  const resolve = () => resolveMaskedHostWorkspaceWitness({
    session: getSessionById(session.id)!,
    project,
    profile,
  });

  assert.equal(resolve(), null);
  const standard = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.standard-resources.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "a".repeat(64),
  });
  assert.equal(resolve(), null, "standard resources alone must not broaden the shell");
  const masked = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.masked-host-workspace.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "b".repeat(64),
  });
  assert.deepEqual(resolve(), {
    capabilityId: "wayang.masked-host-workspace.v1",
    projectId: project.id,
    agentProfileId: profile.id,
    standardResourcesAssociationRevision: standard.revision,
    maskedWorkspaceAssociationRevision: masked.revision,
    authoritySource: "associations",
  });

  revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.standard-resources.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    expected_revision: standard.revision,
  });
  assert.equal(resolve(), null);
}));

test("monotonic pair cutover disables historical fallback but preserves both-association authority", () => withFixture(({ dir, cwd }) => {
  const restoreActivation = installSyntheticLegacyAgentActivation(path.join(dir, "config"));
  try {
    const now = Date.now();
    commitStoreMutation((draft) => {
      draft.agentProfiles.push({
        id: WREN_AGENT_PROFILE_ID,
        name: "Historical profile",
        description: null,
        builtin_kind: "wren",
        deletable: false,
        enabled: true,
        resource_mode: "standard",
        instructions: null,
        memory_access: "read_write",
        default_provider: null,
        default_model: null,
        allowed_tools: null,
        allowed_extensions: null,
        created_at: now,
        updated_at: now,
      });
    });
    const project = createProject({
      cwd,
      default_agent_profile_id: WREN_AGENT_PROFILE_ID,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [WREN_AGENT_PROFILE_ID] },
    });
    const session = createSession(cwd, { agentProfileId: WREN_AGENT_PROFILE_ID });
    const resolve = () => resolveMaskedHostWorkspaceWitness({ session, project, profile: getStore().agentProfiles.find((profile) => profile.id === WREN_AGENT_PROFILE_ID)! });
    assert.equal(resolve()?.authoritySource, "legacy-activated-home");

    commitStoreMutation((draft) => {
      draft.historicalAgentCutovers.push({
        project_id: project.id,
        agent_profile_id: WREN_AGENT_PROFILE_ID,
        revision: 1,
        cut_over_at: now,
      });
    });
    assert.equal(resolve(), null, "cutover must never fall back when associations are missing");

    const standard = commitWorkspaceCapabilityActivation({
      capability_id: "wayang.standard-resources.v1",
      project_id: project.id,
      agent_profile_id: WREN_AGENT_PROFILE_ID,
      operation_digest: "e".repeat(64),
    });
    const masked = commitWorkspaceCapabilityActivation({
      capability_id: "wayang.masked-host-workspace.v1",
      project_id: project.id,
      agent_profile_id: WREN_AGENT_PROFILE_ID,
      operation_digest: "f".repeat(64),
    });
    assert.equal(resolve()?.authoritySource, "associations");
    revokeWorkspaceCapabilityAssociation({
      capability_id: "wayang.masked-host-workspace.v1",
      project_id: project.id,
      agent_profile_id: WREN_AGENT_PROFILE_ID,
      expected_revision: masked.revision,
    });
    assert.equal(resolve(), null, "revocation after cutover must not resurrect historical fallback");
    assert.ok(standard.active);
  } finally {
    restoreActivation();
  }
}));

test("generic masked host workspace preserves eligible scheduled sessions", () => withFixture(({ cwd }) => {
  const profile = createAgentProfile({ name: "Scheduled maintenance profile" });
  const project = createProject({ cwd, default_agent_profile_id: profile.id });
  const session = createSession(cwd, {
    agentProfileId: profile.id,
    scheduledJobId: "scheduled-job",
    scheduledRunId: "scheduled-run",
  });
  for (const [capability_id, digest] of [
    ["wayang.standard-resources.v1", "c".repeat(64)],
    ["wayang.masked-host-workspace.v1", "d".repeat(64)],
  ] as const) {
    commitWorkspaceCapabilityActivation({
      capability_id,
      project_id: project.id,
      agent_profile_id: profile.id,
      operation_digest: digest,
    });
  }
  assert.equal(resolveMaskedHostWorkspaceWitness({ session, project, profile })?.authoritySource, "associations");
}));
