import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
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

const SOURCE_REVISION = "904e4012047428abeaa5f47f4b6fa759069eb987";
const CATALOG_MANIFEST_SHA256 = "e6dd5f432d502e84981ac15c14d9eb0f78bab7baf1aac8dbb805d48b8b3c3655";

function packageMetadata(entry: string): Record<string, unknown> {
  // All three reviewed packages export dist/index.js; read public package metadata,
  // never Pi's user configuration or credential storage.
  return JSON.parse(readFileSync(join(dirname(fileURLToPath(entry)), "..", "package.json"), "utf8"));
}

test("vendored SDK, core and AI retain the sealed source and catalog provenance", () => {
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
  assert.equal(ai.version, "0.85.0", "AI uses upstream semver plus immutable source/catalog provenance");
  // Independently reviewed source-provenance.json bindings, not filename prefixes.
  assert.equal(ai.wayangAiCatalogProvenanceSha256, "e414296b8ce7c62bfd5df7bd9cb4ece7b4bac1fb001fb546fc39dca7c09a7ba6");
  assert.equal(ai.wayangAiCatalogDerivationSha256, "dce9e6edaff5f19874db75c8b9eee5862b7a8408a80dba92abc38167a48bdf47");
  assert.equal(ai.wayangAiPublishedArchiveSha256, "46188bdacb555a07466a0111f3963f20932a16199e4d6cfb8d44a7fe5fc6e342");
  assert.equal(ai.wayangAiApprovedArchiveSha256, "61da692876d01830ebdcc1dc16858b2c7d93b0eab8fce6305e0fc76eba41d3dd");
  assert.equal(ai.wayangAiDeriverSha256, "f3298a7c405415b5dee96ba0bbedd522c8e2d0aa1ab47b0a7c1cc4cb1a8a1a07");

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

test("vendored SDK and core resolve to the same reviewed exact-discard implementation", async () => {
  const sdk = packageMetadata(import.meta.resolve("@earendil-works/pi-coding-agent"));
  const core = packageMetadata(import.meta.resolve("@earendil-works/pi-agent-core"));
  assert.match(String(sdk.wayangSourceRevision), /^[0-9a-f]{40}$/);
  assert.equal(sdk.wayangSourceRevision, SOURCE_REVISION);
  assert.equal(sdk.wayangRequiredCoreSourceRevision, sdk.wayangSourceRevision);
  assert.equal(core.wayangSourceRevision, sdk.wayangSourceRevision);
  assert.equal(sdk.version, `0.85.0-wayang.${String(sdk.wayangSourceRevision).slice(0, 8)}`);
  assert.equal(core.version, "0.85.0", "core uses upstream semver plus immutable source provenance");

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
