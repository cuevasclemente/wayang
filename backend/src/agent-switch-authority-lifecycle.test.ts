import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { AgentSwitchAuthorityLifecycle } from "./agent-switch-authority-lifecycle.js";
import { selectWayangBashMode } from "./sandbox-bash.js";
import {
  HOST_EXECUTION_CAPABILITY_ID,
  resolveHostExecutionAuthorization,
  type HostExecutionAuthorizationFacts,
} from "./host-execution.js";
import type { AgentProfileRow, ProjectRow } from "./workspace-types.js";
import type { SessionRow } from "./sessions.js";

function pendingHostFacts(): { root: string; facts: HostExecutionAuthorizationFacts } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-switch-authority-order-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const profile: AgentProfileRow = {
    id: "arbitrary-target-profile",
    name: "Arbitrary Target",
    description: null,
    builtin_kind: null,
    deletable: true,
    enabled: true,
    resource_mode: "project_only",
    instructions: null,
    memory_access: "none",
    default_provider: null,
    default_model: null,
    allowed_tools: null,
    allowed_extensions: null,
    created_at: 1,
    updated_at: 1,
  };
  const project: ProjectRow = {
    id: "synthetic-project",
    cwd,
    name: "Synthetic",
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
    id: "synthetic-session",
    pi_session_file: null,
    title: "Synthetic",
    title_source: "explicit",
    cwd,
    provider: "synthetic-provider",
    model: "synthetic-model",
    agent_profile_id: profile.id,
    pending_agent_switch: {
      switch_id: "synthetic-switch",
      from_agent_profile_id: "restricted-profile",
      from_provider: "synthetic-provider",
      from_model: "synthetic-model",
      to_agent_profile_id: profile.id,
      target_provider: "synthetic-provider",
      target_model: "synthetic-model",
      changed_at: 1,
    },
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
  return {
    root,
    facts: {
      capabilityWitness: {
        capabilityId: HOST_EXECUTION_CAPABILITY_ID,
        projectId: project.id,
        agentProfileId: profile.id,
        associationRevision: 1,
      },
      row,
      profile,
      project,
      requestedCwd: cwd,
      authorization: { allowed: true, projectId: project.id, agentProfileId: profile.id },
      isInteractive: true,
      isSubagent: false,
    },
  };
}

test("pending switch denies generic host mode until durable commit and provisional destruction", () => {
  const f = pendingHostFacts();
  try {
    const lifecycle = new AgentSwitchAuthorityLifecycle();
    const pendingDecision = resolveHostExecutionAuthorization(f.facts);
    assert.equal(pendingDecision.allowed, false);
    const provisionalMode = selectWayangBashMode(pendingDecision, { available: true });
    assert.equal(provisionalMode, "sandboxed");

    assert.throws(() => lifecycle.authorizeProvisionalTargetConstruction(), /prior old-runtime revocation/);
    lifecycle.oldRuntimeRevoked();
    lifecycle.authorizeProvisionalTargetConstruction();
    assert.throws(
      () => lifecycle.provisionalTargetConstructed({ pending: true, bashMode: "host" }),
      /pending agent switch can never select host execution/,
    );
    lifecycle.provisionalTargetConstructed({ pending: true, bashMode: provisionalMode });
    assert.throws(() => lifecycle.authorizeFreshTargetConstruction(), /completed switch and destroyed provisional runtime/);

    f.facts.row!.pending_agent_switch = null;
    const committedDecision = resolveHostExecutionAuthorization(f.facts);
    assert.equal(committedDecision.allowed, true);
    const committedMode = selectWayangBashMode(committedDecision, { available: true });
    assert.equal(committedMode, "host");
    lifecycle.durableSwitchCompleted({ pending: false, bashMode: provisionalMode });
    lifecycle.provisionalTargetDestroyed();
    lifecycle.authorizeFreshTargetConstruction();
    lifecycle.freshTargetConstructed({ pending: false, bashMode: committedMode });
    assert.equal(lifecycle.phase, "fresh_target_active");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("legacy wren_host protocol state is rejected rather than treated as authority", () => {
  const lifecycle = new AgentSwitchAuthorityLifecycle();
  lifecycle.oldRuntimeRevoked();
  assert.throws(
    () => lifecycle.provisionalTargetConstructed({ pending: true, bashMode: "wren_host" }),
    /Legacy wren_host protocol state is invalid/,
  );
});

test("host-to-restricted ordering revokes old authority before sandbox construction", () => {
  const lifecycle = new AgentSwitchAuthorityLifecycle();
  assert.throws(() => lifecycle.authorizeProvisionalTargetConstruction(), /prior old-runtime revocation/);
  lifecycle.oldRuntimeRevoked();
  lifecycle.provisionalTargetConstructed({ pending: true, bashMode: "sandboxed" });
  lifecycle.durableSwitchCompleted({ pending: false, bashMode: "sandboxed" });
  lifecycle.provisionalTargetDestroyed();
  lifecycle.freshTargetConstructed({ pending: false, bashMode: "sandboxed" });
  assert.equal(lifecycle.phase, "fresh_target_active");
});

test("failure recovery rejects pending generic host authority in every lifecycle phase", () => {
  const phases: Array<(lifecycle: AgentSwitchAuthorityLifecycle) => void> = [
    () => undefined,
    (lifecycle) => lifecycle.oldRuntimeRevoked(),
    (lifecycle) => { lifecycle.oldRuntimeRevoked(); lifecycle.provisionalTargetConstructed({ pending: true, bashMode: "sandboxed" }); },
    (lifecycle) => {
      lifecycle.oldRuntimeRevoked();
      lifecycle.provisionalTargetConstructed({ pending: true, bashMode: "sandboxed" });
      lifecycle.durableSwitchCompleted({ pending: false, bashMode: "sandboxed" });
    },
  ];
  for (const arrange of phases) {
    const lifecycle = new AgentSwitchAuthorityLifecycle();
    arrange(lifecycle);
    assert.throws(
      () => lifecycle.failureCleaned({ pending: true, bashMode: "host" }),
      /cannot leave pending host authority/,
    );
  }

  const pendingSandboxRecovery = new AgentSwitchAuthorityLifecycle();
  pendingSandboxRecovery.failureCleaned({ pending: true, bashMode: "sandboxed" });
  assert.equal(pendingSandboxRecovery.phase, "failure_cleaned");

  const committedHostRecovery = new AgentSwitchAuthorityLifecycle();
  committedHostRecovery.failureCleaned({ pending: false, bashMode: "host" });
  assert.equal(committedHostRecovery.phase, "failure_cleaned");
});
