import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import {
  abortInteractiveTurn,
  appendStreamingMessageToHistory,
  beginInteractiveTurn,
  beginNonBrowserTurn,
  classifyScheduledPromptResult,
  cleanupPiSessionCapabilityDenial,
  closePiSessionAuthorities,
  createPiSession,
  fileAudioExperimentRuntimeIsEligible,
  getPiSession,
  getPiSessionBashMode,
  getPiSessionRuntimeState,
  getSessionFileMessageHistory,
  getSessionFileSnapshot,
  invalidateSessionFileSnapshot,
  installWayangRawSudoFailClosedGuard,
  latchPiSessionCapabilityDenial,
  interviewSubmissionContent,
  listModels,
  onPiSessionRuntimeEvent,
  persistSettledSessionError,
  trackOverflowRecovery,
  piSessionHandleRequiresFreshRuntime,
  previewSessionAgentSwitch,
  protectedBrowserIdleRetentionIsRequired,
  reconcilePendingAgentSwitch,
  resolveInteractiveTurn,
  sendBrowserMessageTurn,
  setSessionDefaultModel,
  setSessionModel,
  waitForScheduledPrompt,
  type PiSessionHandle,
  type PiSessionRuntimeEvent,
  type ScheduledPromptSession,
} from "./pi-bridge.js";
import { createAgentProfile } from "./agent-profiles.js";
import { close, init } from "./db.js";
import { createProject } from "./projects.js";
import { beginAgentSwitch, createSession, getSessionById, updatePiSessionFile } from "./sessions.js";
import { browserTurnContentHash } from "./interactive-turn-provenance.js";
import { createHostBashOperations } from "./host-execution.js";
import { commitWorkspaceCapabilityActivation, resolveWorkspaceCapability, revokeWorkspaceCapabilityAssociation } from "./workspace-capabilities.js";
import type { PendingAgentSwitch } from "./workspace-types.js";
import type { ProtectedBrowserToolRuntime } from "./browser/protected-tools.js";
import { getActionApprovalBridge } from "./action-approval-bridge.js";

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
  const handle = { id: "synthetic-runtime-event-session", bashMode: "sandboxed", activeInteractiveTurn: null } as unknown as PiSessionHandle;
  try {
    await closePiSessionAuthorities(handle);
    await closePiSessionAuthorities(handle);
    assert.equal(handle.bashMode, "unavailable");
    assert.equal(handle.trustedHostBashTool, undefined);
    assert.deepEqual(events, [{ type: "runtime_state_changed", sessionId: handle.id, bashMode: "unavailable" }]);
  } finally { unsubscribe(); }
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
      close() { order.push("protected-latched"); return cleanupRelease.promise; },
    },
    restrictedMcpRuntime: {
      close() { order.push("restricted-latched"); return cleanupRelease.promise; },
    },
    fileAudioExperimentRuntime: {
      close() { order.push("audio-latched"); return cleanupRelease.promise; },
    },
    activeInteractiveTurn: { token: "stale" },
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
  assert.equal(handle.activeInteractiveTurn, null);
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
    activeInteractiveTurn: null,
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
  } finally {
    release.resolve();
    await cleanupPiSessionCapabilityDenial([row.id]);
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
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
      close() { closes.push("host-browser-tools"); return cleanupRelease.promise; },
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
    id: "protected-session",
    session: fakeSession,
    cwd: f.cwd,
    model: fakeSession.model.id,
    subscriberCount: 0,
    extensionsResult: {},
    events: new EventEmitter(),
    lastActivityAt: Date.now(),
    agentProfileId: f.profile.id,
    runtimeGeneration: "runtime-generation",
    activeInteractiveTurn: null,
  } as unknown as PiSessionHandle;

  try {
    const firstSend = sendBrowserMessageTurn(handle, content);
    await starts[0].promise;
    assert.equal(handle.activeInteractiveTurn?.acceptedEntryCount, acceptedEntryCount, "the boundary is captured before Pi persists the browser message");
    assert.equal(handle.activeInteractiveTurn?.sourceKind, "browser_send_message");
    assert.equal(handle.activeInteractiveTurn?.contentSha256, browserTurnContentHash(content));
    assert.match(handle.activeInteractiveTurn?.token ?? "", /^[0-9a-f-]{36}$/);
    assert.equal(handle.activeInteractiveTurn?.piUserEntryId, null);
    assert.deepEqual(
      {
        session: handle.activeInteractiveTurn?.sourceSessionId,
        generation: handle.activeInteractiveTurn?.runtimeGeneration,
        profile: handle.activeInteractiveTurn?.agentProfileId,
        project: handle.activeInteractiveTurn?.projectId,
        cwd: handle.activeInteractiveTurn?.projectCwd,
        provider: handle.activeInteractiveTurn?.provider,
        model: handle.activeInteractiveTurn?.model,
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
    assert.equal(handle.activeInteractiveTurn, null, "normal prompt completion clears mutation authority");

    const secondSend = sendBrowserMessageTurn(handle, "abort this synthetic turn");
    await starts[1].promise;
    assert.ok(resolveInteractiveTurn(handle)?.piUserEntryId);
    await abortInteractiveTurn(handle);
    await secondSend;
    assert.equal(abortCalls, 1);
    assert.equal(handle.activeInteractiveTurn, null, "abort clears mutation authority before interrupting Pi");

    for (const source of ["resend", "interview_submission"] as const) {
      const staleTurn = beginInteractiveTurn(handle, `stale authority before ${source}`);
      const staleToken = staleTurn.token;
      beginNonBrowserTurn(handle, source);
      assert.equal(handle.activeInteractiveTurn, null, `${source} revokes stale authority without minting a replacement`);
      assert.ok(staleToken);
    }
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
