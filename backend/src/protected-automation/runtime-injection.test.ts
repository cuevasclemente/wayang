import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, test } from "node:test";
import { createAgentProfile } from "../agent-profiles.js";
import { installAgentToolPolicyGuard } from "../agent-runtime.js";
import { close, commitStoreMutation, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession } from "../sessions.js";
import {
  commitWorkspaceCapabilityActivation,
  revokeWorkspaceCapabilityAssociation,
} from "../workspace-capabilities.js";
import { INTERACTIVE_BROWSER_TOOL_NAMES } from "../browser/protected-tools.js";
import type { ProtectedAutomationBinding } from "./authority.js";
import {
  createProtectedAutomationToolRuntime,
  PROTECTED_AUTOMATION_TOOL_NAME,
} from "./tool.js";

let root = "";
let projectRoot = "";
let previousDataDir: string | undefined;

beforeEach(() => {
  close();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-protected-automation-injection-"));
  projectRoot = path.join(root, "project");
  fs.mkdirSync(projectRoot, { recursive: true });
  previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  init();
});

afterEach(() => {
  close();
  if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
  else process.env.WAYANG_DATA_DIR = previousDataDir;
  fs.rmSync(root, { recursive: true, force: true });
});

function fixture(options: { activate?: boolean } = {}) {
  const profile = createAgentProfile({ name: "Synthetic injection owner" });
  const project = createProject({
    cwd: projectRoot,
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
  });
  const session = createSession(projectRoot, { agentProfileId: profile.id });
  const association = options.activate === false ? undefined : commitWorkspaceCapabilityActivation({
    capability_id: "wayang.protected-automation.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "b".repeat(64),
  });
  const bindingFor = (sourceSessionId: string): ProtectedAutomationBinding => ({
    capabilityId: "wayang.protected-automation.v1",
    sourceSessionId,
    projectId: project.id,
    projectCwd: project.cwd,
    agentProfileId: profile.id,
    associationRevision: association?.revision ?? 1,
    runtimeGeneration: "synthetic-runtime-generation",
    processBootNonce: "synthetic-process-boot",
  });
  return { profile, project, session, association, bindingFor };
}

function syntheticPrivilegedRuntime(toolName: string) {
  let revoked = false;
  let closes = 0;
  let executions = 0;
  const tool = {
    name: toolName,
    async execute() {
      executions += 1;
      return { content: [] };
    },
  };
  return {
    tool,
    tools: [tool],
    toolForName(name: string) { return name === toolName ? tool : undefined; },
    preflight: () => revoked
      ? { allowed: false as const, reason: "synthetic runtime is revoked" }
      : { allowed: true as const },
    async close() {
      closes += 1;
      revoked = true;
    },
    get closes() { return closes; },
    get executions() { return executions; },
  };
}

function guardSession(toolName: string, runtime: { tool: unknown }, mode: "exact" | "missing-candidate" | "missing-trusted") {
  let activeNames = [toolName];
  const definitions = mode === "missing-trusted"
    ? new Map([[toolName, { definition: {} }]])
    : new Map([[toolName, { definition: runtime.tool }]]);
  const registered = mode === "missing-candidate" ? [] : [[toolName, runtime.tool]];
  const tools = mode === "missing-candidate" ? [] : [runtime.tool];
  const session: any = {
    _toolDefinitions: definitions,
    _toolRegistry: new Map(registered as Array<[string, unknown]>),
    getActiveToolNames: () => activeNames,
    setActiveToolsByName(names: string[]) { activeNames = [...names]; },
    agent: { state: { tools }, async beforeToolCall() { return undefined; } },
  };
  return { session, get activeNames() { return activeNames; } };
}

const BROWSER_TOOL_NAME = INTERACTIVE_BROWSER_TOOL_NAMES[0];

function installSyntheticPrivilegedGuard(session: any, sessionId: string, toolName: string, runtime: any): void {
  installAgentToolPolicyGuard(session, sessionId, toolName === PROTECTED_AUTOMATION_TOOL_NAME
    ? { protectedAutomationRuntime: runtime }
    : { protectedBrowserRuntime: runtime });
}

