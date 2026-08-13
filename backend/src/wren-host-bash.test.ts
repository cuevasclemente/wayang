import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveWrenHostAuthorization } from "./wren-host-bash.js";
import { WREN_AGENT_PROFILE_ID, type AgentProfileRow, type ProjectRow } from "./workspace-types.js";
import type { SessionRow } from "./sessions.js";

/** Compatibility must compile for the incremental bridge without retaining any
 * positive identity/configuration authorization path. */
test("legacy Wren flag, UUID, name, and kind grant no host authority", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-legacy-wren-deny-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const profile: AgentProfileRow = {
    id: WREN_AGENT_PROFILE_ID,
    name: "Wren",
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
    created_at: 1,
    updated_at: 1,
  };
  const project: ProjectRow = {
    id: "legacy-project",
    cwd,
    name: "Wren",
    description: null,
    color: null,
    default_agent_profile_id: profile.id,
    default_provider: null,
    default_model: null,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
    created_at: 1,
    updated_at: 1,
  };
  const row: SessionRow = {
    id: "legacy-session",
    pi_session_file: null,
    title: "Synthetic",
    title_source: "explicit",
    cwd,
    provider: "synthetic-provider",
    model: "synthetic-model",
    agent_profile_id: profile.id,
    pending_agent_switch: null,
    legacy_private_session_quarantine: false,
    legacy_capability_ineligible: false,
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
  try {
    const decision = resolveWrenHostAuthorization({
      configEnabled: true,
      row,
      profile,
      project,
      requestedCwd: cwd,
      authorization: { allowed: true, projectId: project.id, agentProfileId: profile.id },
      isInteractive: true,
      isSubagent: false,
    });
    assert.equal(decision.allowed, false);
    if (!decision.allowed) assert.match(decision.reason ?? "", /capability witness/);

    const witness = {
      capabilityId: "wayang.host-execution.v1" as const,
      projectId: project.id,
      agentProfileId: profile.id,
      associationRevision: 1,
    };
    const staleMode = resolveWrenHostAuthorization({
      configEnabled: true,
      capabilityWitness: witness,
      row,
      profile,
      project,
      requestedCwd: cwd,
      authorization: { allowed: true, projectId: project.id, agentProfileId: profile.id },
      isInteractive: true,
      isSubagent: false,
      execution: {
        selectedBashMode: "wren_host",
        expectedCapabilityWitness: witness,
        expectedRuntimeGeneration: "generation",
        activeRuntimeGeneration: "generation",
        expectedProcessBootNonce: "boot",
        activeProcessBootNonce: "boot",
        activeHandleSessionId: row.id,
        activeHandleAgentProfileId: profile.id,
        activeHandleCwd: cwd,
        spawnCwd: cwd,
        trustedToolDefinition: true,
        trustedToolExecutable: true,
      },
    });
    assert.equal(staleMode.allowed, false);
    if (!staleMode.allowed) assert.match(staleMode.reason ?? "", /not created with host execution/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
