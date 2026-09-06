import test, { after } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AssistantMessage, Context } from "@earendil-works/pi-ai";
import type {
  AgentSession,
  ExtensionFactory,
  LoadExtensionsResult,
  ProviderConfig,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";

// Run under Wayang's hermetic preloader as well: it fences import-time backend
// configuration. Only non-secret environment names are saved/restored here.
const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-sdk-audit-contract-"));
const home = path.join(root, "home");
const agentDir = path.join(home, ".pi", "agent");
const environment = {
  HOME: home,
  PI_CODING_AGENT_DIR: agentDir,
  PI_CODING_AGENT_SESSION_DIR: path.join(agentDir, "sessions"),
  WAYANG_DATA_DIR: path.join(root, "data"),
  XDG_CONFIG_HOME: path.join(home, ".config"),
  XDG_CACHE_HOME: path.join(home, ".cache"),
  PI_OFFLINE: "1",
  PI_SKIP_VERSION_CHECK: "1",
  PI_TELEMETRY: "0",
};
const previousEnvironment = new Map(Object.keys(environment).map((key) => [key, process.env[key]]));
for (const [key, value] of Object.entries(environment)) process.env[key] = value;
fs.mkdirSync(agentDir, { recursive: true });
after(() => {
  for (const [key, value] of previousEnvironment) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  // This exact mkdtemp root contains only this file's synthetic fixtures.
  fs.rmSync(root, { recursive: true, force: true });
});

const {
  createAgentSession, createEventBus, createExtensionRuntime,
  DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} = await import("@earendil-works/pi-coding-agent");
const { createAssistantMessageEventStream, InMemoryCredentialStore } = await import("@earendil-works/pi-ai");
// The pinned SDK exposes this inline factory loader in dist, but not its barrel.
// It invokes the real ExtensionAPI; no lifecycle event is manufactured here.
const { loadExtensionFromFactory } = await import(
  "../node_modules/@earendil-works/pi-coding-agent/dist/core/extensions/loader.js"
);

const SOURCE = { provider: "audit-offline-source", model: "source-high" };
const TARGET = { provider: "audit-offline-target", model: "target-low" };
const DEADLINE_MS = 5_000;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(work: Promise<T>, label: string): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`Synthetic fixture deadline: ${label}`)), DEADLINE_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Attach rejection handling at admission, not after a gated operation releases.
function observe<T>(work: Promise<T>) {
  return work.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
}

function userTexts(messages: readonly { role: string; content?: unknown }[]): string[] {
  return messages.filter((message) => message.role === "user").map((message) => {
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";
    return message.content.filter((block) => block?.type === "text")
      .map((block) => block.text).join("");
  });
}

type Dispatch = { provider: string; model: string; users: string[] };
const originalCreateModelRuntime = ModelRuntime.create.bind(ModelRuntime);
async function offlineModels(dispatches: Dispatch[]) {
  const runtime = await originalCreateModelRuntime({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
    allowModelNetwork: false,
  });
  for (const selected of [SOURCE, TARGET]) {
    const config: ProviderConfig = {
      api: "audit-offline-api",
      apiKey: "synthetic-in-memory-only",
      baseUrl: "https://offline.invalid",
      models: [{
        id: selected.model,
        name: selected.model,
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 1024,
        ...(selected === TARGET ? {
          thinkingLevelMap: { minimal: null, low: "low", medium: null, high: null, xhigh: null, max: null },
        } : {}),
      }],
      streamSimple(model, context: Context) {
        // This is the actual provider dispatch, after SDK preflight/auth. The
        // provider completes synchronously and owns no timers, sockets or tools.
        dispatches.push({ provider: model.provider, model: model.id, users: userTexts(context.messages) });
        const stream = createAssistantMessageEventStream();
        const output: AssistantMessage = {
          role: "assistant", api: model.api, provider: model.provider, model: model.id,
          content: [{ type: "text", text: "synthetic response" }],
          stopReason: "stop", timestamp: Date.now(),
          usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        };
        stream.push({ type: "start", partial: output });
        stream.push({ type: "done", reason: "stop", message: output });
        stream.end();
        return stream;
      },
    };
    runtime.registerProvider(selected.provider, config);
  }
  await runtime.refresh({ allowNetwork: false });
  return runtime;
}

