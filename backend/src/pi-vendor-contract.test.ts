import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore } from "@earendil-works/pi-ai";
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type CustomMessage, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

function packageMetadata(entry: string): Record<string, unknown> {
  // Both reviewed packages export dist/index.js; read public package metadata,
  // never Pi's user configuration or credential storage.
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(entry)), "..", "package.json"), "utf8"));
}

test("vendored SDK and core resolve to the same reviewed exact-discard implementation", async () => {
  const sdk = packageMetadata(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const core = packageMetadata(import.meta.resolve("@earendil-works/pi-agent-core"));
  assert.match(String(sdk.wayangSourceRevision), /^[0-9a-f]{40}$/);
  assert.equal(sdk.wayangRequiredCoreSourceRevision, sdk.wayangSourceRevision);
  assert.equal(core.wayangSourceRevision, sdk.wayangSourceRevision);
  assert.equal(sdk.version, `0.84.1-wayang.${String(sdk.wayangSourceRevision).slice(0, 8)}`);
  assert.equal(core.version, "0.84.1", "core uses upstream semver plus immutable source provenance");

  const root = mkdtempSync(join(tmpdir(), "wayang-vendored-pi-contract-"));
  const runtime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(), modelsPath: null,
    refreshOnCreate: false, allowModelNetwork: false,
  });
  const resourceLoader: ResourceLoader = {
    getExtensions: () => ({ extensions: [], errors: [], runtime: createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => "Synthetic package contract, never sent to a provider.",
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources() {}, async reload() {},
  };
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, modelRuntime: runtime,
    model: runtime.getModel("anthropic", "claude-sonnet-4-5"),
    sessionManager: SessionManager.inMemory(root),
    settingsManager: SettingsManager.inMemory({ compaction: { enabled: false } }),
    noTools: "all", resourceLoader,
  });
  try {
    assert.ok(session.agent instanceof Agent, "SDK factory must use the application-pinned core, not a nested copy");
    assert.equal(session.pendingPromptCount, 0);
    await session.waitForPendingPrompts();
    const message: CustomMessage = {
      role: "custom", customType: "synthetic-discard", content: "offline fixture",
      display: false, details: { request_id: "synthetic-request" }, timestamp: 0,
    };
    session.agent.steer(message);
    const removed: CustomMessage[] = [];
    assert.deepEqual(session.clearQueue({
      onDiscardedCustomMessages(messages) { removed.push(...messages); },
    }), { steering: [], followUp: [] });
    assert.equal(removed.length, 1);
    assert.equal(removed[0], message, "receipt must preserve exact removed object identity");
    assert.equal(session.agent.hasQueuedMessages(), false);
  } finally {
    session.dispose();
    rmSync(root, { recursive: true, force: true });
  }
});