test("protected tool guards reject undefined candidate and trusted objects for browser and automation", () => {
  const f = fixture();
  for (const toolName of [PROTECTED_AUTOMATION_TOOL_NAME, BROWSER_TOOL_NAME]) {
    for (const mode of ["missing-candidate", "missing-trusted"] as const) {
      const runtime = syntheticPrivilegedRuntime(toolName);
      const guarded = guardSession(toolName, runtime, mode);
      installSyntheticPrivilegedGuard(guarded.session, f.session.id, toolName, runtime);
      assert.deepEqual(guarded.activeNames, [], `${toolName}: ${mode}`);
      assert.equal(runtime.preflight().allowed, false, `${toolName}: ${mode}`);
      assert.equal(runtime.closes, 1, `${toolName}: ${mode} closes the exact runtime once`);
      assert.equal(runtime.executions, 0, `${toolName}: ${mode}`);
    }

    const runtime = syntheticPrivilegedRuntime(toolName);
    const guarded = guardSession(toolName, runtime, "exact");
    installSyntheticPrivilegedGuard(guarded.session, f.session.id, toolName, runtime);
    guarded.session._toolRegistry = new Map();
    guarded.session.agent.state.tools = [];
    guarded.session.setActiveToolsByName([toolName]);
    assert.deepEqual(guarded.activeNames, [], `${toolName}: candidate disappeared after capture`);
    assert.equal(runtime.closes, 1, `${toolName}: undefined refreshed candidate closes the trusted runtime`);
  }
});

test("protected tool guards close once on same-name registry refresh drift", async () => {
  const f = fixture();
  for (const toolName of [PROTECTED_AUTOMATION_TOOL_NAME, BROWSER_TOOL_NAME]) {
    const runtime = syntheticPrivilegedRuntime(toolName);
    const guarded = guardSession(toolName, runtime, "exact");
    installSyntheticPrivilegedGuard(guarded.session, f.session.id, toolName, runtime);
    assert.deepEqual(guarded.activeNames, [toolName], toolName);

    const replacement: any = {
      name: toolName,
      async execute() { return { content: [] }; },
    };
    guarded.session._toolRegistry = new Map([[toolName, replacement]]);
    guarded.session.agent.state.tools = [replacement];
    guarded.session.setActiveToolsByName([toolName]);
    assert.deepEqual(guarded.activeNames, [], toolName);
    assert.equal(runtime.closes, 1, `${toolName}: registry refresh closes only its captured runtime`);

    const decision = await guarded.session.agent.beforeToolCall({ toolCall: { name: toolName }, args: {} });
    assert.equal(decision.block, true, toolName);
    await assert.rejects(() => replacement.execute("counterfeit", {}), /object is not authorized/);
    assert.equal(runtime.closes, 1, `${toolName}: repeated drift checks do not close again`);
  }
});

test("agent guard reserves protected_automation to the exact registered object and closes on drift", async () => {
  const f = fixture();
  const runtime = createProtectedAutomationToolRuntime({ binding: f.bindingFor(f.session.id), isRuntimeCurrent: () => true });
  const originalClose = runtime.close.bind(runtime);
  let closeCalls = 0;
  runtime.close = async () => {
    closeCalls += 1;
    await originalClose();
  };
  let activeNames = [PROTECTED_AUTOMATION_TOOL_NAME];
  const fakeSession: any = {
    _toolDefinitions: new Map([[PROTECTED_AUTOMATION_TOOL_NAME, { definition: runtime.tool }]]),
    _toolRegistry: new Map([[PROTECTED_AUTOMATION_TOOL_NAME, runtime.tool]]),
    getActiveToolNames: () => activeNames,
    setActiveToolsByName(names: string[]) { activeNames = [...names]; },
    agent: { state: { tools: [runtime.tool] }, async beforeToolCall() { return undefined; } },
  };
  installAgentToolPolicyGuard(fakeSession, f.session.id, { protectedAutomationRuntime: runtime });

  assert.deepEqual(activeNames, [PROTECTED_AUTOMATION_TOOL_NAME]);
  assert.equal(await fakeSession.agent.beforeToolCall({
    toolCall: { name: PROTECTED_AUTOMATION_TOOL_NAME },
    args: { operation: "status" },
  }), undefined);
  const status = await (runtime.tool.execute as any)("legitimate", { operation: "status" });
  assert.match(status.content[0].text, /wayang\.protected-automation\.v1/);

  let counterfeitExecutions = 0;
  const counterfeit: any = {
    name: PROTECTED_AUTOMATION_TOOL_NAME,
    async execute() { counterfeitExecutions += 1; return { content: [] }; },
  };
  fakeSession._toolRegistry = new Map([[PROTECTED_AUTOMATION_TOOL_NAME, counterfeit]]);
  fakeSession.agent.state.tools = [counterfeit];
  fakeSession.setActiveToolsByName([PROTECTED_AUTOMATION_TOOL_NAME]);
  assert.deepEqual(activeNames, []);
  assert.equal(runtime.preflight().allowed, false, "object drift permanently closes the exact runtime");
  assert.equal(closeCalls, 1, "the exact captured runtime is closed once on drift");
  const decision = await fakeSession.agent.beforeToolCall({
    toolCall: { name: PROTECTED_AUTOMATION_TOOL_NAME },
    args: { operation: "status" },
  });
  assert.equal(decision.block, true);
  await assert.rejects(() => counterfeit.execute("counterfeit", { operation: "status" }), /object is not authorized/);
  assert.equal(counterfeitExecutions, 0);
  assert.equal(closeCalls, 1, "later preflight and execute denials do not re-close the runtime");
});

