import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { Type } from "@earendil-works/pi-ai";
import { SessionManager, defineTool } from "@earendil-works/pi-coding-agent";
import {
  abortInteractiveTurn,
  appendStreamingMessageToHistory,
  beginInteractiveTurn,
  beginNonBrowserTurn,
  classifyScheduledPromptResult,
  cleanupPiSessionCapabilityDenial,
  closePiSessionAuthorities,
  composeRuntimeActiveTools,
  createPiSession,
  destroyPiSession,
  fileAudioExperimentRuntimeIsEligible,
  getPiSession,
  getPiSessionBashMode,
  getPiSessionRuntimeState,
  getSessionFileMessageHistory,
  getSessionFileSnapshot,
  invalidateSessionFileSnapshot,
  installInteractiveBrowserSessionLifecyclePort,
  installWayangRawSudoFailClosedGuard,
  latchPiSessionCapabilityDenial,
  interviewSubmissionContent,
  listModels,
  markClaimedQueuedBrowserTurnsReady,
  onPiSessionRuntimeEvent,
  persistSettledSessionError,
  trackOverflowRecovery,
  piSessionHandleRequiresFreshRuntime,
  previewSessionAgentSwitch,
  protectedBrowserIdleRetentionIsRequired,
  reconcilePendingAgentSwitch,
  resolveInteractiveBrowserAuthority,
  resolveInteractiveTurn,
  sendBrowserMessageTurn,
  settleInteractiveTurns,
  setSessionDefaultModel,
  setSessionModel,
  stopPiSession,
  waitForScheduledPrompt,
  type PiSessionBrowserTeardown,
  type PiSessionHandle,
  type PiSessionRuntimeEvent,
  type ScheduledPromptSession,
} from "./pi-bridge.js";
import { createAgentProfile } from "./agent-profiles.js";
import { close, getStore, init } from "./db.js";
import { createProject } from "./projects.js";
import { beginAgentSwitch, createSession, getSessionById, updatePiSessionFile } from "./sessions.js";
import { browserTurnContentHash } from "./interactive-turn-provenance.js";
import { createHostBashOperations } from "./host-execution.js";
import { commitWorkspaceCapabilityActivation, resolveWorkspaceCapability, revokeWorkspaceCapabilityAssociation } from "./workspace-capabilities.js";
import type { PendingAgentSwitch } from "./workspace-types.js";
import type { ProtectedBrowserToolRuntime } from "./browser/protected-tools.js";
import type { ProtectedBrowserBinding } from "./browser/types.js";
import { getActionApprovalBridge } from "./action-approval-bridge.js";
import { setAutoTitleProviderForTests } from "./session-title-service.js";
import { extractCompletedTitleExchanges } from "./session-title-policy.js";

function syntheticProtectedRuntime(
  mode: "agent" | "user" | "paused",
  options: { revoked?: boolean; allowed?: boolean } = {},
) {
  return {
    browser: { mode, isRevoked: options.revoked ?? false },
    preflight: () => options.allowed === false
      ? { allowed: false as const, reason: "synthetic denial" }
      : { allowed: true as const },
  } as Pick<ProtectedBrowserToolRuntime, "browser" | "preflight">;
}

test("runtime companion tools preserve unrestricted policy and only widen explicit lists", () => {
  assert.equal(composeRuntimeActiveTools(undefined, ["browser_status"]), undefined);
  assert.deepEqual(
    composeRuntimeActiveTools(["read", "bash"], ["browser_status", "bash"]),
    ["read", "bash", "browser_status"],
  );
});

test("file-audio experiment eligibility is disabled-by-default and exact Wren Standard interactive only", () => {
  const eligible = {
    session: {
      agent_profile_id: "00000000-0000-4000-8000-000000000001",
      pending_agent_switch: null,
      legacy_private_session_quarantine: false,
      legacy_capability_ineligible: false,
      scheduled_job_id: null,
      scheduled_run_id: null,
    },
    profile: {
      id: "00000000-0000-4000-8000-000000000001",
      builtin_kind: "wren",
      enabled: true,
    },
    project: { access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null } },
  } as any;
  assert.equal(fileAudioExperimentRuntimeIsEligible({ enabled: false, ...eligible }), false);
  assert.equal(fileAudioExperimentRuntimeIsEligible({ enabled: true, ...eligible }), true);
  assert.equal(fileAudioExperimentRuntimeIsEligible({
    enabled: true, ...eligible, profile: { ...eligible.profile, id: "lookalike" },
  }), false);
  assert.equal(fileAudioExperimentRuntimeIsEligible({
    enabled: true, ...eligible, project: { access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: null } },
  }), false);
  assert.equal(fileAudioExperimentRuntimeIsEligible({
    enabled: true, ...eligible, session: { ...eligible.session, scheduled_job_id: "scheduled" },
  }), false);
});

test("automatic idle cleanup retains live protected human control", () => {
  assert.equal(protectedBrowserIdleRetentionIsRequired(syntheticProtectedRuntime("user")), true);
  assert.equal(protectedBrowserIdleRetentionIsRequired(syntheticProtectedRuntime("paused")), true);
  assert.equal(protectedBrowserIdleRetentionIsRequired(syntheticProtectedRuntime("agent")), false);
  assert.equal(protectedBrowserIdleRetentionIsRequired(syntheticProtectedRuntime("paused", { revoked: true })), false);
  assert.equal(protectedBrowserIdleRetentionIsRequired(syntheticProtectedRuntime("paused", { allowed: false })), false);
  assert.equal(protectedBrowserIdleRetentionIsRequired(undefined), false);
});

test("a later prompt rebuilds denied or revoked handles instead of returning stale authority", () => {
  const handle = (protectedBrowserRuntime?: Pick<ProtectedBrowserToolRuntime, "browser" | "preflight">, capabilityAuthorityDenied = false) => ({
    capabilityAuthorityDenied,
    protectedBrowserRuntime: protectedBrowserRuntime as ProtectedBrowserToolRuntime | undefined,
  });
  assert.equal(piSessionHandleRequiresFreshRuntime(handle()), false);
  assert.equal(piSessionHandleRequiresFreshRuntime(handle(syntheticProtectedRuntime("agent"))), false);
  assert.equal(piSessionHandleRequiresFreshRuntime(handle(syntheticProtectedRuntime("paused", { revoked: true }))), true);
  assert.equal(piSessionHandleRequiresFreshRuntime(handle(syntheticProtectedRuntime("agent", { allowed: false }))), true);
  assert.equal(piSessionHandleRequiresFreshRuntime(handle(undefined, true)), true);
});