async function inlineExtensions(cwd: string, factory: ExtensionFactory): Promise<LoadExtensionsResult> {
  const runtime = createExtensionRuntime();
  const extension = await loadExtensionFromFactory(factory, cwd, createEventBus(), runtime, "<audit-contract>");
  return { runtime, extensions: [extension], errors: [] };
}

function isolatedLoader(extensions: LoadExtensionsResult): ResourceLoader {
  // Explicit resources: never call DefaultResourceLoader discovery, even against
  // a synthetic HOME (ancestor context/package discovery is unnecessary here).
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Synthetic offline SDK contract fixture.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources() {},
    async reload() {},
  };
}

for (const hook of ["input", "before_agent_start"] as const) {
  test(`real SDK abort fences a prompt gated in ${hook}`, { timeout: 30_000 }, async (t) => {
    const cwd = path.join(root, hook);
    fs.mkdirSync(cwd, { recursive: true });
    const entered = deferred();
    const release = deferred();
    const staleText = `cancelled in ${hook}`;
    const freshText = `fresh after ${hook}`;
    const dispatches: Dispatch[] = [];
    const extensionErrors: unknown[] = [];
    const extensions = await inlineExtensions(cwd, (pi) => {
      if (hook === "input") {
        pi.on("input", async (event) => {
          if (event.text !== staleText) return;
          entered.resolve();
          await release.promise;
          return { action: "transform", text: `${staleText} transformed` };
        });
      } else {
        pi.on("before_agent_start", async (event) => {
          if (event.prompt !== staleText) return;
          entered.resolve();
          await release.promise;
          return { message: { customType: "audit-stale-hook", content: "cancelled hook context", display: true } };
        });
      }
    });
    const modelRuntime = await offlineModels(dispatches);
    const manager = SessionManager.create(cwd, path.join(root, "transcripts"));
    manager.materialize();
    let session: AgentSession | undefined;
    let pending: ReturnType<typeof observe<void>> | undefined;
    let aborting: ReturnType<typeof observe<void>> | undefined;
    let unsubscribe: (() => void) | undefined;
    try {
      ({ session } = await createAgentSession({
        cwd, agentDir, modelRuntime, model: modelRuntime.getModel(SOURCE.provider, SOURCE.model),
        noTools: "all", resourceLoader: isolatedLoader(extensions), sessionManager: manager,
        settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } }),
      }));
      await session.bindExtensions({ onError: (error) => extensionErrors.push(error) });
      const messageStarts: string[] = [];
      unsubscribe = session.subscribe((event) => {
        if (event.type === "message_start") messageStarts.push(event.message.role);
      });
      pending = observe(session.prompt(staleText));
      await bounded(entered.promise, `${hook} entered`);
      assert.equal(dispatches.length, 0, "the gate precedes actual provider dispatch");
      assert.deepEqual(messageStarts, [], "the gate precedes message commitment");
      // Invoke abort before release, without requiring abort to resolve while an
      // uncooperative hook is held. A repaired SDK may await preflight drainage.
      aborting = observe(session.abort());
      await new Promise<void>((done) => setImmediate(done));
      release.resolve();
      await bounded(Promise.all([pending, aborting]), `${hook} cancellation drained`);
      await bounded(session.waitForIdle(), `${hook} idle after release`);
      const cancelledSnapshot = {
        dispatches: [...dispatches],
        messages: [...session.messages],
        committed: manager.getEntries().filter((entry) => entry.type === "message" || entry.type === "custom_message"),
        messageStarts: [...messageStarts],
      };
      const freshResult = await bounded(observe(session.prompt(freshText)), `${hook} fresh prompt`);
      await bounded(session.waitForIdle(), `${hook} fresh idle`);
      // Independent assertions expose all contract failures on the baseline,
      // rather than preventing the fresh-prompt control after the first red.
      await t.test("no late provider dispatch", () => assert.deepEqual(cancelledSnapshot.dispatches, []));
      await t.test("no stale message commitment or lifecycle start", () => {
        assert.deepEqual(cancelledSnapshot.messages, []);
        assert.deepEqual(cancelledSnapshot.committed, []);
        assert.deepEqual(cancelledSnapshot.messageStarts, []);
        const reopened = SessionManager.open(manager.getSessionFile()!, undefined, cwd);
        assert.deepEqual(userTexts(reopened.buildSessionContext().messages), [freshText]);
        assert.equal(reopened.getEntries().some((entry) => entry.type === "custom_message" && entry.customType === "audit-stale-hook"), false);
      });
      await t.test("a subsequent fresh prompt succeeds", () => {
        assert.equal(freshResult.ok, true);
        assert.equal(dispatches.length - cancelledSnapshot.dispatches.length, 1);
        assert.equal(dispatches.at(-1)?.users.at(-1), freshText);
        const last = session!.messages.at(-1);
        assert.equal(last?.role, "assistant");
        if (last?.role === "assistant") assert.equal(last.stopReason, "stop");
        assert.deepEqual(extensionErrors, []);
      });
    } finally {
      release.resolve();
      try {
        await bounded(Promise.all([pending, aborting]), `${hook} final drainage`);
        if (session) await bounded(session.abort(), `${hook} final abort`);
      } finally {
        unsubscribe?.();
        session?.dispose();
      }
    }
  });
}