test("scheduled, quarantined, and pending-switch sources cannot authorize the runtime", async () => {
  const f = fixture();
  const scheduledJob = createSession(projectRoot, { agentProfileId: f.profile.id, scheduledJobId: "scheduled-job" });
  const scheduledRun = createSession(projectRoot, { agentProfileId: f.profile.id, scheduledRunId: "scheduled-run" });
  const quarantined = createSession(projectRoot, { agentProfileId: f.profile.id });
  const switching = createSession(projectRoot, { agentProfileId: f.profile.id });
  commitStoreMutation((draft) => {
    const quarantinedRow = draft.sessions.find((row) => row.id === quarantined.id)!;
    quarantinedRow.legacy_private_session_quarantine = true;
    const switchingRow = draft.sessions.find((row) => row.id === switching.id)!;
    switchingRow.pending_agent_switch = {
      switch_id: "synthetic-switch",
      from_agent_profile_id: f.profile.id,
      from_provider: null,
      from_model: null,
      to_agent_profile_id: f.profile.id,
      target_provider: "synthetic",
      target_model: "synthetic",
      changed_at: Date.now(),
    };
  });

  for (const source of [scheduledJob, scheduledRun, quarantined, switching]) {
    const runtime = createProtectedAutomationToolRuntime({
      binding: f.bindingFor(source.id),
      isRuntimeCurrent: () => true,
    });
    assert.equal(runtime.preflight().allowed, false, source.id);
    await assert.rejects(
      () => (runtime.tool.execute as any)("denied", { operation: "status" }),
      /revoked|authority changed/,
    );
  }
});

test("a missing exact-pair association permanently denies protected automation", async () => {
  const missing = fixture({ activate: false });
  const missingRuntime = createProtectedAutomationToolRuntime({
    binding: missing.bindingFor(missing.session.id),
    isRuntimeCurrent: () => true,
  });
  assert.equal(missingRuntime.preflight().allowed, false, "missing association");
  await assert.rejects(
    () => (missingRuntime.tool.execute as any)("missing", { operation: "status" }),
    /revoked|authority changed/,
  );
});

test("revoking the exact-pair association permanently denies the captured runtime", async () => {
  const revoked = fixture();
  const revokedRuntime = createProtectedAutomationToolRuntime({
    binding: revoked.bindingFor(revoked.session.id),
    isRuntimeCurrent: () => true,
  });
  assert.equal(revokedRuntime.preflight().allowed, true);
  revokeWorkspaceCapabilityAssociation({
    capability_id: "wayang.protected-automation.v1",
    project_id: revoked.project.id,
    agent_profile_id: revoked.profile.id,
    expected_revision: revoked.association!.revision,
  });
  assert.equal(revokedRuntime.preflight().allowed, false, "revoked association");
  await assert.rejects(
    () => (revokedRuntime.tool.execute as any)("revoked", { operation: "status" }),
    /revoked|authority changed/,
  );
});