// Every Pi SDK singleton in this test file must use synthetic storage; never
// inspect or mutate the operator's real auth/settings/extensions/session tree.
const previousPiAgentDir = process.env.PI_CODING_AGENT_DIR;
const syntheticPiAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-pi-bridge-agent-dir-"));
process.env.PI_CODING_AGENT_DIR = syntheticPiAgentDir;
after(() => {
  if (previousPiAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousPiAgentDir;
  fs.rmSync(syntheticPiAgentDir, { recursive: true, force: true });
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function currentTurnFixture(name: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  const cwd = path.join(dir, "protected-project");
  const sessionDir = path.join(dir, "pi-sessions");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  init();
  const profile = createAgentProfile({ name: "Protected fixture", resource_mode: "project_only", memory_access: "read" });
  const project = createProject({
    cwd,
    name: "Protected fixture",
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
  });
  return {
    dir,
    cwd,
    sessionDir,
    profile,
    project,
    cleanup() {
      close();
      if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
      else process.env.WAYANG_DATA_DIR = previousDataDir;
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("settled lifecycle persists terminal assistant and compaction failures", () => {
  const f = currentTurnFixture("wayang-settled-error-");
  try {
    const row = createSession(f.cwd, { agentProfileId: f.profile.id });
    const handle = {
      id: row.id,
      session: { messages: [{ role: "assistant", content: [], stopReason: "error", errorMessage: "Context window exceeded" }] },
    } as unknown as PiSessionHandle;
    persistSettledSessionError(handle, { type: "agent_settled" } as any);
    assert.equal(getSessionById(row.id)?.error, "Context window exceeded");

    (handle.session as any).messages = [];
    persistSettledSessionError(handle, {
      type: "compaction_end",
      reason: "overflow",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "Context overflow recovery failed: synthetic",
    } as any);
    persistSettledSessionError(handle, { type: "agent_settled" } as any);
    assert.equal(getSessionById(row.id)?.error, "Context overflow recovery failed: synthetic");

    persistSettledSessionError(handle, {
      type: "compaction_end",
      reason: "manual",
      result: { summary: "recovered", firstKeptEntryId: "entry", tokensBefore: 100, estimatedTokensAfter: 10 },
      aborted: false,
      willRetry: false,
    } as any);
    assert.equal(getSessionById(row.id)?.error, null);
  } finally {
    f.cleanup();
  }
});

test("Pi bridge stopped projections never infer host authority from durable identity", () => {
  assert.equal(getPiSessionBashMode("synthetic-stopped-session"), "unavailable");
});

test("Pi bridge emits one authoritative unavailable event when generic authorities close", async () => {
  const events: PiSessionRuntimeEvent[] = [];
  const unsubscribe = onPiSessionRuntimeEvent((event) => events.push(event));
  const handle = { id: "synthetic-runtime-event-session", bashMode: "sandboxed", interactiveTurns: new Map() } as unknown as PiSessionHandle;
  try {
    await closePiSessionAuthorities(handle);
    await closePiSessionAuthorities(handle);
    assert.equal(handle.bashMode, "unavailable");
    assert.equal(handle.trustedHostBashTool, undefined);
    assert.deepEqual(events, [{ type: "runtime_state_changed", sessionId: handle.id, bashMode: "unavailable" }]);
  } finally { unsubscribe(); }
});

test("Pi bridge dispatches every typed browser teardown operation and reason without inference", async () => {
  const cases: Array<{ action: PiSessionBrowserTeardown; expected: string }> = [
    { action: { kind: "detach", reason: "pi_idle" }, expected: "detach:pi_idle" },
    { action: { kind: "detach", reason: "runtime_replaced" }, expected: "detach:runtime_replaced" },
    { action: { kind: "detach", reason: "model_or_agent_switch" }, expected: "detach:model_or_agent_switch" },
    { action: { kind: "close_session", reason: "archive" }, expected: "close:archive" },
    { action: { kind: "close_session", reason: "session_delete" }, expected: "close:session_delete" },
    { action: { kind: "close_session", reason: "owner_close_all" }, expected: "close:owner_close_all" },
    { action: { kind: "revoke", reason: "capability_revoked" }, expected: "revoke:capability_revoked" },
    { action: { kind: "revoke", reason: "project_or_profile_denied" }, expected: "revoke:project_or_profile_denied" },
    { action: { kind: "revoke", reason: "service_shutdown" }, expected: "revoke:service_shutdown" },
  ];
  for (const { action, expected } of cases) {
    const calls: string[] = [];
    const session: any = {
      clearQueue() {},
      setActiveToolsByName() {},
      abort() {},
      _toolRegistry: new Map(),
      _toolDefinitions: new Map(),
      agent: { state: { tools: [] }, async beforeToolCall() {} },
    };
    const handle = {
      id: `synthetic-browser-teardown-${expected}`,
      session,
      runtimeGeneration: "synthetic-runtime-generation",
      bashMode: "unavailable",
      events: new EventEmitter(),
      protectedBrowserRuntime: {
        kind: "standard",
        binding: { sourceSessionId: "synthetic" },
        tools: [],
        toolForName() { return undefined; },
        preflight() { return { allowed: true as const }; },
        detachAgentLease(reason: string) { calls.push(`detach:${reason}`); return Promise.resolve(); },
        closeSessionWorkspaces(reason: string) { calls.push(`close:${reason}`); return Promise.resolve(); },
        revokeAuthority(reason: string) { calls.push(`revoke:${reason}`); return Promise.resolve(); },
      },
    } as unknown as PiSessionHandle;
    await closePiSessionAuthorities(handle, action);
    assert.deepEqual(calls, [expected]);
  }
});

test("archive/delete lifecycle reaches detached Standard workspaces without a live Pi handle", async () => {
  const calls: string[] = [];
  const uninstall = installInteractiveBrowserSessionLifecyclePort({
    closeSessionWorkspaces(sourceSessionId, reason) {
      calls.push(`${sourceSessionId}:${reason}`);
      return Promise.resolve();
    },
    revokeAuthority() { return Promise.resolve(); },
    blocksPiIdleDetach() { return false; },
    close() { return Promise.resolve(); },
  });
  try {
    await stopPiSession("synthetic-detached-archive", { kind: "close_session", reason: "archive" });
    await stopPiSession("synthetic-detached-delete", { kind: "close_session", reason: "session_delete" });
    assert.deepEqual(calls, [
      "synthetic-detached-archive:archive",
      "synthetic-detached-delete:session_delete",
    ]);
  } finally {
    uninstall();
  }
});

test("detached browser authority revocation reaches the process owner synchronously without a Pi handle", async () => {
  const calls: string[] = [];
  const uninstall = installInteractiveBrowserSessionLifecyclePort({
    closeSessionWorkspaces() { return Promise.resolve(); },
    revokeAuthority(scope, reason) {
      calls.push(`${scope.capabilityId}:${scope.projectId}:${scope.agentProfileId}:${reason}`);
      return Promise.resolve();
    },
    blocksPiIdleDetach() { return false; },
    close() { return Promise.resolve(); },
  });
  const runtimeId = "synthetic-detached-capability-revoke";
  try {
    latchPiSessionCapabilityDenial(
      [runtimeId],
      { get: () => undefined },
      { kind: "revoke", reason: "capability_revoked" },
      {
        capabilityId: "wayang.standard-browser.v1",
        projectId: "synthetic-project",
        agentProfileId: "synthetic-profile",
      },
    );
    assert.deepEqual(calls, ["wayang.standard-browser.v1:synthetic-project:synthetic-profile:capability_revoked"]);
    await cleanupPiSessionCapabilityDenial([runtimeId]);
  } finally {
    uninstall();
  }
});

test("neutral Standard human-control retention consults the process lifecycle owner", () => {
  const binding: any = { sourceSessionId: "synthetic-retained-standard" };
  const runtime: any = { kind: "standard", binding, preflight: () => ({ allowed: true }) };
  const uninstall = installInteractiveBrowserSessionLifecyclePort({
    closeSessionWorkspaces() { return Promise.resolve(); },
    revokeAuthority() { return Promise.resolve(); },
    blocksPiIdleDetach(candidate) { return candidate === binding; },
    close() { return Promise.resolve(); },
  });
  try { assert.equal(protectedBrowserIdleRetentionIsRequired(runtime), true); }
  finally { uninstall(); }
});

test("Pi bridge capability denial latches tools and aborts active runtime authority before async cleanup", async () => {
  const cleanupRelease = deferred();
  const order: string[] = [];
  let queueClears = 0;
  let agentAborts = 0;
  const hostTool = { name: "bash" };
  const protectedTool = { name: "protected_browser" };
  const audioTool = { name: "file_audio_experiment" };
  const fakeSession: any = {
    clearQueue() { queueClears++; return { steering: ["queued"], followUp: [] }; },
    setActiveToolsByName(names: string[]) { this.agent.state.tools = names; },
    abort() { agentAborts++; order.push("agent-aborted"); return Promise.resolve(); },
    _toolRegistry: new Map([["bash", hostTool], ["protected_browser", protectedTool], ["file_audio_experiment", audioTool]]),
    _toolDefinitions: new Map([["bash", {}], ["protected_browser", {}], ["file_audio_experiment", {}]]),
    agent: { state: { tools: [hostTool, protectedTool, audioTool] }, async beforeToolCall() { return undefined; } },
  };
  const handle = {
    id: "synthetic-denial-session",
    session: fakeSession,
    runtimeGeneration: "old-generation",
    bashMode: "host",
    trustedHostBashTool: {
      revoked: false,
      revokeActiveExecutions() { order.push("host-terminated"); return Promise.resolve(); },
    },
    protectedBrowserRuntime: {
      detachAgentLease() { order.push("protected-latched"); return cleanupRelease.promise; },
    },
    restrictedMcpRuntime: {
      close() { order.push("restricted-latched"); return cleanupRelease.promise; },
    },
    fileAudioExperimentRuntime: {
      close() { order.push("audio-latched"); return cleanupRelease.promise; },
    },
    interactiveTurns: new Map([["stale", { token: "stale" }]]),
  } as unknown as PiSessionHandle;
  const actionBridge = getActionApprovalBridge();
  const detachApprovalClient = actionBridge.attachClient(handle.id, "synthetic-denial-client");
  const approval = actionBridge.requestApproval(handle.id, {
    connector: "synthetic-connector",
    toolName: "write_after_revocation",
    summary: "Synthetic write that must be cancelled by capability denial",
    argumentsHash: "a".repeat(64),
  });
  assert.equal(actionBridge.getPendingRequests(handle.id).length, 1);

  latchPiSessionCapabilityDenial([handle.id], { get: (id) => id === handle.id ? handle : undefined });
  assert.equal(actionBridge.getPendingRequests(handle.id).length, 0);
  assert.equal((await approval).status, "cancelled");
  detachApprovalClient();
  assert.equal(handle.capabilityAuthorityDenied, true);
  assert.notEqual(handle.runtimeGeneration, "old-generation");
  assert.equal(handle.bashMode, "unavailable");
  assert.equal(handle.trustedHostBashTool, undefined);
  assert.equal(handle.protectedBrowserRuntime, undefined);
  assert.equal(handle.fileAudioExperimentRuntime, undefined);
  assert.equal(handle.interactiveTurns.size, 0);
  assert.equal(queueClears, 1);
  assert.equal(agentAborts, 1, "Pi abort starts synchronously after authority denial");
  assert.deepEqual(fakeSession.agent.state.tools, []);
  assert.equal(fakeSession._toolRegistry.has("bash"), false);
  assert.equal(fakeSession._toolRegistry.has("protected_browser"), false);
  assert.equal(fakeSession._toolRegistry.has("file_audio_experiment"), false);
  assert.deepEqual(
    order.sort(),
    ["agent-aborted", "audio-latched", "host-terminated", "protected-latched", "restricted-latched"],
    "host, agent, and companion teardown prefixes run before cleanup awaits",
  );
  assert.deepEqual(await fakeSession.agent.beforeToolCall(), {
    block: true,
    reason: "Workspace capability authority was denied; a fresh runtime is required",
  });

  cleanupRelease.resolve();
  await closePiSessionAuthorities(handle);
});

test("capability denial cancels external actions before a starting runtime publishes a handle", async () => {
  const sessionId = "synthetic-starting-denial-session";
  const actionBridge = getActionApprovalBridge();
  const detachApprovalClient = actionBridge.attachClient(sessionId, "synthetic-starting-denial-client");
  const approval = actionBridge.requestApproval(sessionId, {
    connector: "synthetic-connector",
    toolName: "write_before_publication",
    summary: "Synthetic starting-runtime write that must be cancelled",
    argumentsHash: "b".repeat(64),
  });
  assert.equal(actionBridge.getPendingRequests(sessionId).length, 1);

  latchPiSessionCapabilityDenial([sessionId], { get: () => undefined });

  assert.equal(actionBridge.getPendingRequests(sessionId).length, 0);
  assert.equal((await approval).status, "cancelled");
  detachApprovalClient();
});

test("capability invalidation TERM/KILLs an active host process group before delayed mutation", {
  skip: process.platform === "win32",
}, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-host-revocation-mutation-"));
  const started = path.join(dir, "started");
  const mutated = path.join(dir, "mutated");
  const operations = createHostBashOperations({
    authorizeExecution: () => ({
      allowed: true,
      witness: {
        capabilityId: "wayang.host-execution.v1",
        projectId: "synthetic",
        agentProfileId: "synthetic",
        associationRevision: 1,
      },
    }),
  });
  let agentAborts = 0;
  const handle = {
    id: "synthetic-active-host-revocation",
    runtimeGeneration: "active-generation",
    bashMode: "host",
    interactiveTurns: new Map(),
    trustedHostBashTool: {
      revoked: false,
      revokeActiveExecutions: () => operations.revoke(),
    },
    session: {
      clearQueue() { return { steering: [], followUp: [] }; },
      setActiveToolsByName() {},
      abort() { agentAborts++; return Promise.resolve(); },
      agent: { state: { tools: [] }, async beforeToolCall() { return undefined; } },
      _toolRegistry: new Map(),
      _toolDefinitions: new Map(),
    },
  } as unknown as PiSessionHandle;

  try {
    const running = operations.exec(
      `(trap '' TERM; printf started > ${JSON.stringify(started)}; sleep 0.8; printf late > ${JSON.stringify(mutated)}) & wait`,
      dir,
      { onData() {} },
    );
    const deadline = Date.now() + 2_000;
    while (!fs.existsSync(started) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.equal(fs.existsSync(started), true, "the host process reached its delayed-mutation window");

    latchPiSessionCapabilityDenial([handle.id], { get: (id) => id === handle.id ? handle : undefined });
    assert.equal(handle.capabilityAuthorityDenied, true);
    assert.equal(agentAborts, 1, "the streaming Pi turn is aborted synchronously");
    await assert.rejects(running, /aborted/);
    await closePiSessionAuthorities(handle);
    await new Promise((resolve) => setTimeout(resolve, 900));
    assert.equal(fs.existsSync(mutated), false, "TERM-ignoring descendants are killed before delayed mutation");
  } finally {
    await operations.revoke();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("starting runtime revocation fences privileged loading and publication, while a fresh generation can re-resolve the pair", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-starting-revocation-"));
  const cwd = path.join(dir, "project");
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  fs.mkdirSync(cwd, { recursive: true });
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  init();
  const profile = createAgentProfile({ name: "Starting revocation fixture", resource_mode: "standard" });
  const project = createProject({
    cwd,
    name: "Starting revocation fixture",
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  const row = createSession(cwd, { provider: "synthetic-provider", model: "synthetic-model", agentProfileId: profile.id });
  const initialAssociation = commitWorkspaceCapabilityActivation({
    capability_id: "wayang.standard-resources.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "a".repeat(64),
  });
  const entered = deferred();
  const release = deferred();
  const effects: string[] = [];

  try {
    const creating = createPiSession(row.id, cwd, row.provider, row.model, null, {
      testHooks: {
        async afterStandardResourcesResolution(authorized) {
          assert.equal(authorized, true);
          entered.resolve();
          await release.promise;
        },
        onPrivilegedEffect(effect) { effects.push(effect); },
      },
    });
    await entered.promise;
    assert.equal(getPiSessionRuntimeState(row.id).runtime_status, "starting");

    latchPiSessionCapabilityDenial([row.id]);
    const cleanup = cleanupPiSessionCapabilityDenial([row.id]);
    assert.equal(getPiSession(row.id), undefined);
    assert.deepEqual(effects, [] as string[], "no loader, extension lifecycle, tool runtime, AgentSession, or handle was published");
    release.resolve();
    await assert.rejects(creating, /creation was revoked/);
    await cleanup;
    assert.equal(getPiSessionRuntimeState(row.id).runtime_status, "stopped");
    assert.equal(getPiSession(row.id), undefined);
    assert.deepEqual(effects, [] as string[]);

    revokeWorkspaceCapabilityAssociation({
      capability_id: initialAssociation.capability_id,
      project_id: initialAssociation.project_id,
      agent_profile_id: initialAssociation.agent_profile_id,
      expected_revision: initialAssociation.revision,
    });
    const currentAssociation = commitWorkspaceCapabilityActivation({
      capability_id: "wayang.standard-resources.v1",
      project_id: project.id,
      agent_profile_id: profile.id,
      operation_digest: "b".repeat(64),
    });
    const currentResolution = resolveWorkspaceCapability({
      capability_id: "wayang.standard-resources.v1",
      project_id: project.id,
      agent_profile_id: profile.id,
    });
    assert.equal(currentResolution.authorized && currentResolution.association.revision, currentAssociation.revision);
    assert.ok(currentAssociation.revision > initialAssociation.revision);

    let freshAuthorized = false;
    await assert.rejects(
      createPiSession(row.id, cwd, row.provider, row.model, null, {
        testHooks: {
          async afterStandardResourcesResolution(authorized) {
            freshAuthorized = authorized;
            throw new Error("synthetic fresh-generation stop");
          },
          onPrivilegedEffect(effect) { effects.push(effect); },
        },
      }),
      /synthetic fresh-generation stop/,
    );
    assert.equal(freshAuthorized, true, "a later creation captures the advanced generation and re-resolves the current association");
    assert.deepEqual(effects, [] as string[]);

    const destroyEntered = deferred();
    const destroyRelease = deferred();
    const destroyedCreation = createPiSession(row.id, cwd, row.provider, row.model, null, {
      testHooks: {
        async afterStandardResourcesResolution() {
          destroyEntered.resolve();
          await destroyRelease.promise;
        },
      },
    });
    await destroyEntered.promise;
    const destroyed = destroyPiSession(row.id, { kind: "close_session", reason: "archive" });
    destroyRelease.resolve();
    await assert.rejects(destroyedCreation, /creation was revoked/);
    await destroyed;
    assert.equal(getPiSessionRuntimeState(row.id).runtime_status, "stopped", "destroy fences an unpublished creation");
  } finally {
    release.resolve();
    await cleanupPiSessionCapabilityDenial([row.id]);
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("pending interactive-browser authority survives through exact Standard runtime publication", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-standard-browser-publication-"));
  const cwd = path.join(dir, "project");
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  fs.mkdirSync(cwd, { recursive: true });
  process.env.WAYANG_DATA_DIR = path.join(dir, "data");
  process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
  init();
  const profile = createAgentProfile({ name: "Standard browser publication", resource_mode: "project_only" });
  const project = createProject({
    cwd,
    name: "Standard browser publication",
    default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] },
  });
  commitWorkspaceCapabilityActivation({
    capability_id: "wayang.standard-browser.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "c".repeat(64),
  });
  commitWorkspaceCapabilityActivation({
    capability_id: "wayang.standard-resources.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "d".repeat(64),
  });
  commitWorkspaceCapabilityActivation({
    capability_id: "wayang.host-execution.v1",
    project_id: project.id,
    agent_profile_id: profile.id,
    operation_digest: "e".repeat(64),
  });
  const row = createSession(cwd, {
    provider: "anthropic",
    model: "claude-sonnet-4-5",
    agentProfileId: profile.id,
  });
  let factorySawPendingAuthority = false;
  let publishedBinding: Readonly<ProtectedBrowserBinding> | null = null;
  let runtimeRevoked = false;
  const tool = defineTool({
    name: "browser_publication_probe",
    label: "Browser publication probe",
    description: "Synthetic browser publication lifecycle probe.",
    parameters: Type.Object({}, { additionalProperties: false }),
    async execute() { return { content: [{ type: "text" as const, text: "ok" }], details: {} }; },
  });
  let publicationEventAttempted = false;
  const removeThrowingListener = onPiSessionRuntimeEvent((event) => {
    if (event.type === "runtime_state_changed" && event.sessionId === row.id) {
      publicationEventAttempted = true;
      throw new Error("synthetic post-publication observer failure");
    }
  });

  try {
    const handle = await createPiSession(row.id, cwd, row.provider, row.model, null, {
      protectedBrowserFactory(binding) {
        publishedBinding = binding;
        factorySawPendingAuthority = resolveInteractiveBrowserAuthority(binding) !== null;
        const runtime = {
          kind: "standard" as const,
          binding,
          tools: Object.freeze([tool]),
          toolForName: (name: string) => name === tool.name ? tool : undefined,
          preflight: () => !runtimeRevoked && resolveInteractiveBrowserAuthority(binding)
            ? { allowed: true as const }
            : { allowed: false as const, reason: "synthetic authority unavailable" },
          async detachAgentLease() { runtimeRevoked = true; },
          async closeSessionWorkspaces() { runtimeRevoked = true; },
          async revokeAuthority() { runtimeRevoked = true; },
        };
        return runtime;
      },
    });
    removeThrowingListener();
    assert.equal(publicationEventAttempted, true);
    assert.equal(factorySawPendingAuthority, true, "the exact pending witness authorizes factory construction");
    assert.equal(handle.protectedBrowserRuntime?.preflight().allowed, true,
      "the published handle takes over authority without a revoked gap");
    assert.equal((handle.session as any)._toolRegistry?.has?.(tool.name), true,
      "the validated Standard browser tool publishes with the fresh runtime");
    assert.equal(handle.bashMode, "host");
    assert.ok(handle.trustedHostBashTool, "browser companion activation must preserve exact trusted host bash");
    assert.equal((handle.session as any)._toolDefinitions?.get?.("bash")?.definition,
      handle.trustedHostBashTool?.definition);
    const unrestrictedActiveTools = new Set(handle.session.getActiveToolNames());
    for (const name of ["read", "edit", "write", "bash", tool.name]) {
      assert.equal(unrestrictedActiveTools.has(name), true, `unrestricted active tool ${name}`);
    }
    await destroyPiSession(row.id);
    assert.ok(publishedBinding);
    assert.equal(resolveInteractiveBrowserAuthority(publishedBinding), null,
      "destroyed live authority cannot fall back to a stale pending witness");

    const invalidRow = createSession(cwd, {
      provider: "anthropic",
      model: "claude-sonnet-4-5",
      agentProfileId: profile.id,
    });
    const invalidCleanupEntered = deferred();
    const invalidCleanupRelease = deferred();
    let invalidBinding: Readonly<ProtectedBrowserBinding> | null = null;
    const invalidCreation = createPiSession(invalidRow.id, cwd, invalidRow.provider, invalidRow.model, null, {
      protectedBrowserFactory(binding) {
        invalidBinding = binding;
        return {
          kind: "protected" as const,
          binding,
          tools: Object.freeze([tool]),
          toolForName: (name: string) => name === tool.name ? tool : undefined,
          preflight: () => resolveInteractiveBrowserAuthority(binding)
            ? { allowed: true as const }
            : { allowed: false as const, reason: "synthetic authority unavailable" },
          async detachAgentLease() {},
          async closeSessionWorkspaces() {},
          async revokeAuthority() {
            invalidCleanupEntered.resolve();
            await invalidCleanupRelease.promise;
          },
        };
      },
    });
    await invalidCleanupEntered.promise;
    assert.ok(invalidBinding);
    assert.equal(resolveInteractiveBrowserAuthority(invalidBinding), null,
      "invalid runtime cleanup removes pending authority before awaiting teardown");
    invalidCleanupRelease.resolve();
    await assert.rejects(invalidCreation, /factory returned a non-exact runtime lease/);
  } finally {
    removeThrowingListener();
    await destroyPiSession(row.id).catch(() => undefined);
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("fluid model changes preserve pair authority while destroying every old runtime surface", async (t) => {
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  const previousAnthropicKey = process.env.ANTHROPIC_API_KEY;
  const previousOpenAiKey = process.env.OPENAI_API_KEY;
  process.env.ANTHROPIC_API_KEY = "synthetic-test-key";
  process.env.OPENAI_API_KEY = "synthetic-test-key";
  t.after(() => {
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    if (previousAnthropicKey === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = previousAnthropicKey;
    if (previousOpenAiKey === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previousOpenAiKey;
  });

  {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-live-model-fluid-"));
    const cwd = path.join(dir, "project");
    fs.mkdirSync(cwd, { recursive: true });
    process.env.WAYANG_DATA_DIR = path.join(dir, "data");
    init();
    const profile = createAgentProfile({ name: "Live fluid model", resource_mode: "project_only" });
    const project = createProject({
      cwd,
      name: "Live fluid model",
      default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [profile.id] },
    });
    const source = { provider: "anthropic", model: "claude-sonnet-4-5" };
    const target = { provider: "openai", model: "gpt-5.5" };
    const capabilityBase = {
      capability_id: "wayang.protected-browser.v1" as const,
      project_id: project.id,
      agent_profile_id: profile.id,
    };
    const association = commitWorkspaceCapabilityActivation({ ...capabilityBase, operation_digest: "a".repeat(64) });
    assert.equal(resolveWorkspaceCapability(capabilityBase).authorized, true);
    const row = createSession(cwd, { ...source, agentProfileId: profile.id });
    const handle = await createPiSession(row.id, cwd, source.provider, source.model);
    assert.equal(handle.session.sessionManager.getSessionId(), row.id,
      "a newly created Pi transcript is bound to its already-durable Wayang session ID");
    const exactSudoOwners = (globalThis as any).__pi_sudo_session_managers as WeakMap<object, string> | undefined;
    assert.equal(exactSudoOwners?.get(handle.session.sessionManager), row.id,
      "the exact SessionManager object retains its owning web session even if ID/file maps later collide");
    const cleanupRelease = deferred();
    const closes: string[] = [];
    let disposes = 0;
    const oldTool = { name: "synthetic_old_privileged_tool", async execute() { return "must not survive"; } };
    const anySession = handle.session as any;
    const originalDispose = anySession.dispose.bind(anySession);
    anySession.dispose = () => { disposes += 1; return originalDispose(); };
    anySession._toolRegistry?.set?.(oldTool.name, oldTool);
    if (Array.isArray(anySession.agent?.state?.tools)) anySession.agent.state.tools.push(oldTool);
    let hostRevocations = 0;
    handle.bashMode = "host";
    handle.trustedHostBashTool = {
      revoked: false,
      revokeActiveExecutions() { hostRevocations++; return Promise.resolve(); },
    } as any;
    handle.restrictedMcpRuntime = {
      close() { closes.push("loader-hooks"); return cleanupRelease.promise; },
    } as any;
    handle.protectedBrowserRuntime = {
      detachAgentLease() { closes.push("host-browser-tools"); return cleanupRelease.promise; },
    } as any;

    try {
      Object.defineProperty(anySession, "pendingMessageCount", { configurable: true, value: 1 });
      await assert.rejects(setSessionModel(row.id, target.provider, target.model), /idle session/);
      assert.equal(handle.capabilityAuthorityDenied, undefined, "queued conflict leaves old runtime intact");
      assert.deepEqual([getSessionById(row.id)!.provider, getSessionById(row.id)!.model], [source.provider, source.model]);
      delete anySession.pendingMessageCount;

      Object.defineProperty(anySession, "isStreaming", { configurable: true, value: true });
      await assert.rejects(setSessionModel(row.id, target.provider, target.model), /idle session/);
      assert.equal(handle.capabilityAuthorityDenied, undefined, "streaming conflict leaves old runtime intact");
      delete anySession.isStreaming;

      const changing = setSessionModel(row.id, target.provider, target.model);
      const latchDeadline = Date.now() + 2_000;
      while (!handle.capabilityAuthorityDenied && Date.now() < latchDeadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(handle.capabilityAuthorityDenied, true, "accepted switch latches old authority before persistence");
      assert.equal(handle.bashMode, "unavailable");
      assert.equal(handle.trustedHostBashTool, undefined);
      assert.equal(hostRevocations, 1, "accepted switch starts orphan host-child teardown before persistence");
      assert.deepEqual(anySession.agent.state.tools, [], "no old tool remains active while teardown is pending");
      assert.deepEqual(getSessionById(row.id) && {
        provider: getSessionById(row.id)!.provider,
        model: getSessionById(row.id)!.model,
      }, source, "target is not persisted before old asynchronous cleanup finishes");
      assert.deepEqual(closes.sort(), ["host-browser-tools", "loader-hooks"]);

      cleanupRelease.resolve();
      await changing;
      assert.equal(disposes, 1, "the old AgentSession and its extension lifecycle are disposed exactly once");
      assert.equal(getPiSession(row.id), undefined, "model selection never mutates or republishes the old AgentSession");
      assert.deepEqual(getSessionById(row.id) && {
        provider: getSessionById(row.id)!.provider,
        model: getSessionById(row.id)!.model,
      }, target);
      const afterFirstSwitch = resolveWorkspaceCapability(capabilityBase);
      assert.equal(afterFirstSwitch.authorized, true);
      assert.equal(afterFirstSwitch.authorized && afterFirstSwitch.association.revision, association.revision);

      const modelBHandle = await createPiSession(row.id, cwd, target.provider, target.model);
      const modelBGeneration = modelBHandle.runtimeGeneration;
      await setSessionModel(row.id, source.provider, source.model);
      assert.equal(modelBHandle.capabilityAuthorityDenied, true);
      assert.equal(getPiSession(row.id), undefined, "B → A remains stopped until lazy use");
      const failedEffects: string[] = [];
      await assert.rejects(createPiSession(row.id, cwd, source.provider, source.model, null, {
        testHooks: {
          async afterStandardResourcesResolution() { throw new Error("synthetic lazy rebuild failure"); },
          onPrivilegedEffect(effect) { failedEffects.push(effect); },
        },
      }), /synthetic lazy rebuild failure/);
      assert.equal(getPiSessionRuntimeState(row.id).runtime_status, "stopped");
      assert.deepEqual(failedEffects, [], "failed lazy rebuild publishes no privileged surfaces");
      assert.equal(resolveWorkspaceCapability(capabilityBase).authorized, true);

      const freshModelAHandle = await createPiSession(row.id, cwd, source.provider, source.model);
      assert.notEqual(freshModelAHandle.runtimeGeneration, modelBGeneration);
      assert.notEqual(freshModelAHandle.runtimeGeneration, handle.runtimeGeneration);
      const afterRoundTrip = resolveWorkspaceCapability(capabilityBase);
      assert.equal(afterRoundTrip.authorized && afterRoundTrip.association.revision, association.revision);

      const selectedDefault = await setSessionDefaultModel(row.id);
      assert.ok(selectedDefault.provider && selectedDefault.model);
      assert.equal(freshModelAHandle.capabilityAuthorityDenied, true);
      assert.equal(getPiSessionRuntimeState(row.id).runtime_status, "stopped");
      assert.deepEqual([getSessionById(row.id)!.provider, getSessionById(row.id)!.model], [null, null]);
      const afterDefault = resolveWorkspaceCapability(capabilityBase);
      assert.equal(afterDefault.authorized && afterDefault.association.revision, association.revision);
    } finally {
      cleanupRelease.resolve();
      await cleanupPiSessionCapabilityDenial([row.id]);
      close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

});

test("Pi bridge raw-sudo guard blocks its promised direct lexical matrix without matching benign text", async () => {
  let localExecCalls = 0;
  const tool: any = {
    name: "bash",
    async execute() {
      localExecCalls++;
      return { exitCode: 0 };
    },
  };
  const fakeSession = {
    _toolRegistry: new Map([["bash", tool]]),
    agent: { state: { tools: [tool] } },
  } as unknown as Parameters<typeof installWayangRawSudoFailClosedGuard>[0];
  installWayangRawSudoFailClosedGuard(fakeSession, "synthetic-host-session");

  const blocked = [
    "sudo id",
    "/usr/bin/sudo -n id",
    "env FOO=bar sudo id",
    "command sudo id",
    "sh -c 'sudo id'",
    "printf ok; sudo id",
    "printf ok && sudo id",
    "printf ok | sudo tee /tmp/nope",
    "if true; then sudo id; fi",
    "find . -exec sudo id ;",
  ];
  for (const command of blocked) {
    await assert.rejects(
      (tool.execute as any)("synthetic-call", { command }, new AbortController().signal, () => undefined),
      /blocked raw sudo at bash execute/,
      command,
    );
  }
  assert.equal(localExecCalls, 0);

  const benign = [
    "printf '%s\\n' 'sudo id'",
    "echo sudo id",
    "SUDO=sudo printf ok",
    "printf ok # sudo id",
    "printf 'use sudo_exec, not sudo'",
    "sudoish id",
    "sh -c 'printf sudo'",
  ];
  for (const command of benign) {
    await (tool.execute as any)("synthetic-benign-call", { command }, new AbortController().signal, () => undefined);
  }
  assert.equal(localExecCalls, benign.length);
});

test("Pi bridge browser turns mint the exact persisted current-branch boundary and clear on completion or abort", async () => {
  const f = currentTurnFixture("wayang-pi-bridge-current-turn-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const content = "submit this bounded synthetic proposal";
  manager.appendMessage({ role: "user", content, timestamp: Date.now() } as any);
  const acceptedEntryCount = manager.getEntries().length;
  const starts = [deferred(), deferred()];
  const finishes = [deferred(), deferred()];
  let promptIndex = 0;
  let abortCalls = 0;

  const fakeSession: any = {
    model: { provider: "synthetic-provider", id: "synthetic-model" },
    sessionManager: manager,
    isStreaming: false,
    isCompacting: false,
    async prompt(promptContent: string) {
      const index = promptIndex++;
      manager.appendMessage({ role: "user", content: promptContent, timestamp: Date.now() } as any);
      starts[index].resolve();
      await finishes[index].promise;
    },
    async steer() { throw new Error("unexpected steer"); },
    async waitForIdle() {},
    clearQueue() { return { steering: [], followUp: [] }; },
    abortCompaction() {},
    async abort() {
      abortCalls++;
      finishes[Math.max(0, promptIndex - 1)].resolve();
    },
  };
  const handle = {
    id: durableRow.id,
    session: fakeSession,
    cwd: f.cwd,
    model: fakeSession.model.id,
    subscriberCount: 0,
    extensionsResult: {},
    events: new EventEmitter(),
    lastActivityAt: Date.now(),
    agentProfileId: f.profile.id,
    runtimeGeneration: "runtime-generation",
    interactiveTurns: new Map(),
  } as unknown as PiSessionHandle;

  try {
    const firstSend = sendBrowserMessageTurn(handle, content);
    await starts[0].promise;
    const activeTurn = [...handle.interactiveTurns.values()][0];
    assert.equal(activeTurn?.acceptedEntryCount, acceptedEntryCount, "the boundary is captured before Pi persists the browser message");
    assert.equal(activeTurn?.sourceKind, "browser_send_message");
    assert.equal(activeTurn?.contentSha256, browserTurnContentHash(content));
    assert.match(activeTurn?.token ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(activeTurn?.piUserEntryId, null);
    assert.deepEqual(
      {
        session: activeTurn?.sourceSessionId,
        generation: activeTurn?.runtimeGeneration,
        profile: activeTurn?.agentProfileId,
        project: activeTurn?.projectId,
        cwd: activeTurn?.projectCwd,
        provider: activeTurn?.provider,
        model: activeTurn?.model,
      },
      {
        session: handle.id,
        generation: handle.runtimeGeneration,
        profile: f.profile.id,
        project: f.project.id,
        cwd: f.project.cwd,
        provider: "synthetic-provider",
        model: "synthetic-model",
      },
    );
    const resolved = resolveInteractiveTurn(handle);
    assert.ok(resolved?.piUserEntryId, "one new matching user entry on the current branch resolves");
    assert.notEqual(resolved.piUserEntryId, manager.getEntries()[acceptedEntryCount - 1]?.id, "an identical older entry cannot satisfy the new boundary");

    finishes[0].resolve();
    await firstSend;
    assert.equal(handle.interactiveTurns.size, 0, "normal prompt settlement retires persisted source evidence");
    assert.equal(handle.interactiveMutationTurnToken, undefined, "normal prompt settlement clears mutation authority");
    const marker = manager.getEntries().find((entry: any) => entry.customType === "wayang-interactive-turn-source.v1") as any;
    assert.equal(marker?.data.user_entry_id, resolved.piUserEntryId);
    assert.equal(marker?.data.raw_user_text, content);
    assert.deepEqual(
      [getSessionById(durableRow.id)?.title, getSessionById(durableRow.id)?.title_source],
      [content, "provisional"],
      "fallback is populated only after exact durable user-entry settlement",
    );

    const secondSend = sendBrowserMessageTurn(handle, "abort this synthetic turn");
    await starts[1].promise;
    assert.ok(resolveInteractiveTurn(handle)?.piUserEntryId);
    await abortInteractiveTurn(handle);
    await secondSend;
    assert.equal(abortCalls, 1);
    assert.equal(handle.interactiveTurns.size, 0, "abort clears mutation authority before interrupting Pi");

    for (const source of ["resend", "interview_submission", "scheduled_prompt", "messaging_prompt"] as const) {
      const acceptedTurn = beginInteractiveTurn(handle, `accepted source before ${source}`);
      beginNonBrowserTurn(handle, source);
      assert.equal(resolveInteractiveTurn(handle), null, `${source} revokes current-turn mutation authority`);
      assert.equal(handle.interactiveTurns.has(acceptedTurn.token), true, `${source} preserves accepted browser-source evidence`);
      handle.interactiveTurns.delete(acceptedTurn.token);
    }
  } finally {
    f.cleanup();
  }
});

test("idle browser prompt completion schedules title generation after its marker is durable", async () => {
  const f = currentTurnFixture("wayang-pi-bridge-idle-title-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir, { id: durableRow.id });
  updatePiSessionFile(durableRow.id, manager.getSessionFile()!);
  const fakeSession: any = {
    model: { provider: "synthetic-provider", id: "synthetic-model" },
    sessionManager: manager,
    isStreaming: false,
    async prompt(content: string) {
      manager.appendMessage({ role: "user", content, timestamp: Date.now() } as any);
      manager.appendMessage({
        role: "assistant",
        content: [{ type: "text", text: `answer to ${content}` }],
        provider: "synthetic",
        model: "synthetic",
        stopReason: "stop",
        timestamp: Date.now(),
      } as any);
    },
  };
  const handle = {
    id: durableRow.id,
    session: fakeSession,
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "idle-title-generation",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
    subscriberCount: 0,
    lastActivityAt: Date.now(),
  } as unknown as PiSessionHandle;
  const previousFlag = process.env.WAYANG_AUTO_SESSION_TITLE;
  const previousProtectedFlag = process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED;
  process.env.WAYANG_AUTO_SESSION_TITLE = "on";
  process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED = "on";
  let dispatchCalls = 0;
  setAutoTitleProviderForTests({
    async prepare() {
      return { dispatch: async () => { dispatchCalls++; return "Idle prompt title"; } };
    },
  });
  try {
    for (let index = 1; index <= 3; index++) {
      await sendBrowserMessageTurn(handle, `idle prompt ${index}`, undefined, `idle-${index}`);
    }
    assert.equal(manager.getEntries().filter((entry: any) => entry.customType === "wayang-interactive-turn-source.v1").length, 3);
    assert.equal(getSessionById(durableRow.id)?.title_source, "provisional");
    assert.equal(extractCompletedTitleExchanges(manager.getBranch())?.completedExchangeCount, 3);
    const deadline = Date.now() + 2_000;
    while (SessionManager.open(manager.getSessionFile()!, undefined, f.cwd).getSessionName() !== "Idle prompt title") {
      if (Date.now() >= deadline) throw new Error("title generation was not scheduled after idle prompt settlement");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.equal(dispatchCalls, 1);
  } finally {
    setAutoTitleProviderForTests(null);
    if (previousFlag === undefined) delete process.env.WAYANG_AUTO_SESSION_TITLE;
    else process.env.WAYANG_AUTO_SESSION_TITLE = previousFlag;
    if (previousProtectedFlag === undefined) delete process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED;
    else process.env.WAYANG_AUTO_SESSION_TITLE_PROTECTED = previousProtectedFlag;
    f.cleanup();
  }
});

test("non-browser interview steering preserves an accepted queued browser source until its own settlement", () => {
  const f = currentTurnFixture("wayang-pi-bridge-interview-queued-source-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const queuedMessage = { role: "user", content: "queued browser after interview" };
  const fakeSession: any = {
    model: { provider: "synthetic-provider", id: "synthetic-model" },
    sessionManager: manager,
    _steeringMessages: ["queued browser after interview"],
    _emitQueueUpdate() {},
    agent: { steeringQueue: { messages: [queuedMessage] } },
  };
  const capture = { session: fakeSession, text: "queued browser after interview", message: queuedMessage };
  const handle = {
    id: durableRow.id,
    session: fakeSession,
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "interview-queued-generation",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
    subscriberCount: 0,
    lastActivityAt: Date.now(),
  } as unknown as PiSessionHandle;
  try {
    const turn = beginInteractiveTurn(handle, "queued browser after interview", {
      rawUserText: "queued browser after interview",
      clientMessageId: "queued-after-interview",
    });
    handle.queuedBrowserMessages.set("queued-after-interview", {
      capture,
      content: "queued browser after interview",
      attachmentNames: [],
      turnToken: turn.token,
      clientVisible: true,
    } as any);
    beginNonBrowserTurn(handle, "interview_submission");
    assert.equal(handle.interactiveTurns.has(turn.token), true);
    assert.equal(resolveInteractiveTurn(handle), null, "interview continuation has no browser mutation authority");
    assert.equal(settleInteractiveTurns(handle).length, 0, "unclaimed queued browser turn is not this interview settlement");
    assert.equal(handle.interactiveTurns.has(turn.token), true);

    manager.appendMessage({ role: "user", content: "queued browser after interview", timestamp: Date.now() } as any);
    fakeSession._steeringMessages = [];
    fakeSession.agent.steeringQueue.messages = [];
    markClaimedQueuedBrowserTurnsReady(handle);
    assert.equal(settleInteractiveTurns(handle).length, 1);
    assert.equal(handle.interactiveTurns.size, 0);
    assert.equal(manager.getEntries().some((entry: any) => entry.customType === "wayang-interactive-turn-source.v1"), true);
  } finally {
    f.cleanup();
  }
});

test("queued browser provenance remains durable when a legacy client omits its message ID", async () => {
  const f = currentTurnFixture("wayang-pi-bridge-legacy-queued-source-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const queuedMessage = { role: "user", content: "legacy queued browser turn" };
  const fakeSession: any = {
    model: { provider: "synthetic-provider", id: "synthetic-model" },
    sessionManager: manager,
    isStreaming: true,
    _steeringMessages: [],
    _emitQueueUpdate() {},
    agent: { steeringQueue: { messages: [] as any[] } },
    steer(content: string) {
      this._steeringMessages.push(content);
      this.agent.steeringQueue.messages.push(queuedMessage);
      return Promise.resolve();
    },
    getSteeringMessages() { return [...this._steeringMessages]; },
  };
  const handle = {
    id: durableRow.id,
    session: fakeSession,
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "legacy-queued-generation",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
    subscriberCount: 0,
    lastActivityAt: Date.now(),
  } as unknown as PiSessionHandle;
  try {
    const result = await sendBrowserMessageTurn(handle, "legacy queued browser turn");
    assert.deepEqual(result, { queued: true, cancellable: false });
    assert.equal(handle.queuedBrowserMessages.size, 1, "an internal capture is retained without exposing a cancellable client ID");
    assert.equal([...handle.queuedBrowserMessages.values()][0]?.clientVisible, false, "the internal record is not browser-visible");

    manager.appendMessage({ role: "user", content: "legacy queued browser turn", timestamp: Date.now() } as any);
    fakeSession._steeringMessages = [];
    fakeSession.agent.steeringQueue.messages = [];
    markClaimedQueuedBrowserTurnsReady(handle);
    assert.equal(settleInteractiveTurns(handle).length, 1);
    assert.equal(handle.interactiveTurns.size, 0);
    const marker = manager.getEntries().find((entry: any) => entry.customType === "wayang-interactive-turn-source.v1") as any;
    assert.equal(marker?.data.raw_user_text, "legacy queued browser turn");
  } finally {
    f.cleanup();
  }
});

test("queued browser ledger persists distinct source markers exactly once and excludes blank raw text", () => {
  const f = currentTurnFixture("wayang-pi-bridge-source-ledger-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const handle = {
    id: durableRow.id,
    session: {
      model: { provider: "synthetic-provider", id: "synthetic-model" },
      sessionManager: manager,
    },
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "ledger-generation",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
  } as unknown as PiSessionHandle;
  try {
    const firstPending = beginInteractiveTurn(handle, "repeated decorated content", { rawUserText: "raw first", clientMessageId: "queued-first" });
    const secondPending = beginInteractiveTurn(handle, "repeated decorated content", { rawUserText: "raw second", clientMessageId: "queued-second" });
    const attachmentPending = beginInteractiveTurn(handle, "<file synthetic attachment instruction>", { rawUserText: "", clientMessageId: "queued-attachment" });
    const first = Object.freeze({ ...firstPending, settlementReady: true });
    const second = Object.freeze({ ...secondPending, settlementReady: true });
    const attachmentOnly = Object.freeze({ ...attachmentPending, settlementReady: true });
    handle.interactiveTurns.set(first.token, first);
    handle.interactiveTurns.set(second.token, second);
    handle.interactiveTurns.set(attachmentOnly.token, attachmentOnly);
    manager.appendMessage({ role: "user", content: "repeated decorated content", timestamp: Date.now() } as any);
    manager.appendMessage({ role: "assistant", content: "first response", provider: "offline", model: "fixture", stopReason: "stop", timestamp: Date.now() } as any);
    manager.appendMessage({ role: "user", content: "repeated decorated content", timestamp: Date.now() } as any);
    manager.appendMessage({ role: "assistant", content: "second response", provider: "offline", model: "fixture", stopReason: "stop", timestamp: Date.now() } as any);
    manager.appendMessage({ role: "user", content: "<file synthetic attachment instruction>", timestamp: Date.now() } as any);
    manager.appendMessage({ role: "assistant", content: "attachment response", provider: "offline", model: "fixture", stopReason: "stop", timestamp: Date.now() } as any);

    const settled = settleInteractiveTurns(handle);
    assert.deepEqual(settled.map((turn) => turn.token), [first.token, second.token, attachmentOnly.token]);
    assert.equal(settleInteractiveTurns(handle).length, 0, "settled ledger entries cannot append twice");
    let markers = manager.getEntries().filter((entry: any) => entry.customType === "wayang-interactive-turn-source.v1") as any[];
    assert.equal(markers.length, 2, "blank attachment-only raw text has no eligible marker");
    assert.deepEqual(markers.map((entry) => entry.data.raw_user_text), ["raw first", "raw second"]);
    assert.deepEqual(markers.map((entry) => entry.data.client_message_id), ["queued-first", "queued-second"]);
    assert.notEqual(markers[0]?.data.user_entry_id, markers[1]?.data.user_entry_id);

    handle.interactiveTurns.set(settled[0]!.token, settled[0]!);
    assert.equal(settleInteractiveTurns(handle).length, 1, "a process retry may rediscover the exact resolved turn");
    markers = manager.getEntries().filter((entry: any) => entry.customType === "wayang-interactive-turn-source.v1") as any[];
    assert.equal(markers.length, 2, "persisted user_entry_id identity prevents duplicate markers across retries");
  } finally {
    f.cleanup();
  }
});

test("marker append failure retains the exact resolved ledger item for retry", () => {
  const f = currentTurnFixture("wayang-pi-bridge-source-append-retry-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const handle = {
    id: durableRow.id,
    session: { model: { provider: "synthetic-provider", id: "synthetic-model" }, sessionManager: manager },
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "append-retry-generation",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
  } as unknown as PiSessionHandle;
  const originalAppend = manager.appendCustomEntry.bind(manager);
  try {
    const pendingTurn = beginInteractiveTurn(handle, "retryable exact content", {
      rawUserText: "retryable raw content",
      clientMessageId: "append-retry",
    });
    const turn = Object.freeze({ ...pendingTurn, settlementReady: true });
    handle.interactiveTurns.set(turn.token, turn);
    manager.appendMessage({ role: "user", content: "retryable exact content", timestamp: Date.now() } as any);
    const exactUserId = manager.getLeafId();
    let fail = true;
    manager.appendCustomEntry = ((...args: Parameters<typeof manager.appendCustomEntry>) => {
      if (fail) {
        fail = false;
        throw new Error("synthetic append failure");
      }
      return originalAppend(...args);
    }) as typeof manager.appendCustomEntry;

    assert.throws(() => settleInteractiveTurns(handle), /synthetic append failure/);
    assert.equal(handle.interactiveTurns.has(turn.token), true, "resolvable failed marker remains retryable");
    assert.equal(handle.interactiveTurns.get(turn.token)?.piUserEntryId, exactUserId);
    assert.equal(settleInteractiveTurns(handle).length, 1);
    assert.equal(handle.interactiveTurns.size, 0);
    const markers = manager.getEntries().filter((entry: any) => entry.customType === "wayang-interactive-turn-source.v1") as any[];
    assert.equal(markers.length, 1);
    assert.equal(markers[0]?.data.raw_user_text, "retryable raw content");
  } finally {
    manager.appendCustomEntry = originalAppend as typeof manager.appendCustomEntry;
    f.cleanup();
  }
});

test("settlement retires unresolved hash mismatches before later matching text appears", () => {
  const f = currentTurnFixture("wayang-pi-bridge-source-mismatch-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const handle = {
    id: durableRow.id,
    session: { model: { provider: "synthetic-provider", id: "synthetic-model" }, sessionManager: manager },
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "mismatch-generation",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
  } as unknown as PiSessionHandle;
  try {
    const pendingMismatch = beginInteractiveTurn(handle, "/template original", { rawUserText: "/template original", clientMessageId: "template-mismatch" });
    handle.interactiveTurns.set(pendingMismatch.token, Object.freeze({ ...pendingMismatch, settlementReady: true }));
    manager.appendMessage({ role: "user", content: "expanded template content", timestamp: Date.now() } as any);
    assert.deepEqual(settleInteractiveTurns(handle), []);
    assert.equal(handle.interactiveTurns.size, 0, "unresolved accepted turns retire at authoritative settlement");

    manager.appendMessage({ role: "user", content: "/template original", timestamp: Date.now() } as any);
    assert.deepEqual(settleInteractiveTurns(handle), []);
    assert.equal(manager.getEntries().some((entry: any) => entry.customType === "wayang-interactive-turn-source.v1"), false);
    assert.equal(getSessionById(durableRow.id)?.title, "", "an unresolved command does not consume provisional fallback");
  } finally {
    f.cleanup();
  }
});

test("rejected browser prompts do not consume provisional title fallback", async () => {
  const f = currentTurnFixture("wayang-pi-bridge-rejected-title-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const handle = {
    id: durableRow.id,
    session: {
      model: { provider: "synthetic-provider", id: "synthetic-model" },
      sessionManager: manager,
      isStreaming: false,
      async prompt(content: string) {
        manager.appendMessage({ role: "user", content, timestamp: Date.now() } as any);
        throw new Error("synthetic prompt rejection");
      },
    },
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "rejected-generation",
    interactiveTurns: new Map(),
  } as unknown as PiSessionHandle;
  try {
    await assert.rejects(
      sendBrowserMessageTurn(handle, "Rejected first message", undefined, "rejected-first", {
        content: "Rejected first message",
        rawUserText: "Rejected first message",
        provisionalTitleText: "Rejected first message",
      }),
      /synthetic prompt rejection/,
    );
    assert.equal(handle.interactiveTurns.size, 0);
    assert.deepEqual(
      [getSessionById(durableRow.id)?.title, getSessionById(durableRow.id)?.title_source],
      ["", "provisional"],
    );
  } finally {
    f.cleanup();
  }
});

test("browser source eligibility requires exact durable Project identity and capability eligibility", () => {
  const f = currentTurnFixture("wayang-pi-bridge-source-eligibility-");
  const durableRow = createSession(f.cwd, { agentProfileId: f.profile.id });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const handle = {
    id: durableRow.id,
    session: { model: { provider: "synthetic-provider", id: "synthetic-model" }, sessionManager: manager },
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "eligibility-generation",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
  } as unknown as PiSessionHandle;
  try {
    const stored = getStore().sessions.find((row) => row.id === durableRow.id)!;
    const correctProjectId = stored.project_id;
    for (const [label, mutate] of [
      ["project mismatch", () => { stored.project_id = "different-project"; stored.legacy_capability_ineligible = false; }],
      ["capability ineligible", () => { stored.project_id = correctProjectId; stored.legacy_capability_ineligible = true; }],
    ] as const) {
      mutate();
      const content = `synthetic ${label}`;
      const pending = beginInteractiveTurn(handle, content, { clientMessageId: label.replace(/ /g, "-") });
      assert.equal(pending.sourceMarkerEligible, false, `${label} must fail source-marker eligibility`);
      handle.interactiveTurns.set(pending.token, Object.freeze({ ...pending, settlementReady: true }));
      manager.appendMessage({ role: "user", content, timestamp: Date.now() } as any);
      assert.equal(settleInteractiveTurns(handle).length, 1);
    }
    stored.project_id = correctProjectId;
    stored.legacy_capability_ineligible = false;
    assert.equal(manager.getEntries().some((entry: any) => entry.customType === "wayang-interactive-turn-source.v1"), false);
  } finally {
    f.cleanup();
  }
});

test("scheduled rows never persist browser interactive-source markers", () => {
  const f = currentTurnFixture("wayang-pi-bridge-scheduled-source-");
  const durableRow = createSession(f.cwd, {
    agentProfileId: f.profile.id,
    scheduledJobId: "synthetic-job",
    scheduledRunId: "synthetic-run",
  });
  const manager = SessionManager.create(f.cwd, f.sessionDir);
  const handle = {
    id: durableRow.id,
    session: { model: { provider: "synthetic-provider", id: "synthetic-model" }, sessionManager: manager },
    cwd: f.cwd,
    agentProfileId: f.profile.id,
    runtimeGeneration: "scheduled-generation",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
  } as unknown as PiSessionHandle;
  try {
    const pending = beginInteractiveTurn(handle, "synthetic scheduled browser text", { clientMessageId: "scheduled-browser" });
    handle.interactiveTurns.set(pending.token, Object.freeze({ ...pending, settlementReady: true }));
    manager.appendMessage({ role: "user", content: "synthetic scheduled browser text", timestamp: Date.now() } as any);
    assert.equal(settleInteractiveTurns(handle).length, 1);
    assert.equal(manager.getEntries().some((entry: any) => entry.customType === "wayang-interactive-turn-source.v1"), false);
  } finally {
    f.cleanup();
  }
});

test("overflow retry provenance persists without a browser subscriber", () => {
  const manager = SessionManager.inMemory();
  manager.appendMessage({
    role: "assistant",
    content: [],
    api: "openai-responses",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    stopReason: "error",
    errorMessage: "Context window exceeded",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    timestamp: Date.now(),
  } as any);
  const overflowId = manager.getLeafId();
  manager.appendCompaction("synthetic recovery summary", overflowId!, 100_000);
  const handle = {
    session: { sessionManager: manager },
    subscriberCount: 0,
  } as unknown as PiSessionHandle;

  trackOverflowRecovery(handle, {
    type: "compaction_end",
    reason: "overflow",
    result: { summary: "synthetic recovery summary", firstKeptEntryId: overflowId!, tokensBefore: 100_000, estimatedTokensAfter: 10_000 },
    aborted: false,
    willRetry: true,
  } as any);
  assert.notEqual((manager.getBranch().at(-1) as any).customType, "wayang-overflow-retry-v1");

  trackOverflowRecovery(handle, {
    type: "message_end",
    message: { role: "assistant", content: [{ type: "text", text: "Recovered response" }], stopReason: "stop" },
  } as any);
  assert.notEqual((manager.getBranch().at(-1) as any).customType, "wayang-overflow-retry-v1");
  trackOverflowRecovery(handle, { type: "agent_settled" } as any);
  const leaf = manager.getBranch().at(-1) as any;
  assert.equal(leaf.customType, "wayang-overflow-retry-v1");
  assert.equal(leaf.data.compactionEntryId, manager.getBranch().find((entry: any) => entry.type === "compaction")?.id);
  assert.equal(leaf.data.overflowEntryId, overflowId);
});

test("listModels does not execute an unrelated installed extension factory", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-model-list-canary-"));
  const cwd = path.join(dir, "project");
  const agentDir = path.join(dir, "agent");
  const extensionDir = path.join(agentDir, "extensions");
  const moduleMarker = path.join(dir, "unrelated-extension-module-executed");
  const factoryMarker = path.join(dir, "unrelated-extension-factory-executed");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(extensionDir, { recursive: true });
  fs.writeFileSync(path.join(extensionDir, "unrelated.ts"), [
    'import * as fs from "node:fs";',
    `fs.writeFileSync(${JSON.stringify(moduleMarker)}, "executed");`,
    `export default function unrelated() { fs.writeFileSync(${JSON.stringify(factoryMarker)}, "executed"); }`,
  ].join("\n"));

  try {
    const result = await listModels({
      cwd,
      agentDir,
      includeDynamicModels: false,
    });
    assert.ok(result.models.length > 0, "built-in models remain discoverable");
    assert.equal(fs.existsSync(moduleMarker), false, "unreviewed extension module must not execute");
    assert.equal(fs.existsSync(factoryMarker), false, "unreviewed extension factory must not execute");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("action approvals expose only exact pi session identity mappings", () => {
  const scope = globalThis as typeof globalThis & {
    __pi_action_pi_sessions?: Map<string, string>;
    __pi_action_session_files?: Map<string, string>;
    __pi_action_cwd_sessions?: Map<string, string>;
  };

  assert.ok(scope.__pi_action_pi_sessions instanceof Map);
  assert.ok(scope.__pi_action_session_files instanceof Map);
  assert.equal(scope.__pi_action_cwd_sessions, undefined);
});

test("live history snapshot appends Pi's unpersisted streaming message exactly once", () => {
  const durable = [{
    type: "user",
    id: "synthetic-user",
    message: { role: "user", content: "Synthetic prompt" },
  }];
  const streaming = {
    role: "assistant",
    content: [{ type: "text", text: "Partial synthetic response" }],
    provider: "offline",
    model: "fixture",
  };

  const snapshot = appendStreamingMessageToHistory(durable, streaming);
  assert.equal(snapshot.length, 2);
  assert.equal(snapshot[0], durable[0], "durable history remains unchanged");
  assert.equal(snapshot[1]?.type, "assistant");
  assert.deepEqual((snapshot[1]?.message as any)?.content, streaming.content);
  assert.equal(appendStreamingMessageToHistory(snapshot, undefined), snapshot);
});

test("stopped session snapshot parses once for messages and todos and invalidates on fingerprint change", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-snapshot-test-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const manager = SessionManager.create(projectDir, dir);
  manager.appendMessage({ role: "user", content: "public snapshot fixture", timestamp: Date.now() } as any);
  manager.appendMessage({ role: "assistant", content: "public synthetic response", provider: "offline", model: "fixture", timestamp: Date.now() } as any);
  manager.appendCustomEntry("todo-state", { todos: [{ id: 1, text: "Synthetic todo", status: "pending" }], nextId: 2 });
  const file = manager.getSessionFile()!;
  const originalOpen = SessionManager.open;
  let opens = 0;
  SessionManager.open = ((...args: Parameters<typeof SessionManager.open>) => {
    opens++;
    return originalOpen(...args);
  }) as typeof SessionManager.open;

  try {
    invalidateSessionFileSnapshot(file);
    const first = getSessionFileSnapshot(file, projectDir);
    assert.equal(first?.messages.length, 2);
    assert.equal(first?.todoState.todos[0]?.text, "Synthetic todo");
    assert.equal(getSessionFileMessageHistory(file, projectDir).length, 2);
    assert.equal(getSessionFileSnapshot(file, projectDir)?.todoState.todos.length, 1);
    assert.equal(opens, 1);

    fs.appendFileSync(file, JSON.stringify({
      type: "session_info",
      id: "snapshot-name",
      parentId: manager.getLeafId(),
      timestamp: new Date().toISOString(),
      name: "Changed synthetic fixture",
    }) + "\n");
    assert.equal(getSessionFileSnapshot(file, projectDir)?.messages.length, 2);
    assert.equal(opens, 2);
  } finally {
    SessionManager.open = originalOpen;
    invalidateSessionFileSnapshot(file);
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("scheduled prompt ignores intermediate turn and agent end events until the top-level run settles", async () => {
  const promptReturned = deferred();
  const agentIdle = deferred();
  const listeners = new Set<(event: { type: string }) => void>();
  let settled = false;

  const session: ScheduledPromptSession & {
    subscribe(listener: (event: { type: string }) => void): () => void;
    emit(type: string): void;
  } = {
    isStreaming: false,
    messages: [],
    async prompt() {
      await promptReturned.promise;
      this.messages.push({ role: "assistant", content: "synthetic top-level completion" });
    },
    async steer() {},
    async abort() {},
    async waitForIdle() {
      await agentIdle.promise;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    emit(type) {
      for (const listener of listeners) listener({ type });
    },
  };

  const waiting = waitForScheduledPrompt(session, "synthetic scheduled work").then(() => {
    settled = true;
  });
  session.emit("turn_end");
  session.emit("agent_end");
  promptReturned.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "intermediate SDK events must not complete scheduler bookkeeping");

  agentIdle.resolve();
  await waiting;
  assert.equal(settled, true);
});

test("scheduled steering remains active after queue acceptance until the top-level run is idle", async () => {
  const steerReturned = deferred();
  const agentIdle = deferred();
  let settled = false;
  let promptCalls = 0;
  let steerCalls = 0;

  const session: ScheduledPromptSession = {
    isStreaming: true,
    messages: [],
    async prompt() { promptCalls++; },
    async steer() {
      steerCalls++;
      await steerReturned.promise;
    },
    async abort() {},
    async waitForIdle() {
      await agentIdle.promise;
    },
  };

  const waiting = waitForScheduledPrompt(session, "synthetic queued steering").then(() => {
    settled = true;
  });
  steerReturned.resolve();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(settled, false, "queue acceptance and intermediate retry/compaction events are not settlement");
  assert.equal(promptCalls, 0);
  assert.equal(steerCalls, 1);

  agentIdle.resolve();
  await waiting;
  assert.equal(settled, true);
});

test("scheduled steering timeout waits for abort and the original queued completion", async () => {
  const steerFinished = deferred();
  const agentIdle = deferred();
  const abortStarted = deferred();
  const allowAbortToFinish = deferred();
  let waitingSettled = false;

  const session: ScheduledPromptSession = {
    isStreaming: true,
    messages: [],
    async prompt() { assert.fail("streaming sessions must steer instead of prompting"); },
    async steer() {
      await steerFinished.promise;
    },
    async abort() {
      abortStarted.resolve();
      await allowAbortToFinish.promise;
      steerFinished.resolve();
      agentIdle.resolve();
    },
    async waitForIdle() {
      await agentIdle.promise;
    },
  };

  const waiting = waitForScheduledPrompt(session, "synthetic queued timeout", { timeoutMs: 10 })
    .then(
      () => assert.fail("timed out scheduled steering unexpectedly completed"),
      (error) => {
        waitingSettled = true;
        assert.match(error instanceof Error ? error.message : String(error), /^Prompt timed out after 10ms/);
      },
    );

  await Promise.race([
    abortStarted.promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort did not start")), 1_000)),
  ]);
  assert.equal(waitingSettled, false, "timeout must not release bookkeeping before abort and queued work settle");
  allowAbortToFinish.resolve();
  await waiting;
  assert.equal(waitingSettled, true);
});

test("scheduled prompt timeout aborts and remains pending until the agent is idle", async () => {
  const promptFinished = deferred();
  const abortStarted = deferred();
  const allowAbortToFinish = deferred();
  let waitingSettled = false;

  const session: ScheduledPromptSession = {
    isStreaming: false,
    messages: [],
    async prompt() {
      await promptFinished.promise;
    },
    async steer() {},
    async abort() {
      abortStarted.resolve();
      await allowAbortToFinish.promise;
      promptFinished.resolve();
    },
    async waitForIdle() {
      await promptFinished.promise;
    },
  };

  const waiting = waitForScheduledPrompt(session, "synthetic timeout", { timeoutMs: 10 })
    .then(
      () => assert.fail("timed out scheduled prompt unexpectedly completed"),
      (error) => {
        waitingSettled = true;
        assert.match(error instanceof Error ? error.message : String(error), /^Prompt timed out after 10ms/);
      },
    );

  await Promise.race([
    abortStarted.promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error("abort did not start")), 1_000)),
  ]);
  assert.equal(waitingSettled, false, "run must stay running while abort cleanup is still active");
  allowAbortToFinish.resolve();
  await waiting;
  assert.equal(waitingSettled, true);
});

test("delayed questionnaire content exposes both durable request and submission IDs to the agent", () => {
  const authority = (globalThis as any).__wayang_command_guard_human_input_authority;
  assert.equal(typeof authority?.resolveInterviewSubmission, "function");
  const content = interviewSubmissionContent({
    request_id: "request-12345678",
    submission_id: "submission-12345678",
    session_id: "session-12345678",
    pi_session_id: null,
    pi_session_file: null,
    origin_tool_name: "questionnaire",
    origin_tool_call_id: "call-12345678",
    questions: [],
    answers: [{ id: "D-20990101-01", value: "ACKNOWLEDGE", label: "Acknowledge", wasCustom: false, index: 0 }],
    status: "submitted",
    created_at: Date.parse("2026-07-16T17:00:00Z"),
    submitted_at: Date.parse("2026-07-16T17:01:00Z"),
  });
  assert.match(content, /Request: request-12345678; submission: submission-12345678;/);
  assert.match(content, /D-20990101-01: Acknowledge/);
});

test("scheduled prompt result treats durable questionnaire pending as normal and classifies assistant errors", () => {
  const pending = classifyScheduledPromptResult([
    {
      role: "toolResult",
      toolName: "questionnaire",
      content: [{ type: "text", text: "The questionnaire remains open; a later submission will arrive." }],
      details: { status: "pending", requestId: "synthetic-request" },
    },
    { role: "assistant", content: [{ type: "text", text: "Questionnaire is pending; the scheduled turn is done for now." }] },
  ]);
  assert.equal(pending.error, null);
  assert.equal(pending.resultSummary, "Questionnaire is pending; the scheduled turn is done for now.");

  const failed = classifyScheduledPromptResult([
    { role: "assistant", content: [], stopReason: "error", errorMessage: "synthetic provider failure" },
  ]);
  assert.equal(failed.error, "synthetic provider failure");
  assert.equal(failed.resultSummary, null);
});

test("pending agent switch recovery finalizes audit markers and rolls back missing markers", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-switch-recovery-test-"));
  const dataDir = path.join(dir, "data");
  const projectDir = path.join(dir, "project");
  const sessionDir = path.join(dir, "sessions");
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(sessionDir, { recursive: true });
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dataDir;
  try {
    init();
    const source = createAgentProfile({ name: "Synthetic recovery source" });
    const target = createAgentProfile({ name: "Synthetic recovery target" });

    const completedRow = createSession(projectDir, { provider: "anthropic", model: "source-model", agentProfileId: source.id });
    const completedManager = SessionManager.create(projectDir, sessionDir);
    completedManager.appendMessage({ role: "user", content: "synthetic recovery transcript", timestamp: Date.now() } as any);
    completedManager.appendMessage({ role: "assistant", content: "synthetic response", provider: "synthetic", model: "synthetic", timestamp: Date.now() } as any);
    updatePiSessionFile(completedRow.id, completedManager.getSessionFile()!);
    const completedPending: PendingAgentSwitch = {
      switch_id: "switch-completed",
      from_agent_profile_id: completedRow.agent_profile_id ?? null,
      from_provider: completedRow.provider,
      from_model: completedRow.model,
      to_agent_profile_id: target.id,
      target_provider: "openai-codex",
      target_model: "target-model",
      changed_at: 1,
    };
    beginAgentSwitch(completedRow.id, completedPending);
    completedManager.appendModelChange("openai-codex", "target-model");
    completedManager.appendCustomEntry("wayang-agent-change", { switch_id: completedPending.switch_id });
    const completed = reconcilePendingAgentSwitch({ ...completedRow, pi_session_file: completedManager.getSessionFile()!, pending_agent_switch: completedPending });
    assert.deepEqual([completed.agent_profile_id, completed.provider, completed.model], [target.id, "openai-codex", "target-model"]);
    assert.equal(completed.pending_agent_switch, null);
    const auditHistory = getSessionFileMessageHistory(completedManager.getSessionFile(), projectDir);
    assert.equal((auditHistory.at(-1)?.message as any)?.customType, "wayang-agent-change");
    assert.equal((auditHistory.at(-1)?.message as any)?.details?.switch_id, completedPending.switch_id);

    const rolledBackRow = createSession(projectDir, { provider: "anthropic", model: "source-model", agentProfileId: source.id });
    const rolledBackManager = SessionManager.create(projectDir, sessionDir);
    rolledBackManager.appendMessage({ role: "user", content: "synthetic rollback transcript", timestamp: Date.now() } as any);
    rolledBackManager.appendMessage({ role: "assistant", content: "synthetic response", provider: "synthetic", model: "synthetic", timestamp: Date.now() } as any);
    updatePiSessionFile(rolledBackRow.id, rolledBackManager.getSessionFile()!);
    const rolledBackPending: PendingAgentSwitch = {
      ...completedPending,
      switch_id: "switch-incomplete",
      from_agent_profile_id: rolledBackRow.agent_profile_id ?? null,
      from_provider: rolledBackRow.provider,
      from_model: rolledBackRow.model,
      changed_at: 2,
    };
    beginAgentSwitch(rolledBackRow.id, rolledBackPending);
    rolledBackManager.appendModelChange("openai-codex", "target-model");
    const rolledBack = reconcilePendingAgentSwitch({ ...rolledBackRow, pi_session_file: rolledBackManager.getSessionFile()!, pending_agent_switch: rolledBackPending });
    assert.deepEqual([rolledBack.agent_profile_id, rolledBack.provider, rolledBack.model], [source.id, "anthropic", "source-model"]);
    assert.equal(rolledBack.pending_agent_switch, null);
    assert.deepEqual(
      SessionManager.open(rolledBackManager.getSessionFile()!, undefined, projectDir).buildSessionContext().model,
      { provider: "anthropic", modelId: "source-model" },
    );
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("file history shows the full active branch after compaction", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-history-test-"));
  const projectDir = path.join(dir, "project");
  const sessionDir = path.join(dir, "sessions");
  fs.mkdirSync(projectDir, { recursive: true });

  try {
    const manager = SessionManager.create(projectDir, sessionDir);
    manager.appendMessage({ role: "user", content: "first user turn", timestamp: "2026-01-01T00:00:00.000Z" } as any);
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "first answer" }], timestamp: "2026-01-01T00:00:01.000Z" } as any);
    manager.appendMessage({ role: "user", content: "second user turn", timestamp: "2026-01-01T00:00:02.000Z" } as any);
    const keptId = manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "second answer" }], timestamp: "2026-01-01T00:00:03.000Z" } as any);
    manager.appendCompaction("Summary only for model context", keptId, 1234, undefined, undefined);

    const compactedContext = manager.buildSessionContext().messages;
    assert.deepEqual(compactedContext.map((message: any) => message.role), ["compactionSummary", "assistant"]);

    const history = getSessionFileMessageHistory(manager.getSessionFile(), projectDir);
    assert.deepEqual(history.map((message) => message.type), ["user", "assistant", "user", "assistant", "custom"]);
    assert.equal((history[0].message as any)?.content, "first user turn");
    assert.equal((history[2].message as any)?.content, "second user turn");
    assert.equal((history[4].message as any)?.customType, "compaction-summary");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