test("Standard live model switch never writes global defaults across a gated model_select", { timeout: 30_000 }, async (t) => {
  const cwd = path.join(root, "standard-project");
  fs.mkdirSync(cwd, { recursive: true });
  const initial = { defaultProvider: SOURCE.provider, defaultModel: SOURCE.model, defaultThinkingLevel: "high" };
  const deliberate = { defaultProvider: "deliberate-provider", defaultModel: "deliberate-model", defaultThinkingLevel: "medium" };
  const settingsPath = path.join(agentDir, "settings.json");
  fs.writeFileSync(settingsPath, JSON.stringify({
    ...initial, compaction: { enabled: false }, retry: { enabled: false },
    enableInstallTelemetry: false, packages: [], defaultTools: [],
  }));
  const entered = deferred();
  const release = deferred();
  const dispatches: Dispatch[] = [];
  const hookSelections: string[] = [];
  const resources = new WeakMap<InstanceType<typeof DefaultResourceLoader>, LoadExtensionsResult>();

  // Replace ONLY fixture input boundaries unavailable as createPiSession options:
  // real ModelRuntime instances get memory auth + offline providers, and discovery
  // gets explicit inline resources. AgentSession, SettingsManager file I/O,
  // prompt/queue/abort/setModel and both bridge model-switch functions stay real.
  const runtimeFactory = t.mock.method(ModelRuntime, "create", () => offlineModels(dispatches));
  const discovery = t.mock.method(DefaultResourceLoader.prototype, "reload", async function (this: InstanceType<typeof DefaultResourceLoader>) {
    resources.set(this, await inlineExtensions(cwd, (pi) => {
      pi.on("model_select", async (event) => {
        if (event.model.provider !== TARGET.provider) return;
        hookSelections.push(event.model.id);
        entered.resolve();
        await release.promise;
      });
    }));
  });
  const extensionsGetter = t.mock.method(DefaultResourceLoader.prototype, "getExtensions", function (this: InstanceType<typeof DefaultResourceLoader>) {
    const result = resources.get(this);
    assert.ok(result, "fixture discovery must initialize this exact loader");
    return result;
  });
  const bridge = await import("./pi-bridge.js");
  const db = await import("./db.js");
  const { createAgentProfile } = await import("./agent-profiles.js");
  const { createProject } = await import("./projects.js");
  const { createSession, getSessionById } = await import("./sessions.js");
  let id: string | undefined;
  let switching: ReturnType<typeof observe<Awaited<ReturnType<typeof bridge.setSessionModel>>>> | undefined;
  let active: AgentSession | undefined;
  const readDefaults = () => {
    const settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
    return { defaultProvider: settings.defaultProvider, defaultModel: settings.defaultModel, defaultThinkingLevel: settings.defaultThinkingLevel };
  };
  try {
    db.init();
    const profile = createAgentProfile({ name: "SDK audit Standard", resource_mode: "standard", memory_access: "none" });
    const project = createProject({ cwd, name: "SDK audit Standard", default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] } });
    const row = createSession(cwd, { ...SOURCE, agentProfileId: profile.id });
    id = row.id;
    const handle = await bounded(bridge.createPiSession(id, cwd, SOURCE.provider, SOURCE.model), "Standard session creation");
    active = handle.session;
    assert.equal(project.access_policy.privacy_mode, "standard");
    assert.equal(active.thinkingLevel, "high");
    const generation = handle.runtimeGeneration;
    const tools = active.getActiveToolNames();
    // Real SDK queue admission makes the public bridge take its live-switch
    // branch. No isStreaming/pending-count assignment or fake agent event.
    await active.followUp("retained synthetic follow-up");
    assert.equal(active.pendingMessageCount, 1);
    switching = observe(bridge.setSessionModel(id, TARGET.provider, TARGET.model));
    await bounded(entered.promise, "model_select entered");
    await active.settingsManager.flush();
    const duringHook = readDefaults();
    const effectiveThinkingDuringHook = active.thinkingLevel;
    const writer = SettingsManager.create(cwd, agentDir);
    writer.setDefaultModelAndProvider(deliberate.defaultProvider, deliberate.defaultModel);
    writer.setDefaultThinkingLevel("medium");
    await writer.flush();
    assert.deepEqual(writer.drainErrors(), []);
    assert.deepEqual(readDefaults(), deliberate, "independent deliberate write is durable before hook release");
    release.resolve();
    const result = await bounded(switching, "live model switch completed");
    await active.settingsManager.flush();
    const afterHook = readDefaults();

    await t.test("provider/model defaults remain unchanged during model_select", () => {
      assert.deepEqual([duringHook.defaultProvider, duringHook.defaultModel], [initial.defaultProvider, initial.defaultModel]);
    });
    await t.test("thinking clamp is session-only during model_select", () => {
      assert.equal(effectiveThinkingDuringHook, "low", "target capabilities still clamp live thinking");
      assert.equal(duringHook.defaultThinkingLevel, initial.defaultThinkingLevel);
    });
    await t.test("a concurrent deliberate global update survives switch completion", () => assert.deepEqual(afterHook, deliberate));
    await t.test("live identity, queue and transcript model change survive", async () => {
      assert.equal(result.ok, true);
      if (result.ok) assert.equal(result.value.applied_live, true);
      assert.equal(bridge.getPiSession(id!), handle);
      assert.equal(handle.runtimeGeneration, generation);
      assert.deepEqual(active!.getActiveToolNames(), tools);
      assert.deepEqual(active!.getFollowUpMessages(), ["retained synthetic follow-up"]);
      assert.deepEqual([getSessionById(id!)?.provider, getSessionById(id!)?.model], [TARGET.provider, TARGET.model]);
      assert.equal(active!.sessionManager.getBranch().some((entry) => entry.type === "model_change"
        && entry.provider === TARGET.provider && entry.modelId === TARGET.model), true);
      await bounded(active!.prompt("fresh after live switch"), "fresh switched prompt and queued follow-up");
      assert.equal(active!.pendingMessageCount, 0);
      assert.ok(dispatches.length > 0);
      assert.equal(dispatches.every((dispatch) => dispatch.provider === TARGET.provider && dispatch.model === TARGET.model), true);
    });
    await t.test("later settings reload observes deliberate defaults", async () => {
      await active!.settingsManager.reload();
      const global = active!.settingsManager.getGlobalSettings();
      assert.deepEqual({ defaultProvider: global.defaultProvider, defaultModel: global.defaultModel,
        defaultThinkingLevel: global.defaultThinkingLevel }, deliberate);
      assert.deepEqual(active!.settingsManager.drainErrors(), []);
    });
  } finally {
    release.resolve();
    try {
      await bounded(Promise.all([switching]), "model switch final drainage");
      if (id) await bounded(bridge.destroyPiSession(id), "Standard runtime teardown");
      if (active) await active.settingsManager.flush();
    } finally {
      active?.dispose();
      db.close();
      extensionsGetter.mock.restore();
      discovery.mock.restore();
      runtimeFactory.mock.restore();
    }
  }
});
