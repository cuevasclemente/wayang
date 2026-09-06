import test, { after, type TestContext } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getEventListeners } from "node:events";
import type { AgentSession, ExtensionFactory, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import type { ProtectedBrowserBinding, ProtectedBrowserOperation } from "./browser/types.js";
import type { BrowserProfileRow, SessionBrowserStateRow } from "./browser/profile-catalog-store.js";
import type { StandardBrowserCatalogPort, StandardBrowserRuntimeWorkspace } from "./browser/standard-service.js";
import type { StandardBrowserHostBackend, StandardBrowserHostBackendCallbacks, StandardBrowserBackendTarget } from "./browser/standard-host.js";

// Only this synthetic home/data/project is used; no provider is ever dispatched.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-creation-lifecycle-"));
const home = path.join(root, "home");
const agentDir = path.join(home, ".pi", "agent");
const env = {
  HOME: home, PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
  WAYANG_DATA_DIR: path.join(root, "data"), XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"), PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0",
};
const previous = new Map(Object.keys(env).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(env)) process.env[key] = value;
fs.mkdirSync(agentDir, { recursive: true });
after(() => {
  for (const [key, value] of previous) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(root, { recursive: true, force: true }); // exact test-owned mkdtemp
});
const { ModelRuntime, DefaultResourceLoader, createExtensionRuntime, createEventBus, defineTool } = await import("@earendil-works/pi-coding-agent");
// Real inline ExtensionAPI registration, not replacement of SDK lifecycle methods.
const { loadExtensionFromFactory } = await import(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
);
const { InMemoryCredentialStore, Type } = await import("@earendil-works/pi-ai");
const bridge = await import("./pi-bridge.js");
const db = await import("./db.js");
const { createAgentProfile } = await import("./agent-profiles.js");
const { createProject } = await import("./projects.js");
const { createSession } = await import("./sessions.js");
const originalCreate = ModelRuntime.create.bind(ModelRuntime);

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
function observe<T>(promise: Promise<T>) {
  let settled = false;
  const result = promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  ).finally(() => { settled = true; });
  return { result, settled: () => settled };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error("Synthetic lifecycle gate timed out")), 5_000);
    })]);
  } finally { if (timer) clearTimeout(timer); }
}
async function fixture(t: TestContext, extensionFactory?: ExtensionFactory) {
  db.init();
  const cwd = fs.mkdtempSync(path.join(root, "project-"));
  // db.init() reopens this file's persisted synthetic store between tests.
  // Give each fixture a distinct identity without deleting any previous rows.
  const name = `Lifecycle fixture ${path.basename(cwd)}`;
  const profile = createAgentProfile({ name, resource_mode: "standard", memory_access: "none" });
  createProject({ cwd, name, default_agent_profile_id: profile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] } });
  const row = createSession(cwd, { agentProfileId: profile.id, provider: "lifecycle-offline", model: "fixture" });
  // Public input boundaries only. AgentSession creation/binding/abort/dispose stay real.
  let providerDispatches = 0;
  t.mock.method(ModelRuntime, "create", async () => {
    const runtime = await originalCreate({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerProvider("lifecycle-offline", {
      api: "lifecycle-offline-api", apiKey: "synthetic-only", baseUrl: "https://offline.invalid",
      models: [{ id: "fixture", name: "fixture", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 262144, maxTokens: 1024 }],
      streamSimple() { providerDispatches++; throw new Error("Lifecycle tests must never dispatch a provider"); },
    });
    await runtime.refresh({ allowNetwork: false });
    return runtime;
  });
  const resources = new WeakMap<InstanceType<typeof DefaultResourceLoader>, LoadExtensionsResult>();
  t.mock.method(DefaultResourceLoader.prototype, "reload", async function (this: InstanceType<typeof DefaultResourceLoader>) {
    const runtime = createExtensionRuntime();
    const extensions = extensionFactory
      ? [await loadExtensionFromFactory(extensionFactory, cwd, createEventBus(), runtime, "<lifecycle-fixture>")]
      : [];
    resources.set(this, { runtime, extensions, errors: [] });
  });
  t.mock.method(DefaultResourceLoader.prototype, "getExtensions", function (this: InstanceType<typeof DefaultResourceLoader>) {
    const result = resources.get(this);
    assert.ok(result);
    return result;
  });
  const create = (options: Parameters<typeof bridge.createPiSession>[5] = {}) =>
    bridge.createPiSession(row.id, cwd, row.provider, row.model, undefined, options);
  t.after(async () => { await bounded(bridge.destroyPiSession(row.id)); db.close(); });
  return { row, cwd, create, providerDispatches: () => providerDispatches };
}

test("pre-aborted creation does no work, including no identity/generation mutation", async (t) => {
  const f = await fixture(t);
  const controller = new AbortController();
  controller.abort();
  const generation = bridge.capturePiSessionCreationGeneration(f.row.id);
  const effects: string[] = [];
  await assert.rejects(f.create({ signal: controller.signal, testHooks: {
    onPrivilegedEffect: (effect) => effects.push(effect),
    afterStandardResourcesResolution: async () => { effects.push("resolution"); },
  } }), { name: "AbortError" });
  assert.deepEqual(effects, []);
  assert.deepEqual(bridge.capturePiSessionCreationGeneration(f.row.id), generation);
  assert.equal(bridge.getPiSession(f.row.id), undefined);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
});

for (const checkpoint of ["afterStandardResourcesResolution", "beforeExtensionStartup", "afterExtensionStartup"] as const) {
  test(`owned abort at ${checkpoint} fences publication and waits for actual gate drain`, async (t) => {
    const f = await fixture(t);
    const entered = gate();
    const release = gate();
    const controller = new AbortController();
    const effects: string[] = [];
    let partialSession: AgentSession | undefined;
    const pending = observe(f.create({ signal: controller.signal, testHooks: {
      [checkpoint]: async (value: boolean | AgentSession) => {
        if (typeof value !== "boolean") partialSession = value;
        entered.resolve();
        await release.promise;
      },
      onPrivilegedEffect: (effect) => effects.push(effect),
    } }));
    try {
      await bounded(entered.promise);
      const generation = bridge.capturePiSessionCreationGeneration(f.row.id);
      controller.abort();
      assert.notDeepEqual(bridge.capturePiSessionCreationGeneration(f.row.id), generation,
        "the denial epoch advances synchronously, not after startup returns");
      if (partialSession) assert.deepEqual(partialSession.getActiveToolNames(), [],
        "the exact partial AgentSession loses active tools synchronously");
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(pending.settled(), false, "cancel requested is not drained startup");
      assert.equal(bridge.getPiSession(f.row.id), undefined);
      release.resolve();
      assert.equal((await bounded(pending.result)).ok, false);
      assert.equal(effects.includes("handle_publication"), false);
      assert.equal(getEventListeners(controller.signal, "abort").length, 0);
      const fresh = await bounded(f.create());
      assert.equal(bridge.getPiSession(f.row.id), fresh);
    } finally { release.resolve(); await bounded(pending.result); }
  });
}

test("owned abort synchronously denies exact partial browser authority while factory remains pending", async (t) => {
  const f = await fixture(t);
  const entered = gate();
  const release = gate();
  const controller = new AbortController();
  let binding: ProtectedBrowserBinding | undefined;
  const pending = observe(f.create({ signal: controller.signal, protectedBrowserFactory: async (candidate) => {
    binding = candidate;
    entered.resolve();
    await release.promise;
    throw new Error("synthetic factory drained");
  } }));
  try {
    await bounded(entered.promise);
    assert.ok(binding);
    assert.ok(bridge.resolveInteractiveBrowserAuthority(binding));
    controller.abort();
    assert.equal(bridge.resolveInteractiveBrowserAuthority(binding), null);
    assert.equal(pending.settled(), false);
    release.resolve();
    assert.equal((await bounded(pending.result)).ok, false);
    assert.equal(bridge.getPiSession(f.row.id), undefined);
  } finally { release.resolve(); await bounded(pending.result); }
});

test("joiner abort only detaches its wait; owner and successful-handoff signals cannot cancel replacements", async (t) => {
  const f = await fixture(t);
  const entered = gate();
  const release = gate();
  const owner = new AbortController();
  const joiner = new AbortController();
  const pending = observe(f.create({ signal: owner.signal, testHooks: {
    afterStandardResourcesResolution: async () => { entered.resolve(); await release.promise; },
  } }));
  try {
    await bounded(entered.promise);
    const generation = bridge.capturePiSessionCreationGeneration(f.row.id);
    const joining = observe(f.create({ signal: joiner.signal }));
    joiner.abort();
    assert.equal((await bounded(joining.result)).ok, false);
    assert.deepEqual(bridge.capturePiSessionCreationGeneration(f.row.id), generation);
    assert.equal(pending.settled(), false);
    release.resolve();
    const result = await bounded(pending.result);
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const handle = result.value;
    assert.equal(getEventListeners(owner.signal, "abort").length, 0);
    const observer = new AbortController();
    assert.equal(await f.create({ signal: observer.signal }), handle);
    observer.abort();
    assert.equal(handle.capabilityAuthorityDenied, undefined);
    await bridge.destroyPiSession(f.row.id, undefined, handle);
    const replacement = await f.create();
    owner.abort();
    await bridge.destroyPiSession(f.row.id, undefined, handle);
    assert.equal(bridge.getPiSession(f.row.id), replacement);
    assert.equal(replacement.capabilityAuthorityDenied, undefined);
    // Exact object mapping must survive old-handle destruction.
    const globals = globalThis as typeof globalThis & { __pi_sudo_session_managers?: WeakMap<object, string> };
    assert.equal(globals.__pi_sudo_session_managers?.get(replacement.session.sessionManager), f.row.id);
    await bridge.destroyPiSession(f.row.id); // omitted expected handle remains supported
    assert.equal(bridge.getPiSession(f.row.id), undefined);
  } finally { release.resolve(); await bounded(pending.result); }
});

test("old expected handle cannot deny a new pending creation", async (t) => {
  const f = await fixture(t);
  const old = await f.create();
  await bridge.destroyPiSession(f.row.id, undefined, old);
  const entered = gate();
  const release = gate();
  const pending = observe(f.create({ testHooks: {
    afterStandardResourcesResolution: async () => { entered.resolve(); await release.promise; },
  } }));
  try {
    await bounded(entered.promise);
    const generation = bridge.capturePiSessionCreationGeneration(f.row.id);
    await bounded(bridge.destroyPiSession(f.row.id, undefined, old));
    assert.deepEqual(bridge.capturePiSessionCreationGeneration(f.row.id), generation);
    release.resolve();
    assert.equal((await bounded(pending.result)).ok, true);
  } finally { release.resolve(); await bounded(pending.result); }
});

test("same-generation destruction joins before replacement and preserves successor identity maps", async (t) => {
  const f = await fixture(t);
  const old = await f.create();
  const entered = gate();
  const release = gate();
  let closes = 0;
  const uninstall = bridge.installInteractiveBrowserSessionLifecyclePort({
    captureSessionWorkspaceCleanup(sourceSessionId, reason) {
      return this.closeSessionWorkspaces.bind(this, sourceSessionId, reason);
    },
    captureAuthorityCleanup(scope, reason) { return this.revokeAuthority.bind(this, { ...scope }, reason); },
    async closeSessionWorkspaces(_sourceSessionId: string, _reason: string) { closes++; entered.resolve(); await release.promise; },
    async revokeAuthority(_scope: unknown, _reason: string) {},
    blocksPiIdleDetach: () => false,
    async close() {},
  });
  const late = observe(bridge.destroyPiSession(f.row.id, { kind: "close_session", reason: "session_delete" }, old));
  let joining: ReturnType<typeof observe<void>> | undefined;
  try {
    await bounded(entered.promise);
    joining = observe(bridge.destroyPiSession(f.row.id, undefined, old));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(joining.settled(), false, "same-generation destruction shares the original cleanup owner");
    assertCleanupUnconfirmed(await bounded(observe(f.create()).result));
    release.resolve();
    assert.equal((await bounded(late.result)).ok, true);
    assert.equal((await bounded(joining.result)).ok, true);
    const replacement = await bounded(f.create());
    await bridge.destroyPiSession(f.row.id, undefined, old);
    assert.equal(bridge.getPiSession(f.row.id), replacement);
    assert.equal(replacement.capabilityAuthorityDenied, undefined);
    assert.equal(closes, 1, "no new id-scoped cleanup starts after replacement publication");
    const globals = globalThis as typeof globalThis & {
      __pi_sudo_session_managers?: WeakMap<object, string>;
      __pi_sudo_pi_sessions?: Map<string, string>;
      __pi_sudo_cwd_sessions?: Map<string, string>;
    };
    assert.equal(globals.__pi_sudo_session_managers?.get(replacement.session.sessionManager), f.row.id);
    assert.equal(globals.__pi_sudo_pi_sessions?.get(replacement.session.sessionId), f.row.id);
    assert.equal(globals.__pi_sudo_cwd_sessions?.get(f.cwd), f.row.id);
  } finally { release.resolve(); await bounded(Promise.all([late.result, joining?.result])); uninstall(); }
});

for (const hook of ["input", "before_agent_start"] as const) {
  test(`real SDK ${hook}: bridge interrupt settles only after canceled preflight drains`, async (t) => {
    const entered = gate();
    const release = gate();
    const f = await fixture(t, (pi) => {
      if (hook === "input") pi.on("input", async () => { entered.resolve(); await release.promise; });
      else pi.on("before_agent_start", async () => { entered.resolve(); await release.promise; });
    });
    const handle = await f.create();
    const settled = gate();
    const events: unknown[] = [];
    handle.events.on("message", (message) => { events.push(message); settled.resolve(); });
    const pending = observe(handle.session.prompt("cancelled synthetic preflight"));
    try {
      await bounded(entered.promise);
      assert.equal(handle.session.isStreaming, false);
      assert.equal(handle.session.isIdle, true, "SDK run-idle intentionally excludes preflight");
      assert.equal(handle.session.pendingPromptCount, 1);
      await bounded(bridge.abortInteractiveTurn(handle));
      assert.equal(handle.session.pendingPromptCount, 1);
      assert.equal(pending.settled(), false);
      assert.deepEqual(events, [], "abort completion must not fabricate whole-invocation settlement");
      release.resolve();
      await bounded(pending.result);
      await bounded(settled.promise);
      assert.equal(handle.session.pendingPromptCount, 0);
      assert.deepEqual(events, [{ type: "agent_settled" }]);
      assert.equal(f.providerDispatches(), 0);
    } finally { release.resolve(); await bounded(pending.result); }
  });
}

test("real SDK: old canceled preflight cannot synthetically settle a newer pending prompt", async (t) => {
  const oldEntered = gate();
  const oldRelease = gate();
  const newEntered = gate();
  const newRelease = gate();
  const f = await fixture(t, (pi) => {
    pi.on("input", async (event) => {
      if (event.text === "old") { oldEntered.resolve(); await oldRelease.promise; }
      else { newEntered.resolve(); await newRelease.promise; }
    });
  });
  const handle = await f.create();
  const events: unknown[] = [];
  handle.events.on("message", (message) => events.push(message));
  const old = observe(handle.session.prompt("old"));
  let newer: ReturnType<typeof observe<void>> | undefined;
  try {
    await bounded(oldEntered.promise);
    await bounded(bridge.abortInteractiveTurn(handle));
    newer = observe(handle.session.prompt("new"));
    await bounded(newEntered.promise);
    assert.equal(handle.session.pendingPromptCount, 2);
    oldRelease.resolve();
    await bounded(old.result);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(handle.session.pendingPromptCount, 1);
    assert.deepEqual(events, [], "the old drain observer cannot settle a new pending invocation");
    const settled = gate();
    handle.events.once("message", () => settled.resolve());
    await bounded(bridge.abortInteractiveTurn(handle));
    assert.deepEqual(events, []);
    newRelease.resolve();
    await bounded(newer.result);
    await bounded(settled.promise);
    assert.deepEqual(events, [{ type: "agent_settled" }], "only the newer interruption owns this idle notification");
    assert.equal(f.providerDispatches(), 0);
  } finally {
    await handle.session.abort();
    oldRelease.resolve(); newRelease.resolve();
    await bounded(Promise.all([old.result, newer?.result]));
  }
});

test("real SDK: destruction waits for preflight and suppresses its stale interrupt observer", async (t) => {
  const entered = gate();
  const release = gate();
  const f = await fixture(t, (pi) => {
    pi.on("input", async () => { entered.resolve(); await release.promise; });
  });
  const handle = await f.create();
  const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
  const events: unknown[] = [];
  handle.events.on("message", (message) => events.push(message));
  const pending = observe(handle.session.prompt("old runtime"));
  let stopping: ReturnType<typeof observe<void>> | undefined;
  try {
    await bounded(entered.promise);
    await bounded(bridge.abortInteractiveTurn(handle));
    stopping = observe(bridge.destroyPiSession(f.row.id, undefined, handle));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(handle.capabilityAuthorityDenied, true);
    assert.equal(stopping.settled(), false);
    assert.equal(dispose.mock.callCount(), 0);
    assert.equal(handle.session.pendingPromptCount, 1);
    release.resolve();
    await bounded(pending.result);
    assert.equal((await bounded(stopping.result)).ok, true);
    assert.equal(dispose.mock.callCount(), 1);
    assert.deepEqual(events, [], "a denied old runtime cannot publish its delayed idle event");
    const replacement = await f.create();
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(bridge.getPiSession(f.row.id), replacement);
    assert.equal(replacement.capabilityAuthorityDenied, undefined);
    assert.equal(f.providerDispatches(), 0);
  } finally { release.resolve(); await bounded(Promise.all([pending.result, stopping?.result])); }
});

test("real SDK: new SDK ingress outside the denial fence cannot turn a snapshot into cleanup success", async (t) => {
  const oldEntered = gate();
  const oldRelease = gate();
  const lateEntered = gate();
  const lateRelease = gate();
  const f = await fixture(t, (pi) => {
    pi.on("input", async (event) => {
      if (event.text === "old") { oldEntered.resolve(); await oldRelease.promise; }
      else { lateEntered.resolve(); await lateRelease.promise; }
    });
  });
  const handle = await f.create();
  const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
  const old = observe(handle.session.prompt("old"));
  let late: ReturnType<typeof observe<void>> | undefined;
  let stopping: ReturnType<typeof observe<void>> | undefined;
  try {
    await bounded(oldEntered.promise);
    stopping = observe(bridge.destroyPiSession(f.row.id, undefined, handle));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(handle.capabilityAuthorityDenied, true);
    // Deliberately bypass Wayang ingress to exercise trusted SDK misuse. The
    // production bridge must detect a new invocation outside its captured set.
    late = observe(handle.session.prompt("outside Wayang denial fence"));
    await bounded(lateEntered.promise);
    oldRelease.resolve();
    await bounded(old.result);
    const result = await bounded(stopping.result);
    assert.equal(result.ok, false);
    assertCleanupUnconfirmed(result);
    assert.equal(dispose.mock.callCount(), 0);
    assert.equal(handle.session.pendingPromptCount, 1);
    assert.equal(bridge.getPiSession(f.row.id), handle);
    assert.equal(f.providerDispatches(), 0);
  } finally {
    await handle.session.abort();
    oldRelease.resolve(); lateRelease.resolve();
    await bounded(Promise.all([old.result, late?.result, stopping?.result]));
  }
});

test("real SDK: shutdown-hook prompt drains before low-level disposal", async (t) => {
  const entered = gate();
  const release = gate();
  const f = await fixture(t, (pi) => {
    pi.on("input", async () => { entered.resolve(); await release.promise; });
    pi.on("session_shutdown", async () => {
      pi.sendUserMessage("detached shutdown-hook preflight");
      await entered.promise;
    });
  });
  const handle = await f.create();
  const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
  const stopping = observe(bridge.destroyPiSession(f.row.id, undefined, handle));
  try {
    await bounded(entered.promise);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(handle.session.pendingPromptCount, 1);
    assert.equal(stopping.settled(), false);
    assert.equal(dispose.mock.callCount(), 0);
    release.resolve();
    assert.equal((await bounded(stopping.result)).ok, true);
    assert.equal(handle.session.pendingPromptCount, 0);
    assert.equal(dispose.mock.callCount(), 1);
    assert.equal(f.providerDispatches(), 0);
  } finally { release.resolve(); await bounded(stopping.result); }
});

test("real SDK: unpublished cleanup waits for prompt preflight after startup itself drained", async (t) => {
  const entered = gate();
  const release = gate();
  const f = await fixture(t, (pi) => {
    pi.on("input", async () => { entered.resolve(); await release.promise; });
  });
  let pending: ReturnType<typeof observe<void>> | undefined;
  let partial: AgentSession | undefined;
  let disposed = 0;
  const creation = observe(f.create({ testHooks: {
    afterExtensionStartup: async (session) => {
      partial = session;
      const originalDispose = session.dispose.bind(session);
      t.mock.method(session, "dispose", () => { disposed++; originalDispose(); });
      pending = observe(session.prompt("startup-owned preflight"));
      await entered.promise;
      throw new Error("synthetic failure after startup");
    },
  } }));
  try {
    await bounded(entered.promise);
    await new Promise<void>((done) => setImmediate(done));
    assert.ok(partial);
    assert.equal(partial.pendingPromptCount, 1);
    assert.equal(creation.settled(), false, "startup failure must await the real pending invocation");
    assert.equal(disposed, 0);
    release.resolve();
    await bounded(pending!.result);
    assert.equal((await bounded(creation.result)).ok, false);
    assert.equal(disposed, 1);
    assert.equal(bridge.getPiSession(f.row.id), undefined);
    assert.equal(f.providerDispatches(), 0);
  } finally { release.resolve(); await bounded(Promise.all([pending?.result, creation.result])); }
});

function assertCleanupUnconfirmed(result: { ok: boolean; error?: unknown }): void {
  assert.equal(result.ok, false, "uncertain cleanup must not report success");
  assert.ok(result.error instanceof bridge.PiSessionCleanupUnconfirmedError);
  assert.equal("code" in result.error && result.error.code, "pi_session_cleanup_unconfirmed");
  assert.equal(result.error.message, "Session runtime cleanup is unconfirmed");
  assert.equal("cause" in result.error, false, "cleanup errors must not expose raw SDK/closer payloads");
}

test("cleanup APIs deny forged error-object receipts", async () => {
  const forged = new bridge.PiSessionCleanupUnconfirmedError();
  for (const unknownReceipt of [forged, undefined, null, 0, "synthetic", {}, new Error("synthetic"),
    { code: "pi_session_cleanup_unconfirmed", message: forged.message }]) {
    await assert.rejects(bridge.retryPiSessionCleanup(unknownReceipt), /receipt is not recognized/);
    await assert.rejects(bridge.waitForPiSessionCleanup(unknownReceipt), /receipt is not recognized/);
  }
  assert.deepEqual(Object.keys(forged), ["code"], "the public receipt carries no routing ID or owned payload");
});

test("real SDK: failed creation retains partial ownership when prompt B outlives cleanup snapshot A", async (t) => {
  const aEntered = gate();
  const aRelease = gate();
  const bEntered = gate();
  const bRelease = gate();
  const f = await fixture(t, (pi) => {
    pi.on("input", async (event) => {
      if (event.text === "A") { aEntered.resolve(); await aRelease.promise; }
      else { bEntered.resolve(); await bRelease.promise; }
    });
  });
  let partial: AgentSession | undefined;
  let a: ReturnType<typeof observe<void>> | undefined;
  let b: ReturnType<typeof observe<void>> | undefined;
  let retry: ReturnType<typeof observe<void>> | undefined;
  let stronger: ReturnType<typeof observe<void>> | undefined;
  let disposals = 0;
  const creation = observe(f.create({ testHooks: {
    afterExtensionStartup: async (session) => {
      partial = session;
      const originalDispose = session.dispose.bind(session);
      t.mock.method(session, "dispose", () => { disposals++; originalDispose(); });
      a = observe(session.prompt("A"));
      await aEntered.promise;
      throw new Error("synthetic startup payload must not escape cleanup uncertainty");
    },
  } }));
  try {
    await bounded(aEntered.promise);
    // Let creation cleanup abort A and take its real pending-prompt snapshot.
    await new Promise<void>((done) => setImmediate(done));
    assert.ok(partial);
    b = observe(partial.prompt("B"));
    await bounded(bEntered.promise);
    aRelease.resolve();
    await bounded(a!.result);
    const failed = await bounded(creation.result);
    assert.equal(partial.pendingPromptCount, 1);
    assert.equal(disposals, 0);
    await t.test("rejection distinguishes unconfirmed cleanup without raw payloads", () => assertCleanupUnconfirmed(failed));
    assert.ok(!failed.ok && failed.error instanceof bridge.PiSessionCleanupUnconfirmedError);
    const receipt = failed.error;
    const confirmation = observe(bridge.waitForPiSessionCleanup(receipt));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(confirmation.settled(), false, "scheduler overlap ownership must remain held");
    stronger = observe(bridge.destroyPiSession(f.row.id, { kind: "close_session", reason: "archive" }));
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(stronger.settled(), false, "an upgrade still owns the original gated invocation");
    assert.equal(confirmation.settled(), false);
    const effects: string[] = [];
    const replacement = await bounded(observe(f.create({ testHooks: {
      onPrivilegedEffect: (effect) => effects.push(effect),
    } })).result);
    await t.test("unconfirmed partial ownership blocks replacement without replaying startup", () => {
      assertCleanupUnconfirmed(replacement);
      assert.deepEqual(effects, []);
      assert.equal(bridge.getPiSession(f.row.id), undefined);
    });
    // Explicit retry targets the retained exact owner; it is not an automatic
    // retry loop and cannot complete while B's invocation remains gated.
    retry = observe(bridge.retryPiSessionCleanup(receipt));
    await new Promise<void>((done) => setImmediate(done));
    await t.test("explicit cleanup retry still owns B until actual settlement", () => {
      assert.equal(retry!.settled(), false);
      assert.equal(disposals, 0);
    });
    bRelease.resolve();
    await bounded(b.result);
    assert.equal((await bounded(retry.result)).ok, true);
    assert.equal((await bounded(stronger.result)).ok, true);
    assert.equal((await bounded(confirmation.result)).ok, true);
    await t.test("confirmed cleanup disposes the original partial session", () => assert.equal(disposals, 1));
    const fresh = await bounded(f.create());
    await bridge.retryPiSessionCleanup(receipt);
    await bridge.waitForPiSessionCleanup(receipt);
    assert.equal(bridge.getPiSession(f.row.id), fresh, "confirmed old receipts never target a successor");
    assert.equal(fresh.capabilityAuthorityDenied, undefined);
    assert.equal(f.providerDispatches(), 0);
  } finally {
    // Also clean the exact synthetic partial on the unfixed baseline, which
    // otherwise forgets it. This does not count as production cleanup evidence.
    await partial?.abort();
    aRelease.resolve(); bRelease.resolve();
    await bounded(Promise.all([creation.result, a?.result, b?.result, retry?.result, stronger?.result]));
    if (partial && disposals === 0) partial.dispose();
  }
});

test("idle maintenance cannot retry unconfirmed cleanup or block an unrelated session", async (t) => {
  const f = await fixture(t);
  const handle = await f.create();
  let attempts = 0;
  let fail = true;
  const originalDispose = handle.session.dispose.bind(handle.session);
  t.mock.method(handle.session, "dispose", () => {
    attempts++;
    if (fail) throw new Error("synthetic disposal failure");
    originalDispose();
  });
  let otherId: string | undefined;
  try {
    assertCleanupUnconfirmed(await bounded(observe(bridge.destroyPiSession(f.row.id)).result));
    handle.lastActivityAt = Date.now() - 10 * 60_000;
    assert.equal((await bounded(bridge.stopIdlePiSessions())).includes(f.row.id), false);
    assert.equal(await bridge.stopPiSessionIfIdle(f.row.id), false);
    assert.equal(attempts, 1, "idle maintenance must not become a hidden retry loop");
    assert.ok(f.row.agent_profile_id);
    const other = createSession(f.cwd, { agentProfileId: f.row.agent_profile_id,
      provider: f.row.provider!, model: f.row.model! });
    otherId = other.id;
    const unrelated = await bounded(bridge.createPiSession(other.id, f.cwd, other.provider, other.model));
    assert.equal(bridge.getPiSession(other.id), unrelated);
    assert.equal(attempts, 1, "another creation cannot implicitly retry the failed owner");
  } finally {
    fail = false;
    await bounded(bridge.destroyPiSession(f.row.id));
    if (otherId) await bounded(bridge.destroyPiSession(otherId));
  }
});

for (const upgrade of [false, true]) {
  test(`simultaneous initial destruction shares one receipt${upgrade ? " across a severity upgrade" : ""}`, async (t) => {
    const f = await fixture(t);
    const handle = await f.create();
    const artifact = handle.artifactToolRuntime;
    assert.ok(artifact);
    const originalClose = artifact.close.bind(artifact);
    const entered = gate();
    const release = gate();
    let attempts = 0;
    let fail = true;
    let captures = 0;
    let workspaceCloses = 0;
    let reentered: ReturnType<typeof observe<void>> | undefined;
    let second: ReturnType<typeof observe<void>> | undefined;
    const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
    const uninstall = bridge.installInteractiveBrowserSessionLifecyclePort({
      captureSessionWorkspaceCleanup(id, reason) {
        captures++;
        // These arguments belong to the upgrade request, not a later retry.
        return async () => {
          assert.equal(id, f.row.id); assert.equal(reason, "archive");
          workspaceCloses++;
        };
      },
      captureAuthorityCleanup() { return async () => {}; },
      async closeSessionWorkspaces() { assert.fail("must retain the captured cleanup"); },
      async revokeAuthority() { assert.fail("must retain the captured cleanup"); },
      blocksPiIdleDetach: () => false, async close() {},
    });
    t.mock.method(artifact, "close", async () => {
      attempts++;
      if (attempts === 1) {
        // The shared initial owner must exist even before this first callback.
        reentered = observe(bridge.destroyPiSession(f.row.id, undefined, handle));
        entered.resolve();
        await release.promise;
      }
      if (fail) throw new Error("synthetic shared-owner cleanup failure");
      await originalClose();
    });
    const first = observe(bridge.destroyPiSession(f.row.id, undefined, handle));
    try {
      await bounded(entered.promise);
      second = observe(bridge.destroyPiSession(f.row.id,
        upgrade ? { kind: "close_session", reason: "archive" } : undefined, handle));
      await new Promise<void>((done) => setImmediate(done));
      assert.ok(reentered);
      assert.equal(attempts, 1);
      assert.equal(first.settled(), false);
      assert.equal(second.settled(), false);
      assert.equal(reentered.settled(), false);
      assert.equal(dispose.mock.callCount(), 0);
      release.resolve();
      const failures = await bounded(Promise.all([first.result, second.result, reentered.result]));
      const receipts = failures.map((failed) => {
        assertCleanupUnconfirmed(failed);
        assert.ok(!failed.ok && failed.error instanceof bridge.PiSessionCleanupUnconfirmedError);
        return failed.error;
      });
      const confirmations = receipts.map((receipt) => observe(bridge.waitForPiSessionCleanup(receipt)));
      await new Promise<void>((done) => setImmediate(done));
      assert.ok(confirmations.every((entry) => !entry.settled()));
      const blocked = await bounded(observe(f.create()).result);
      assertCleanupUnconfirmed(blocked);
      assert.equal(attempts, 1, "new creation cannot replay the initial cleanup");
      fail = false;
      await bounded(bridge.destroyPiSession(f.row.id));
      await new Promise<void>((done) => setImmediate(done));
      assert.ok(confirmations.every((entry) => entry.settled()),
        "one explicit destroy must confirm every initial caller; no orphan receipt may remain pending");
      for (const confirmation of confirmations) assert.equal((await bounded(confirmation.result)).ok, true);
      assert.ok(receipts.every((receipt) => receipt === receipts[0]), "one exact initial owner has one opaque receipt");
      assert.equal(attempts, 2);
      assert.equal(dispose.mock.callCount(), 1);
      assert.equal(captures, upgrade ? 1 : 0, "a stronger initial request is captured once");
      assert.equal(workspaceCloses, upgrade ? 1 : 0, "confirmation includes the stronger teardown, without replay");
      const replacement = await bounded(f.create());
      for (const receipt of receipts) await bounded(bridge.retryPiSessionCleanup(receipt));
      await bounded(bridge.destroyPiSession(f.row.id, undefined, handle));
      assert.equal(bridge.getPiSession(f.row.id), replacement);
      assert.equal(replacement.capabilityAuthorityDenied, undefined);
      assert.equal(attempts, 2, "old confirmations cannot acquire a successor's cleanup");
      assert.equal(f.providerDispatches(), 0);
    } finally {
      fail = false;
      release.resolve();
      const outcomes = await bounded(Promise.all([first.result, second?.result, reentered?.result]));
      // Exact test-only recovery also confirms otherwise-orphaned baseline
      // receipts; no private state edits or forgotten synthetic owners.
      for (const outcome of outcomes) {
        if (outcome && !outcome.ok && outcome.error instanceof bridge.PiSessionCleanupUnconfirmedError) {
          await bounded(bridge.retryPiSessionCleanup(outcome.error));
        }
      }
      await bounded(bridge.destroyPiSession(f.row.id));
      uninstall();
    }
  });
}

test("reentrant disposal observer joins before the real shutdown hook is invoked", async (t) => {
  const entered = gate();
  const release = gate();
  let shutdownCalls = 0;
  let reenter: (() => void) | undefined;
  let nested: ReturnType<typeof observe<void>> | undefined;
  const f = await fixture(t, (pi) => {
    pi.on("session_shutdown", async () => {
      shutdownCalls++;
      const callback = reenter;
      reenter = undefined;
      callback?.(); // Deliberately non-awaited: this hook must not await itself.
      entered.resolve();
      await release.promise;
    });
  });
  const handle = await f.create();
  const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
  reenter = () => { nested = observe(bridge.disposePiAgentSession(handle)); };
  const first = observe(bridge.disposePiAgentSession(handle));
  const joining = observe(bridge.disposePiAgentSession(handle));
  try {
    await bounded(entered.promise);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(shutdownCalls, 1, "the disposal promise must be published before runner.emit calls a hook");
    assert.ok(nested);
    assert.equal(first.settled(), false);
    assert.equal(joining.settled(), false);
    assert.equal(nested.settled(), false);
    assert.equal(dispose.mock.callCount(), 0);
    release.resolve();
    assert.equal((await bounded(first.result)).ok, true);
    assert.equal((await bounded(joining.result)).ok, true);
    assert.equal((await bounded(nested.result)).ok, true);
    await bounded(bridge.disposePiAgentSession(handle));
    assert.equal(shutdownCalls, 1);
    assert.equal(dispose.mock.callCount(), 1);
    assert.equal(f.providerDispatches(), 0);
  } finally {
    reenter = undefined;
    release.resolve();
    await bounded(Promise.all([first.result, joining.result, nested?.result]));
    await bounded(bridge.destroyPiSession(f.row.id));
  }
});

test("reentrant initial cleanup joins the current closer before disposal", async (t) => {
  const f = await fixture(t);
  const handle = await f.create();
  const artifact = handle.artifactToolRuntime;
  assert.ok(artifact);
  const originalClose = artifact.close.bind(artifact);
  const entered = gate();
  const release = gate();
  const reentries: ReturnType<typeof observe<void>>[] = [];
  let attempts = 0;
  let reenter = true;
  const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
  t.mock.method(artifact, "close", async () => {
    attempts++;
    if (reenter) {
      reenter = false;
      // Observe only: awaiting one's own cleanup inside its closer would deadlock.
      reentries.push(observe(bridge.destroyPiSession(f.row.id, undefined, handle)));
      reentries.push(observe(bridge.closePiSessionAuthorities(handle)));
    }
    entered.resolve();
    await release.promise;
    await originalClose();
  });
  const stopping = observe(bridge.destroyPiSession(f.row.id, undefined, handle));
  try {
    await bounded(entered.promise);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(attempts, 1, "synchronous reentry cannot invoke the closer twice");
    assert.equal(dispose.mock.callCount(), 0, "an unpublished step promise must not count as successful cleanup");
    assert.equal(stopping.settled(), false);
    assert.equal(reentries.length, 2);
    assert.ok(reentries.every((entry) => !entry.settled()), "every reentrant caller joins the current gated step");
    assert.equal(bridge.getPiSession(f.row.id), handle);
    release.resolve();
    assert.equal((await bounded(stopping.result)).ok, true);
    for (const entry of reentries) assert.equal((await bounded(entry.result)).ok, true);
    assert.equal(attempts, 1);
    assert.equal(dispose.mock.callCount(), 1);
    assert.equal(f.providerDispatches(), 0);
  } finally {
    release.resolve();
    await bounded(stopping.result);
    await bounded(Promise.all(reentries.map((entry) => entry.result)));
    await bounded(bridge.destroyPiSession(f.row.id));
  }
});

test("reentrant cleanup retry joins current reservation and step rather than the previous rejection", async (t) => {
  const f = await fixture(t);
  const handle = await f.create();
  const artifact = handle.artifactToolRuntime;
  assert.ok(artifact);
  const originalClose = artifact.close.bind(artifact);
  const entered = gate();
  const release = gate();
  const reentries: ReturnType<typeof observe<void>>[] = [];
  let attempts = 0;
  let fail = true;
  let reenter: (() => void) | undefined;
  const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
  t.mock.method(artifact, "close", async () => {
    attempts++;
    if (fail) throw new Error("synthetic first cleanup failure");
    const callback = reenter;
    reenter = undefined;
    callback?.();
    entered.resolve();
    await release.promise;
    await originalClose();
  });
  let retrying: ReturnType<typeof observe<void>> | undefined;
  let joining: ReturnType<typeof observe<void>> | undefined;
  try {
    const failed = await bounded(observe(bridge.destroyPiSession(f.row.id, undefined, handle)).result);
    assertCleanupUnconfirmed(failed);
    assert.ok(!failed.ok && failed.error instanceof bridge.PiSessionCleanupUnconfirmedError);
    const receipt = failed.error;
    const confirmation = observe(bridge.waitForPiSessionCleanup(receipt));
    assert.equal(attempts, 1);
    assert.equal(dispose.mock.callCount(), 0);
    reenter = () => {
      // Reservation joins and a direct public authority-cleanup join exercise
      // both publication gaps independently, without inspecting private state.
      reentries.push(observe(bridge.retryPiSessionCleanup(receipt)));
      reentries.push(observe(bridge.destroyPiSession(f.row.id, undefined, handle)));
      reentries.push(observe(bridge.closePiSessionAuthorities(handle)));
    };
    fail = false;
    retrying = observe(bridge.retryPiSessionCleanup(receipt));
    joining = observe(bridge.retryPiSessionCleanup(receipt));
    await bounded(entered.promise);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(attempts, 2, "there is exactly one closer call for this explicit retry");
    assert.equal(dispose.mock.callCount(), 0, "the current closer still owns its gate");
    assert.equal(retrying.settled(), false);
    assert.equal(joining.settled(), false);
    assert.equal(reentries.length, 3);
    assert.ok(reentries.every((entry) => !entry.settled()),
      "reentry must neither resolve undefined work nor join an earlier rejected attempt");
    assert.equal(confirmation.settled(), false, "reentry cannot confirm cleanup before the current attempt drains");
    assert.equal(bridge.getPiSession(f.row.id), handle);
    release.resolve();
    assert.equal((await bounded(retrying.result)).ok, true);
    assert.equal((await bounded(joining.result)).ok, true);
    for (const entry of reentries) assert.equal((await bounded(entry.result)).ok, true);
    assert.equal((await bounded(confirmation.result)).ok, true);
    assert.equal(attempts, 2);
    assert.equal(dispose.mock.callCount(), 1);
    await bounded(bridge.retryPiSessionCleanup(receipt));
    assert.equal(attempts, 2, "confirmed receipt stays inert");
    assert.equal(f.providerDispatches(), 0);
  } finally {
    fail = false;
    reenter = undefined;
    release.resolve();
    if (retrying) await bounded(retrying.result);
    if (joining) await bounded(joining.result);
    await bounded(Promise.all(reentries.map((entry) => entry.result)));
    await bounded(bridge.destroyPiSession(f.row.id));
  }
});

for (const published of [false, true]) {
  test(`${published ? "published" : "unpublished"} disposer failure retains exact ownership until explicit retry succeeds`, async (t) => {
    const f = await fixture(t);
    let partial: AgentSession | undefined;
    let attempts = 0;
    let fail = true;
    const creation = observe(f.create({ testHooks: {
      afterExtensionStartup: async (session) => {
        partial = session;
        const originalDispose = session.dispose.bind(session);
        t.mock.method(session, "dispose", () => {
          attempts++;
          if (fail) throw new Error("synthetic disposer payload must stay private");
          originalDispose();
        });
        if (!published) throw new Error("synthetic startup failure");
      },
    } }));
    try {
      const created = await bounded(creation.result);
      const failed = published && created.ok
        ? await bounded(observe(bridge.destroyPiSession(f.row.id, undefined, created.value)).result)
        : created;
      await t.test("failure remains typed and unconfirmed", () => assertCleanupUnconfirmed(failed));
      const beforeReplacement = attempts;
      const replacement = await bounded(observe(f.create()).result);
      await t.test("new creation cannot erase or implicitly retry the failed owner", () => {
        assertCleanupUnconfirmed(replacement);
        assert.equal(attempts, beforeReplacement);
      });
      fail = false;
      await bounded(bridge.destroyPiSession(f.row.id));
      await t.test("explicit retry disposes the same SDK session", () => assert.equal(attempts, 2));
      const fresh = await bounded(f.create());
      assert.notEqual(fresh.session, partial);
      assert.equal(f.providerDispatches(), 0);
    } finally {
      fail = false;
      await bounded(creation.result);
      await bounded(bridge.destroyPiSession(f.row.id));
      if (partial && attempts < 2) partial.dispose();
    }
  });

  test(`${published ? "published" : "unpublished"} browser closer rejection is retained rather than swallowed by allSettled`, async (t) => {
    const f = await fixture(t);
    let attempts = 0;
    let sdkDisposals = 0;
    let completedResourceCloses = 0;
    let fail = true;
    const tool = defineTool({
      name: "browser_cleanup_probe", label: "Cleanup probe", description: "Synthetic cleanup-only fixture.",
      parameters: Type.Object({}),
      async execute() { assert.fail("cleanup fixture must never execute a browser tool"); },
    });
    const close = async () => {
      attempts++;
      if (fail) throw new Error("synthetic browser closer payload must stay private");
    };
    const creation = observe(f.create({
      protectedBrowserFactory(binding) {
        return {
          kind: "standard", binding, tools: [tool],
          toolForName: (name) => name === tool.name ? tool : undefined,
          preflight: () => bridge.resolveInteractiveBrowserAuthority(binding)
            ? { allowed: true } : { allowed: false, reason: "runtime denied" },
          detachAgentLease: close, closeSessionWorkspaces: close, revokeAuthority: close,
        };
      },
      testHooks: { afterExtensionStartup: async (session) => {
        const originalDispose = session.dispose.bind(session);
        t.mock.method(session, "dispose", () => { sdkDisposals++; originalDispose(); });
        if (!published) throw new Error("synthetic startup failure");
      } },
    }));
    try {
      const created = await bounded(creation.result);
      if (published && created.ok) {
        const artifact = created.value.artifactToolRuntime;
        assert.ok(artifact);
        const originalClose = artifact.close.bind(artifact);
        t.mock.method(artifact, "close", async () => { completedResourceCloses++; await originalClose(); });
      }
      const failed = published && created.ok
        ? await bounded(observe(bridge.destroyPiSession(f.row.id, undefined, created.value)).result)
        : created;
      await t.test("failed closer cannot count as cleanup confirmation", () => assertCleanupUnconfirmed(failed));
      assert.ok(!failed.ok && failed.error instanceof bridge.PiSessionCleanupUnconfirmedError);
      const confirmation = observe(bridge.waitForPiSessionCleanup(failed.error));
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(confirmation.settled(), false);
      const replacement = await bounded(observe(f.create()).result);
      await t.test("failed browser owner still fences replacement", () => assertCleanupUnconfirmed(replacement));
      assert.equal(attempts, 1, "no hidden retry or startup replay");
      if (published) {
        const retried = await bounded(observe(bridge.retryPiSessionCleanup(failed.error)).result);
        assertCleanupUnconfirmed(retried);
        assert.ok(!retried.ok && retried.error === failed.error, "failed retries preserve the exact receipt identity");
        assert.equal(attempts, 2);
        assert.equal(confirmation.settled(), false, "one failed scheduler retry cannot release overlap ownership");
      }
      fail = false;
      await bounded(bridge.destroyPiSession(f.row.id));
      await t.test("explicit retry retains the exact failed browser closer", () => assert.equal(attempts, published ? 3 : 2));
      assert.equal(sdkDisposals, 1, "a confirmed SDK disposal is never repeated for a failed sibling closer");
      if (published) assert.equal(completedResourceCloses, 1, "confirmed sibling resources are not closed again");
      assert.equal((await bounded(confirmation.result)).ok, true,
        "later explicit destroy wakes the scheduler's exact receipt observer");
      await bounded(f.create());
    } finally {
      fail = false;
      await bounded(creation.result);
      await bounded(bridge.destroyPiSession(f.row.id));
    }
  });
}

// Only the Chromium I/O boundary is synthetic. Service, host, Standard runtime,
// Pi bridge and AgentSession lifecycle implementations remain composed and real.
class ComposedBrowserBackend implements StandardBrowserHostBackend {
  running = false;
  targets = new Map<string, StandardBrowserBackendTarget>();
  closeFailures = new Set<string>();
  closeCalls: string[] = [];
  serial = 0;
  constructor(private callbacks: StandardBrowserHostBackendCallbacks) {}
  async start(authorize: () => Promise<void>) { await authorize(); this.running = true; }
  async stop() { this.running = false; this.targets.clear(); }
  async listTargets() { return [...this.targets.values()]; }
  async createTarget(url: string) {
    const target = { id: `composed-target-${++this.serial}`, url };
    this.targets.set(target.id, target);
    this.callbacks.targetCreated(target);
    return target;
  }
  async closeTarget(id: string) {
    this.closeCalls.push(id);
    if (this.closeFailures.has(id)) throw new Error("synthetic composed target close failure");
    this.targets.delete(id);
    this.callbacks.targetDestroyed(id);
  }
  async execute(_id: string, operation: ProtectedBrowserOperation, authorize: () => Promise<void>) {
    await authorize();
    return { kind: operation.kind };
  }
}

for (const action of ["close_session", "revoke"] as const) {
  test(`composed Standard runtime/service/bridge ${action} retries its pre-denial snapshot only`, async (t) => {
    const f = await fixture(t);
    const { StandardBrowserProfileHostService } = await import("./browser/standard-service.js");
    const { browserProfileStorageIdentityDigest } = await import("./browser/profile-catalog-store.js");
    const { getActionApprovalBridge } = await import("./action-approval-bridge.js");
    const dataDir = fs.mkdtempSync(path.join(root, "composed-browser-"));
    const profiles: BrowserProfileRow[] = ["alpha", "beta"].map((name, index) => {
      const source = { kind: "managed" as const, storage_key: name };
      return { id: index === 0 ? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" : "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
        name, storage_source: source, storage_identity_digest: browserProfileStorageIdentityDigest(dataDir, source),
        state: "active", revision: 1, created_at: 1, updated_at: 1 };
    });
    const otherId = `${f.row.id}:unrelated`;
    const states = new Map<string, SessionBrowserStateRow>([
      [f.row.id, { session_id: f.row.id, active_profile_id: profiles[0]!.id, revision: 1, updated_at: 1 }],
      [otherId, { session_id: otherId, active_profile_id: profiles[1]!.id, revision: 1, updated_at: 1 }],
    ]);
    // Synthetic catalogue grants are exact fixture inputs, not replacements for
    // any production authorization function or reads of private browser state.
    const grants = new Map<string, Readonly<ProtectedBrowserBinding>>();
    let selections = 0;
    const catalog: StandardBrowserCatalogPort = {
      authorize(binding, profile) {
        const grant = grants.get(binding.runtimeGeneration);
        return Boolean(grant && profile.state === "active" && profiles.some((row) => row.id === profile.id)
          && binding.capabilityId === grant.capabilityId && binding.sourceSessionId === grant.sourceSessionId
          && binding.projectId === grant.projectId && binding.projectCwd === grant.projectCwd
          && binding.agentProfileId === grant.agentProfileId && binding.associationRevision === grant.associationRevision
          && binding.processBootNonce === grant.processBootNonce && binding.controlGeneration === grant.controlGeneration);
      },
      ownerAuthority(sourceSessionId, profile) {
        const grant = [...grants.values()].find((binding) => binding.sourceSessionId === sourceSessionId);
        return grant && profile.state === "active" ? { sourceSessionId, projectId: grant.projectId,
          projectCwd: grant.projectCwd, agentProfileId: grant.agentProfileId,
          associationRevision: grant.associationRevision } : null;
      },
      catalog: () => ({ generation: 1, profiles }),
      materializeSessionState(binding) { const state = states.get(binding.sourceSessionId); assert.ok(state); return { ...state }; },
      sessionState(id) { const state = states.get(id); return state ? { ...state } : null; },
      switchSessionProfile() { assert.fail("profile switching is not an agent action in this fixture"); },
      projectDefault: () => null,
      setProjectDefault() { assert.fail("project default mutation is outside this fixture"); },
      sourceSessionsForAuthority(scope) {
        selections++;
        return [...new Set([...grants.values()].filter((binding) => binding.capabilityId === scope.capabilityId
          && binding.projectId === scope.projectId && binding.agentProfileId === scope.agentProfileId)
          .map((binding) => binding.sourceSessionId))];
      },
    };
    const backends: ComposedBrowserBackend[] = [];
    const service = new StandardBrowserProfileHostService({ dataDir, catalog,
      backendFactory: ({ callbacks }) => {
        const backend = new ComposedBrowserBackend(callbacks); backends.push(backend); return backend;
      } });
    let uninstall = () => {};
    let unsubscribe = () => {};
    let detachClient = () => {};
    let lateOpen: ReturnType<typeof observe<unknown>> | undefined;
    let stopping: ReturnType<typeof observe<void>> | undefined;
    const approvals = getActionApprovalBridge();
    try {
      let oldRuntime: ReturnType<typeof service.createRuntime> | undefined;
      const handle = await bounded(f.create({ protectedBrowserFactory(binding) {
        grants.set(binding.runtimeGeneration, binding);
        oldRuntime = service.createRuntime(binding);
        return oldRuntime;
      } }));
      assert.ok(oldRuntime, "the published bridge handle must contain the real Standard runtime");
      assert.equal(handle.protectedBrowserRuntime, oldRuntime);
      const oldBinding = oldRuntime.binding;
      const original = service.resolveLiveWorkspace(oldBinding);
      assert.ok(original);
      await bounded(original.host.execute(oldBinding, original.workspaceGeneration, { kind: "start" }));
      const oldBackend = backends[0]!;
      const oldTarget = [...oldBackend.targets.keys()][0];
      assert.ok(oldTarget);

      // Beta already has a host, but this source session has no workspace there
      // at capture time. Its existing unrelated workspace must also survive.
      const otherBinding: ProtectedBrowserBinding = { ...oldBinding, sourceSessionId: otherId,
        projectId: `${oldBinding.projectId}:unrelated`, projectCwd: path.join(f.cwd, "unrelated"),
        runtimeGeneration: `${oldBinding.runtimeGeneration}:unrelated` };
      grants.set(otherBinding.runtimeGeneration, otherBinding);
      const otherRuntime = service.createRuntime(otherBinding);
      const other = service.resolveLiveWorkspace(otherBinding);
      assert.ok(other);
      await bounded(other.host.execute(otherBinding, other.workspaceGeneration, { kind: "start" }));
      assert.notEqual(original.host, other.host);
      const betaBackend = backends[1]!;
      const otherTarget = [...betaBackend.targets.keys()][0];
      assert.ok(otherTarget);

      let rawCaptured: (() => Promise<void>) | undefined;
      const captureSession = service.captureSessionWorkspaceCleanup.bind(service);
      const captureAuthority = service.captureAuthorityCleanup.bind(service);
      const sessionCaptures = t.mock.method(service, "captureSessionWorkspaceCleanup", (...args: Parameters<typeof captureSession>) => {
        rawCaptured = captureSession(...args); return rawCaptured;
      });
      const authorityCaptures = t.mock.method(service, "captureAuthorityCleanup", (...args: Parameters<typeof captureAuthority>) => {
        rawCaptured = captureAuthority(...args); return rawCaptured;
      });
      // Spies forward into the real adapter, not fake teardown implementations.
      const adapter = action === "close_session"
        ? t.mock.method(oldRuntime, "closeSessionWorkspaces", oldRuntime.closeSessionWorkspaces.bind(oldRuntime))
        : t.mock.method(oldRuntime, "revokeAuthority", oldRuntime.revokeAuthority.bind(oldRuntime));
      const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
      uninstall = bridge.installInteractiveBrowserSessionLifecyclePort(service);
      let denialCallbacks = 0;
      let capturesAtDenial = 0;
      let callbackError: unknown;
      const lateBinding: ProtectedBrowserBinding = { ...oldBinding, runtimeGeneration: `${oldBinding.runtimeGeneration}:late` };
      const arrived: { runtime?: ReturnType<typeof service.createRuntime>; workspace?: StandardBrowserRuntimeWorkspace | null } = {};
      detachClient = approvals.attachClient(f.row.id, "synthetic-composed-client");
      unsubscribe = approvals.onTerminal((event) => {
        if (event.sessionId !== f.row.id || event.status !== "cancelled" || denialCallbacks > 0) return;
        denialCallbacks++;
        capturesAtDenial = sessionCaptures.mock.callCount();
        try {
          const state = states.get(f.row.id)!;
          state.active_profile_id = profiles[1]!.id; state.revision++;
          grants.set(lateBinding.runtimeGeneration, lateBinding);
          arrived.runtime = service.createRuntime(lateBinding);
          arrived.workspace = service.resolveLiveWorkspace(lateBinding);
          assert.ok(arrived.workspace);
          lateOpen = observe(arrived.workspace.host.execute(lateBinding, arrived.workspace.workspaceGeneration, { kind: "start" }));
        } catch (error) { callbackError = error; }
      });
      const approval = observe(approvals.requestApproval(f.row.id, { connector: "synthetic-composed",
        toolName: "synthetic_write", summary: "Synthetic cancellation callback", argumentsHash: "a".repeat(64) }));
      assert.equal(approvals.getPendingRequests(f.row.id).length, 1);
      oldBackend.closeFailures.add(oldTarget);
      stopping = observe(bridge.destroyPiSession(f.row.id, action === "close_session"
        ? { kind: "close_session", reason: "archive" } : { kind: "revoke", reason: "capability_revoked" }, handle));
      assert.equal(denialCallbacks, 1, "a real approval-denial observer introduced the later workspace");
      assert.equal(capturesAtDenial, 1, "the process snapshot preceded the cancellation notification");
      assert.equal(callbackError, undefined);
      assert.ok(lateOpen);
      assert.equal((await bounded(lateOpen.result)).ok, true);
      const failed = await bounded(stopping.result);
      assertCleanupUnconfirmed(failed);
      assert.ok(!failed.ok && failed.error instanceof bridge.PiSessionCleanupUnconfirmedError);
      const receipt = failed.error;
      const confirmation = observe(bridge.waitForPiSessionCleanup(receipt));
      await new Promise<void>((done) => setImmediate(done));
      assert.equal(confirmation.settled(), false);
      const decision = await bounded(approval.result);
      assert.ok(decision.ok && decision.value.status === "cancelled");
      assert.equal(dispose.mock.callCount(), 0);
      assert.equal(adapter.mock.callCount(), 1);
      assert.equal(adapter.mock.calls[0]!.arguments[1], rawCaptured, "the real adapter received the raw captured operation");
      assert.deepEqual(oldBackend.closeCalls, [oldTarget]);
      assert.ok(oldBackend.targets.has(oldTarget));
      assert.deepEqual(original.host.cleanupPendingSessionIds(), [f.row.id]);
      const lateRuntime = arrived.runtime;
      const lateWorkspace = arrived.workspace;
      assert.ok(lateRuntime);
      assert.equal(lateRuntime.preflight().allowed, true);
      assert.ok(lateWorkspace);
      assert.equal(service.resolveLiveWorkspace(lateBinding), lateWorkspace);
      assert.deepEqual(betaBackend.closeCalls, []);
      assert.equal(betaBackend.targets.size, 2);

      assertCleanupUnconfirmed(await bounded(observe(f.create()).result));
      oldBackend.closeFailures.clear();
      await bounded(bridge.retryPiSessionCleanup(receipt));
      assert.equal((await bounded(confirmation.result)).ok, true);
      assert.equal(adapter.mock.callCount(), 2, "the real Standard adapter retried instead of caching a failed promise");
      assert.equal(adapter.mock.calls[1]!.arguments[1], rawCaptured);
      assert.equal(sessionCaptures.mock.callCount(), 1, "neither bridge nor adapter recaptured workspace targets");
      assert.equal(authorityCaptures.mock.callCount(), action === "revoke" ? 1 : 0);
      assert.equal(selections, action === "revoke" ? 1 : 0);
      assert.equal(dispose.mock.callCount(), 1);
      assert.deepEqual(oldBackend.closeCalls, [oldTarget, oldTarget]);
      assert.equal(oldBackend.targets.size, 0);
      assert.deepEqual(original.host.cleanupPendingSessionIds(), []);
      assert.equal(oldRuntime.preflight().allowed, false);
      assert.equal(otherRuntime.preflight().allowed, true);
      assert.equal(lateRuntime.preflight().allowed, true);
      assert.equal(service.resolveLiveWorkspace(lateBinding), lateWorkspace);
      assert.equal(lateWorkspace.host.hasWorkspace(f.row.id, lateWorkspace.workspaceGeneration), true);
      assert.ok(betaBackend.targets.has(otherTarget));
      assert.equal(betaBackend.targets.size, 2);
      assert.deepEqual(betaBackend.closeCalls, []);
      await bounded(bridge.retryPiSessionCleanup(receipt));
      await bounded(bridge.destroyPiSession(f.row.id, undefined, handle));
      assert.equal(service.resolveLiveWorkspace(lateBinding), lateWorkspace);
      assert.equal(sessionCaptures.mock.callCount(), 1);
      assert.equal(f.providerDispatches(), 0);
    } finally {
      unsubscribe();
      approvals.cancelSession(f.row.id, "synthetic test cleanup");
      detachClient();
      for (const backend of backends) backend.closeFailures.clear();
      if (lateOpen) await bounded(lateOpen.result);
      if (stopping) await bounded(stopping.result);
      await bounded(bridge.destroyPiSession(f.row.id));
      uninstall();
      await bounded(service.close());
    }
  });
}

for (const owner of ["published", "starting", "detached", "authority"] as const) {
  test(`${owner} browser cleanup captures once before denial observers and retries only original targets`, async (t) => {
    const f = await fixture(t);
    const entered = gate();
    const release = gate();
    const oldTarget = { closed: false };
    const newerTarget = { closed: false };
    let targets = [oldTarget];
    let captures = 0;
    let attempts = 0;
    let legacyCalls = 0;
    let fail = true;
    let binding: ProtectedBrowserBinding | undefined;
    const tool = defineTool({ name: "browser_capture_probe", label: "Capture probe",
      description: "Synthetic capture probe", parameters: Type.Object({}),
      async execute() { return { content: [{ type: "text" as const, text: "synthetic" }], details: {} }; } });
    const creation = owner === "detached" ? undefined : observe(f.create({
      protectedBrowserFactory(candidate) {
        binding = candidate;
        return { kind: "standard", binding: candidate, tools: [tool],
          toolForName: (name) => name === tool.name ? tool : undefined,
          preflight: () => ({ allowed: true }),
          async detachAgentLease() {}, async closeSessionWorkspaces() {}, async revokeAuthority() {} };
      },
      testHooks: owner === "starting" ? { afterStandardResourcesResolution: async () => {
        entered.resolve(); await release.promise;
      } } : {},
    }));
    if (owner === "starting") await bounded(entered.promise);
    else if (creation) assert.equal((await bounded(creation.result)).ok, true);
    const capture = () => {
      captures++;
      const snapshot = [...targets];
      return async () => {
        attempts++;
        if (fail) throw new Error("synthetic closer failure must not escape");
        for (const target of snapshot) target.closed = true;
      };
    };
    const uninstall = bridge.installInteractiveBrowserSessionLifecyclePort({
      captureSessionWorkspaceCleanup(id, reason) {
        assert.equal(id, f.row.id); assert.equal(reason, "archive");
        return capture();
      },
      captureAuthorityCleanup(scope, reason) {
        assert.ok(binding);
        assert.deepEqual(scope, { capabilityId: binding.capabilityId,
          projectId: binding.projectId, agentProfileId: binding.agentProfileId });
        assert.equal(reason, "capability_revoked");
        return capture();
      },
      async closeSessionWorkspaces() { legacyCalls++; throw new Error("must use captured operation"); },
      async revokeAuthority() { legacyCalls++; throw new Error("must use captured operation"); },
      blocksPiIdleDetach: () => false, async close() {},
    });
    const unsubscribe = bridge.onPiSessionRuntimeEvent(() => { targets = [newerTarget]; });
    try {
      const stopping = observe(owner === "starting"
        ? bridge.stopPiSession(f.row.id, { kind: "close_session", reason: "archive" })
        : bridge.destroyPiSession(f.row.id, owner === "authority"
          ? { kind: "revoke", reason: "capability_revoked" }
          : { kind: "close_session", reason: "archive" }));
      assert.equal(captures, 1, "capture must precede notifications and the first startup await");
      targets = [newerTarget];
      release.resolve();
      const failed = await bounded(stopping.result);
      assertCleanupUnconfirmed(failed);
      assert.ok(!failed.ok && failed.error instanceof bridge.PiSessionCleanupUnconfirmedError);
      const completion = observe(bridge.waitForPiSessionCleanup(failed.error));
      assertCleanupUnconfirmed(await bounded(observe(f.create()).result));
      assert.equal(completion.settled(), false);
      fail = false;
      await bounded(bridge.destroyPiSession(f.row.id));
      assert.equal((await bounded(completion.result)).ok, true);
      assert.equal(captures, 1, "receipt retry must not recapture by session/pair ID");
      assert.equal(attempts, 2);
      assert.equal(legacyCalls, 0);
      assert.equal(oldTarget.closed, true);
      assert.equal(newerTarget.closed, false);
      await bounded(bridge.retryPiSessionCleanup(failed.error));
      assert.equal(attempts, 2, "confirmed receipt is inert");
    } finally {
      release.resolve(); fail = false;
      if (creation) await bounded(creation.result);
      await bounded(bridge.destroyPiSession(f.row.id));
      unsubscribe(); uninstall();
    }
  });
}

test("browser cleanup failure cannot short-circuit a pending abort operation", async (t) => {
  const f = await fixture(t);
  const handle = await f.create();
  const entered = gate();
  const release = gate();
  t.mock.method(handle.session, "abort", async () => { entered.resolve(); await release.promise; });
  let failBrowserCleanup = true;
  const uninstall = bridge.installInteractiveBrowserSessionLifecyclePort({
    captureSessionWorkspaceCleanup(sourceSessionId, reason) {
      return this.closeSessionWorkspaces.bind(this, sourceSessionId, reason);
    },
    captureAuthorityCleanup(scope, reason) { return this.revokeAuthority.bind(this, { ...scope }, reason); },
    async closeSessionWorkspaces(_sourceSessionId: string, _reason: string) {
      if (failBrowserCleanup) throw new Error("synthetic browser cleanup failure");
    },
    async revokeAuthority(_scope: unknown, _reason: string) {},
    blocksPiIdleDetach: () => false,
    async close() {},
  });
  const stopping = observe(bridge.destroyPiSession(f.row.id, { kind: "close_session", reason: "archive" }, handle));
  try {
    await bounded(entered.promise);
    await new Promise<void>((done) => setImmediate(done));
    assert.equal(stopping.settled(), false, "cleanup failure must still await the abort operation");
    release.resolve();
    assert.equal((await bounded(stopping.result)).ok, false);
  } finally {
    release.resolve();
    await bounded(stopping.result);
    failBrowserCleanup = false;
    await bounded(bridge.destroyPiSession(f.row.id));
    uninstall();
  }
});

test("destruction invokes abort even while SDK reports non-streaming", async (t) => {
  const f = await fixture(t);
  const handle = await f.create();
  const entered = gate();
  const release = gate();
  // Public seam tests invocation/awaiting of abort even when non-streaming.
  // It does NOT model preflight drainage: real SDK abort cancels ingress but
  // awaits active-run idle only; the owning invocation must prove hook drainage.
  const abort = t.mock.method(handle.session, "abort", async () => { entered.resolve(); await release.promise; });
  const dispose = t.mock.method(handle.session, "dispose", handle.session.dispose.bind(handle.session));
  assert.equal(handle.session.isStreaming, false);
  const stopping = observe(bridge.destroyPiSession(f.row.id, undefined, handle));
  try {
    await bounded(entered.promise);
    assert.equal(handle.capabilityAuthorityDenied, true);
    assert.equal(stopping.settled(), false);
    assert.equal(dispose.mock.callCount(), 0);
    release.resolve();
    assert.equal((await bounded(stopping.result)).ok, true);
    assert.ok(abort.mock.callCount() >= 1);
    assert.equal(dispose.mock.callCount(), 1);
  } finally { release.resolve(); await bounded(stopping.result); }
});
