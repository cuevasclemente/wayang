import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  createAgentSession,
  SessionManager,
  type BashOperations,
} from "@earendil-works/pi-coding-agent";
import {
  HOST_EXECUTION_CAPABILITY_ID,
  buildHostChildEnvironment,
  createHostBashOperations,
  createHostBashToolDefinition,
  hostExecutionWitnessFromResolution,
  installHostBashRegistryGuard,
  resolveHostBashExecutable,
  resolveHostExecutionAuthorization,
  type ExactHostExecutionCapabilityWitness,
  type HostExecutionAuthorizationFacts,
} from "./host-execution.js";
import type { AgentProfileRow, ProjectRow } from "./workspace-types.js";
import type { SessionRow } from "./sessions.js";

function witness(overrides: Partial<ExactHostExecutionCapabilityWitness> = {}): ExactHostExecutionCapabilityWitness {
  return {
    capabilityId: HOST_EXECUTION_CAPABILITY_ID,
    projectId: "project-id",
    agentProfileId: "ordinary-profile-id",
    associationRevision: 2,
    ...overrides,
  };
}

function fixture(): { root: string; facts: HostExecutionAuthorizationFacts } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-host-authority-"));
  const cwd = path.join(root, "project");
  fs.mkdirSync(cwd);
  const profile: AgentProfileRow = {
    id: "ordinary-profile-id",
    name: "Future Arbitrary Agent",
    description: null,
    builtin_kind: null,
    deletable: true,
    enabled: true,
    resource_mode: "standard",
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
    id: "project-id",
    cwd,
    name: "Future Arbitrary Project",
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
    id: "session-id",
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
  return {
    root,
    facts: {
      capabilityWitness: witness(),
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

function cloneFacts(facts: HostExecutionAuthorizationFacts): HostExecutionAuthorizationFacts {
  return {
    ...facts,
    capabilityWitness: facts.capabilityWitness ? { ...facts.capabilityWitness } : facts.capabilityWitness,
    row: facts.row ? { ...facts.row } : facts.row,
    profile: facts.profile ? { ...facts.profile } : facts.profile,
    project: facts.project ? {
      ...facts.project,
      access_policy: {
        ...facts.project.access_policy,
        allowed_agent_profile_ids: facts.project.access_policy.allowed_agent_profile_ids
          ? [...facts.project.access_policy.allowed_agent_profile_ids]
          : null,
      },
    } : facts.project,
    authorization: { ...facts.authorization },
    execution: facts.execution ? {
      ...facts.execution,
      expectedCapabilityWitness: { ...facts.execution.expectedCapabilityWitness },
    } : undefined,
  };
}

function withAuthorizedExecution(facts: HostExecutionAuthorizationFacts): HostExecutionAuthorizationFacts {
  const candidate = cloneFacts(facts);
  candidate.execution = {
    selectedBashMode: "host",
    expectedCapabilityWitness: { ...candidate.capabilityWitness! },
    expectedRuntimeGeneration: "generation",
    activeRuntimeGeneration: "generation",
    expectedProcessBootNonce: "boot",
    activeProcessBootNonce: "boot",
    activeHandleSessionId: candidate.row!.id,
    activeHandleAgentProfileId: candidate.profile!.id,
    activeHandleCwd: candidate.requestedCwd,
    spawnCwd: candidate.requestedCwd,
    trustedToolDefinition: true,
    trustedToolExecutable: true,
  };
  return candidate;
}

type SyntheticStatKind = "directory" | "socket" | "file";
function syntheticStat(kind: SyntheticStatKind, uid: number, symbolicLink = false): fs.Stats {
  return {
    uid,
    isDirectory: () => kind === "directory",
    isSocket: () => kind === "socket",
    isSymbolicLink: () => symbolicLink,
  } as fs.Stats;
}

function syntheticUserBusFs(options: {
  uid: number;
  runtimeRoot: string;
  runtimeOwner?: number;
  runtimeSymlink?: boolean;
  busOwner?: number;
  busKind?: SyntheticStatKind;
  busSymlink?: boolean;
  busPresent?: boolean;
}) {
  const runtimeRoot = path.resolve(options.runtimeRoot);
  const runtimeDir = path.join(runtimeRoot, String(options.uid));
  const busPath = path.join(runtimeDir, "bus");
  const entries = new Map<string, fs.Stats>();
  const parsed = path.parse(runtimeRoot);
  let cursor = parsed.root;
  entries.set(cursor, syntheticStat("directory", 0));
  for (const segment of runtimeRoot.slice(parsed.root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    entries.set(cursor, syntheticStat("directory", 0));
  }
  entries.set(runtimeDir, syntheticStat("directory", options.runtimeOwner ?? options.uid, options.runtimeSymlink ?? false));
  if (options.busPresent !== false) {
    entries.set(busPath, syntheticStat(options.busKind ?? "socket", options.busOwner ?? options.uid, options.busSymlink ?? false));
  }
  return {
    lstatSync(target: any) {
      const stat = entries.get(path.resolve(String(target)));
      if (!stat) throw Object.assign(new Error("synthetic path is absent"), { code: "ENOENT" });
      return stat;
    },
  } as any;
}

test("workspace capability resolution adapts to an exact pair witness without model semantics", () => {
  const f = fixture();
  try {
    const project = f.facts.project!;
    const profile = f.facts.profile!;
    const association = {
      capability_id: HOST_EXECUTION_CAPABILITY_ID,
      project_id: project.id,
      agent_profile_id: profile.id,
      revision: 2,
      active: true,
      approved_at: 1,
      revoked_at: null,
      updated_at: 1,
    } as const;
    const resolution = {
      authorized: true,
      capability: { id: HOST_EXECUTION_CAPABILITY_ID, privacy_mode: "standard", risk: "host-execution" },
      project,
      profile,
      association,
    } as const;
    assert.deepEqual(hostExecutionWitnessFromResolution(resolution), {
      capabilityId: HOST_EXECUTION_CAPABILITY_ID,
      projectId: project.id,
      agentProfileId: profile.id,
      associationRevision: 2,
    });
    assert.equal(hostExecutionWitnessFromResolution({ authorized: false, reason: "profile_not_found" }), null);
    assert.equal(hostExecutionWitnessFromResolution({
      ...resolution,
      association: { ...association, active: false },
    }), null);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("durable capability eligibility requires both legacy markers to be present and exactly false", () => {
  const f = fixture();
  try {
    assert.equal(resolveHostExecutionAuthorization(f.facts).allowed, true, "exact false/false markers authorize");
    const cases: Array<[string, (facts: HostExecutionAuthorizationFacts) => void]> = [
      ["quarantine absent", (facts) => { delete facts.row!.legacy_private_session_quarantine; }],
      ["quarantine undefined", (facts) => { facts.row!.legacy_private_session_quarantine = undefined; }],
      ["quarantine malformed", (facts) => { facts.row!.legacy_private_session_quarantine = "false" as any; }],
      ["quarantine true", (facts) => { facts.row!.legacy_private_session_quarantine = true; }],
      ["capability-ineligible absent", (facts) => { delete facts.row!.legacy_capability_ineligible; }],
      ["capability-ineligible undefined", (facts) => { facts.row!.legacy_capability_ineligible = undefined; }],
      ["capability-ineligible malformed", (facts) => { facts.row!.legacy_capability_ineligible = 0 as any; }],
      ["capability-ineligible true", (facts) => { facts.row!.legacy_capability_ineligible = true; }],
    ];
    for (const [name, mutate] of cases) {
      const candidate = cloneFacts(f.facts);
      mutate(candidate);
      assert.equal(resolveHostExecutionAuthorization(candidate).allowed, false, name);
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("arbitrary project/profile names authorize only through the exact injected witness", () => {
  const f = fixture();
  try {
    assert.equal(resolveHostExecutionAuthorization(f.facts).allowed, true);
    f.facts.profile!.name = "Renamed Without Authority Meaning";
    f.facts.project!.name = "Another Renamed Label";
    f.facts.profile!.builtin_kind = "neutral";
    f.facts.profile!.resource_mode = "project_only";
    f.facts.row!.provider = "different-provider";
    f.facts.row!.model = "different-model";
    assert.equal(resolveHostExecutionAuthorization(f.facts).allowed, true, "display, resource preference, and model metadata are inert");

    f.facts.profile!.name = "Wren";
    f.facts.project!.name = "Wren";
    f.facts.capabilityWitness = null;
    assert.equal(resolveHostExecutionAuthorization(f.facts).allowed, false, "Wren-shaped names grant nothing");
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("construction preserves every independent runtime and exact-binding denial fence", () => {
  const f = fixture();
  try {
    const cases: Array<[string, (facts: HostExecutionAuthorizationFacts) => void]> = [
      ["missing witness", (facts) => { facts.capabilityWitness = null; }],
      ["wrong capability", (facts) => { (facts.capabilityWitness as any).capabilityId = "wayang.protected-browser.v1"; }],
      ["malformed revision", (facts) => { (facts.capabilityWitness as any).associationRevision = 0; }],
      ["noninteractive", (facts) => { facts.isInteractive = false; }],
      ["subagent", (facts) => { facts.isSubagent = true; }],
      ["pending switch", (facts) => { facts.row!.pending_agent_switch = {
        switch_id: "switch", from_agent_profile_id: facts.profile!.id, from_provider: facts.row!.provider, from_model: facts.row!.model,
        to_agent_profile_id: "target", target_provider: "synthetic", target_model: "synthetic", changed_at: 1,
      }; }],
      ["durable profile drift", (facts) => { facts.row!.agent_profile_id = "other"; }],
      ["disabled profile", (facts) => { facts.profile!.enabled = false; }],
      ["Protected project", (facts) => { facts.project!.access_policy.privacy_mode = "protected"; }],
      ["project allowlist drift", (facts) => { facts.project!.access_policy.allowed_agent_profile_ids = ["other"]; }],
      ["scheduled job", (facts) => { facts.row!.scheduled_job_id = "job"; }],
      ["scheduled run", (facts) => { facts.row!.scheduled_run_id = "run"; }],
      ["authorization denial", (facts) => { facts.authorization.allowed = false; }],
      ["authorization project drift", (facts) => { facts.authorization.projectId = "other"; }],
      ["authorization profile drift", (facts) => { facts.authorization.agentProfileId = "other"; }],
      ["witness project drift", (facts) => { (facts.capabilityWitness as any).projectId = "other"; }],
      ["witness profile drift", (facts) => { (facts.capabilityWitness as any).agentProfileId = "other"; }],
      ["cwd drift", (facts) => { facts.requestedCwd = f.root; }],
    ];
    for (const [name, mutate] of cases) {
      const candidate = cloneFacts(f.facts);
      mutate(candidate);
      assert.equal(resolveHostExecutionAuthorization(candidate).allowed, false, name);
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("execute-time authorization denies generation, boot, handle, cwd, mode, and tool drift", () => {
  const f = fixture();
  try {
    const facts = withAuthorizedExecution(f.facts);
    assert.equal(resolveHostExecutionAuthorization(facts).allowed, true);
    const cases: Array<[string, (candidate: HostExecutionAuthorizationFacts) => void]> = [
      ["sandbox-selected runtime", (candidate) => { candidate.execution!.selectedBashMode = "sandboxed"; }],
      ["association replacement", (candidate) => { (candidate.capabilityWitness as any).associationRevision += 1; }],
      ["creation witness drift", (candidate) => { (candidate.execution!.expectedCapabilityWitness as any).associationRevision += 1; }],
      ["generation drift", (candidate) => { candidate.execution!.activeRuntimeGeneration = "stale"; }],
      ["boot drift", (candidate) => { candidate.execution!.activeProcessBootNonce = "stale"; }],
      ["session handle drift", (candidate) => { candidate.execution!.activeHandleSessionId = "other"; }],
      ["handle profile drift", (candidate) => { candidate.execution!.activeHandleAgentProfileId = "other"; }],
      ["handle cwd drift", (candidate) => { candidate.execution!.activeHandleCwd = f.root; }],
      ["spawn cwd drift", (candidate) => { candidate.execution!.spawnCwd = f.root; }],
      ["definition replacement", (candidate) => { candidate.execution!.trustedToolDefinition = false; }],
      ["executable replacement", (candidate) => { candidate.execution!.trustedToolExecutable = false; }],
    ];
    for (const [name, mutate] of cases) {
      const candidate = cloneFacts(facts);
      mutate(candidate);
      assert.equal(resolveHostExecutionAuthorization(candidate).allowed, false, name);
    }
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("execute-time capability revocation performs zero local execution and has no unsandboxed fallback", async () => {
  const f = fixture();
  try {
    const facts = withAuthorizedExecution(f.facts);
    let localExecCalls = 0;
    const local: BashOperations = { async exec() { localExecCalls++; return { exitCode: 0 }; } };
    const operations = createHostBashOperations({
      authorizeExecution: () => resolveHostExecutionAuthorization(facts),
      operations: local,
    });
    facts.capabilityWitness = null;
    await assert.rejects(
      operations.exec("printf must-not-run", facts.requestedCwd, { onData() {} }),
      /denied host execution before local execution/,
    );
    assert.equal(localExecCalls, 0);
  } finally {
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test("host execution reauthorizes again before releasing the local result", async () => {
  let calls = 0;
  let localCalls = 0;
  const operations = createHostBashOperations({
    authorizeExecution: () => {
      calls += 1;
      return calls === 1 ? { allowed: true, witness: witness() } : { allowed: false, reason: "revoked before release" };
    },
    operations: { async exec() { localCalls += 1; return { exitCode: 0 }; } },
  });
  await assert.rejects(
    operations.exec("printf synthetic", process.cwd(), { onData() {} }),
    /suppressed host execution result before release/,
  );
  assert.equal(localCalls, 1);
  assert.equal(calls, 2);
});

test("host tool uses generic labeling and retains candid same-user and sudo warnings", () => {
  const tool = createHostBashToolDefinition(process.cwd(), {
    authorizeExecution: () => ({ allowed: false, reason: "synthetic" }),
    operations: { async exec() { return { exitCode: 0 }; } },
  });
  assert.equal(tool.label, "bash (Wayang host)");
  assert.doesNotMatch(tool.description, /Wren/);
  assert.match(tool.description, /normal Wayang OS user/);
  assert.match(tool.description, /recognized direct lexical sudo syntax/);
  assert.match(tool.description, /does not contain indirect or other host privilege mechanisms/);
  assert.match(tool.description, /cooperative/);
});

test("Pi SDK preserves the exact trusted generic host definition and executable", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-host-sdk-wrapper-"));
  const cwd = path.join(root, "project");
  const agentDir = path.join(root, "agent");
  fs.mkdirSync(cwd);
  fs.mkdirSync(agentDir);
  const definition = createHostBashToolDefinition(cwd, {
    authorizeExecution: () => ({ allowed: false, reason: "not exercised" }),
    operations: { async exec() { return { exitCode: 0 }; } },
  });
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    sessionManager: SessionManager.inMemory(cwd),
    tools: ["bash"],
    customTools: [definition],
  });
  try {
    await session.bindExtensions({});
    const anySession = session as any;
    const executable = resolveHostBashExecutable(anySession, definition);
    assert.ok(executable);
    assert.notEqual(executable, definition);
    const definitions = anySession._toolDefinitions;
    anySession._toolDefinitions = new Map([["bash", { definition: { ...definition } }]]);
    assert.equal(resolveHostBashExecutable(anySession, definition), undefined);
    anySession._toolDefinitions = definitions;
    const registry = anySession._toolRegistry;
    anySession._toolRegistry = new Map([["bash", { ...executable }]]);
    assert.equal(resolveHostBashExecutable(anySession, definition), undefined);
    anySession._toolRegistry = registry;
    anySession.agent.state.tools = [{ ...executable }];
    assert.equal(resolveHostBashExecutable(anySession, definition), undefined);
  } finally {
    session.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("Pi registry replacement permanently revokes stale and refreshed wrappers before local execution", async () => {
  let revoked = false;
  let localExecCalls = 0;
  const authorizeExecution = () => revoked
    ? { allowed: false as const, reason: "synthetic registry replacement" }
    : { allowed: true as const, witness: witness() };
  const operations = { async exec() { localExecCalls++; return { exitCode: 0 }; } };
  const staleTool = createHostBashToolDefinition(process.cwd(), { authorizeExecution, operations });
  const refreshedTool = { ...staleTool, async execute(...args: unknown[]) { return staleTool.execute(...args); } };
  const session: any = {
    _toolDefinitions: new Map([["bash", { definition: staleTool }]]),
    _toolRegistry: new Map([["bash", staleTool]]),
    agent: { state: { tools: [staleTool] } },
    _refreshToolRegistry() {
      this._toolDefinitions = new Map([["bash", { definition: staleTool }]]);
      this._toolRegistry = new Map([["bash", refreshedTool]]);
    },
    setActiveToolsByName() {},
  };
  const originalDefinitions = session._toolDefinitions;
  const originalRegistry = session._toolRegistry;
  const guard = installHostBashRegistryGuard({
    session,
    definition: staleTool,
    executable: staleTool,
    execute: staleTool.execute,
    onRevoke: () => { revoked = true; },
  });
  session._refreshToolRegistry();
  assert.equal(guard.revoked, true);
  session._toolDefinitions = originalDefinitions;
  session._toolRegistry = originalRegistry;
  assert.equal(guard.checkCurrent(), false, "restoring registries cannot restore authority");
  for (const [name, tool] of [["stale", staleTool], ["refreshed", refreshedTool]] as const) {
    await assert.rejects(
      (tool.execute as any)(`${name}-call`, { command: "printf must-not-run" }, new AbortController().signal, () => undefined),
      /synthetic registry replacement/,
      name,
    );
  }
  assert.equal(localExecCalls, 0);
});

test("registry or in-place tool-definition drift permanently revokes stale wrappers", async () => {
  let revoked = false;
  let localExecCalls = 0;
  const toolOptions = {
    authorizeExecution: () => revoked
      ? { allowed: false as const, reason: "synthetic permanent registry revocation" }
      : { allowed: true as const, witness: witness() },
    operations: { async exec() { localExecCalls++; return { exitCode: 0 }; } },
  };
  const staleTool = createHostBashToolDefinition(process.cwd(), toolOptions);
  const session: any = {
    _toolDefinitions: new Map([["bash", { definition: staleTool }]]),
    _toolRegistry: new Map([["bash", staleTool]]),
    agent: { state: { tools: [staleTool] } },
    _refreshToolRegistry() {},
    setActiveToolsByName() {},
  };
  const guard = installHostBashRegistryGuard({
    session,
    definition: staleTool,
    executable: staleTool,
    execute: staleTool.execute,
    onRevoke: () => { revoked = true; },
  });

  staleTool.label = "mutated in place";
  assert.equal(guard.checkCurrent(), false);
  staleTool.label = "bash (Wayang host)";
  assert.equal(guard.checkCurrent(), false, "restoring values cannot restore authority");
  await assert.rejects(
    (staleTool.execute as any)("stale-call", { command: "printf must-not-run" }, new AbortController().signal, () => undefined),
    /synthetic permanent registry revocation/,
  );
  assert.equal(localExecCalls, 0);
});

test("host environment strips internal names without reading values and validates user-bus metadata", () => {
  const uid = 12345;
  const runtimeRoot = "/synthetic-wayang/run/user";
  const runtimeDir = path.join(runtimeRoot, String(uid));
  let protectedReads = 0;
  const source: NodeJS.ProcessEnv = { PUBLIC_VALUE: "kept" };
  Object.defineProperty(source, "WAYANG_COMMAND_GUARD_RECOVERY_PIN", {
    enumerable: true,
    get() { protectedReads++; return "synthetic-protected-value"; },
  });
  const env = buildHostChildEnvironment(source, { uid, runtimeRoot, fs: syntheticUserBusFs({ uid, runtimeRoot }) });
  assert.equal(protectedReads, 0);
  assert.equal(env.PUBLIC_VALUE, "kept");
  assert.equal(env.WAYANG_COMMAND_GUARD_RECOVERY_PIN, undefined);
  assert.equal(env.XDG_RUNTIME_DIR, runtimeDir);
  assert.equal(env.DBUS_SESSION_BUS_ADDRESS, `unix:path=${path.join(runtimeDir, "bus")}`);

  for (const [name, fsAdapter] of [
    ["wrong owner", syntheticUserBusFs({ uid, runtimeRoot, runtimeOwner: uid + 1 })],
    ["directory symlink", syntheticUserBusFs({ uid, runtimeRoot, runtimeSymlink: true })],
    ["wrong socket owner", syntheticUserBusFs({ uid, runtimeRoot, busOwner: uid + 1 })],
    ["socket symlink", syntheticUserBusFs({ uid, runtimeRoot, busSymlink: true })],
    ["wrong type", syntheticUserBusFs({ uid, runtimeRoot, busKind: "file" })],
    ["absent", syntheticUserBusFs({ uid, runtimeRoot, busPresent: false })],
  ] as const) {
    const denied = buildHostChildEnvironment(source, { uid, runtimeRoot, fs: fsAdapter });
    assert.equal(denied.XDG_RUNTIME_DIR, undefined, name);
    assert.equal(denied.DBUS_SESSION_BUS_ADDRESS, undefined, name);
  }
});
