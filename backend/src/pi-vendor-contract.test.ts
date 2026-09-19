import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { Agent } from "@earendil-works/pi-agent-core";
import { InMemoryCredentialStore, isRetryableAssistantError, type AssistantMessage } from "@earendil-works/pi-ai";
import {
  createAgentSession, createExtensionRuntime, ModelRuntime, SessionManager, SettingsManager,
  type CustomMessage, type ResourceLoader,
} from "@earendil-works/pi-coding-agent";

const SOURCE_REVISION = "4c47f7f24b59981b0b41c6b43bbff68dca74e08c";
const CATALOG_MANIFEST_SHA256 = "e6dd5f432d502e84981ac15c14d9eb0f78bab7baf1aac8dbb805d48b8b3c3655";

function packageMetadata(entry: string): Record<string, unknown> {
  // All three reviewed packages export dist/index.js; read public package metadata,
  // never Pi's user configuration or credential storage.
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(entry)), "..", "package.json"), "utf8"));
}

test("vendored SDK, core and AI retain the packed source and catalog bytes", () => {
  const sdk = packageMetadata(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const core = packageMetadata(import.meta.resolve("@earendil-works/pi-agent-core"));
  const aiEntry = import.meta.resolve("@earendil-works/pi-ai");
  const ai = packageMetadata(aiEntry);
  for (const [name, metadata] of [["pi-coding-agent", sdk], ["pi-agent-core", core], ["pi-ai", ai]] as const) {
    assert.equal(metadata.name, `@earendil-works/${name}`);
    assert.equal(metadata.wayangSourceRevision, SOURCE_REVISION, name);
    assert.equal(metadata.wayangAiCatalogManifestSha256, CATALOG_MANIFEST_SHA256, name);
  }
  assert.equal(sdk.wayangRequiredCoreSourceRevision, SOURCE_REVISION);
  assert.equal(sdk.wayangRequiredAiSourceRevision, SOURCE_REVISION);
  assert.equal(core.wayangRequiredAiSourceRevision, SOURCE_REVISION);
  assert.equal(ai.version, "0.85.1", "AI uses upstream semver plus immutable source/catalog provenance");
  // Wayang deploys on tests pass; the packed triplet binds the catalog bytes it
  // was built from rather than a separately reviewed source-provenance.json.
  assert.equal(ai.wayangAiCatalogProvenanceSha256, undefined);

  // Inspect only shipped public catalog assets, never user model/auth storage.
  const dataRoot = join(dirname(fileURLToPath(aiEntry)), "providers", "data");
  const manifestBytes = readFileSync(join(dataRoot, ".manifest.json"));
  assert.equal(createHash("sha256").update(manifestBytes).digest("hex"), CATALOG_MANIFEST_SHA256);
  const manifest = JSON.parse(manifestBytes.toString("utf8")) as {
    schemaVersion: number; files: Record<string, string>;
  };
  assert.equal(manifest.schemaVersion, 3);
  assert.equal(Object.keys(manifest.files).length, 39);
  assert.deepEqual(readdirSync(dataRoot).sort(), [".manifest.json", ...Object.keys(manifest.files)].sort());
  for (const [name, sha256] of Object.entries(manifest.files)) {
    assert.match(name, /^[a-z0-9-]+\.json$/);
    assert.match(sha256, /^[0-9a-f]{64}$/);
    assert.equal(createHash("sha256").update(readFileSync(join(dataRoot, name))).digest("hex"), sha256, name);
  }
});

test("vendored AI retries the reported upstream transport error text", () => {
  const message = (errorMessage: string): AssistantMessage => ({ stopReason: "error", errorMessage }) as AssistantMessage;
  // The exact mid-stream gateway drop that motivated the classifier fix.
  assert.equal(isRetryableAssistantError(message(
    "Upstream error from Together: Stream error: h2 protocol error: error reading a body from connection")), true);
  assert.equal(isRetryableAssistantError(message("Provider finish_reason: error")), true);
  // Deterministic quota/billing limits must stay non-retryable.
  assert.equal(isRetryableAssistantError(message("429 quota exceeded")), false);
  assert.equal(isRetryableAssistantError(message("insufficient_quota")), false);
  assert.equal(isRetryableAssistantError({ stopReason: "stop" } as AssistantMessage), false);
});

test("vendored SDK and core resolve to the same reviewed exact-discard implementation", async () => {
  const sdk = packageMetadata(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const core = packageMetadata(import.meta.resolve("@earendil-works/pi-agent-core"));
  assert.match(String(sdk.wayangSourceRevision), /^[0-9a-f]{40}$/);
  assert.equal(sdk.wayangSourceRevision, SOURCE_REVISION);
  assert.equal(sdk.wayangRequiredCoreSourceRevision, sdk.wayangSourceRevision);
  assert.equal(core.wayangSourceRevision, sdk.wayangSourceRevision);
  assert.equal(sdk.version, `0.85.1-wayang.${String(sdk.wayangSourceRevision).slice(0, 8)}`);
  assert.equal(core.version, "0.85.1", "core uses upstream semver plus immutable source provenance");

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
