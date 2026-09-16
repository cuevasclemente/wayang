import test from "node:test";
import assert from "node:assert/strict";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import type { ModelRegistry } from "@earendil-works/pi-coding-agent";
import { AUTO_TITLE_SYSTEM_PROMPT } from "./session-title-policy.js";
import {
  REVIEWED_CODEX_TITLE_MODEL_ID,
  REVIEWED_CODEX_TITLE_MODEL_PROVIDER,
  REVIEWED_TITLE_MODEL,
  collectReviewedTitleOutput,
  reviewedCodexTitleModel,
} from "./codex-title-provider.js";

interface RegistryStubOptions {
  registeredProviderConfig?: unknown;
  registeredNativeProvider?: unknown;
  authStatus?: { configured: boolean; source?: string };
  usingOAuth?: boolean;
  catalogModel?: Model<any> | undefined;
}

function registryStub(options: RegistryStubOptions = {}): ModelRegistry {
  return {
    getRegisteredProviderConfig: () => options.registeredProviderConfig,
    getRegisteredNativeProvider: () => options.registeredNativeProvider,
    getProviderAuthStatus: () => options.authStatus ?? { configured: true, source: "stored" },
    isUsingOAuth: () => options.usingOAuth ?? true,
    find: () => options.catalogModel,
  } as unknown as ModelRegistry;
}

async function* syntheticStream(...events: AssistantMessageEvent[]): AsyncIterable<AssistantMessageEvent> {
  for (const event of events) yield event;
}

function textDelta(delta: string): AssistantMessageEvent {
  return { type: "text_delta", delta } as unknown as AssistantMessageEvent;
}

function errorEvent(): AssistantMessageEvent {
  return { type: "error", error: "synthetic failure" } as unknown as AssistantMessageEvent;
}

test("reviewed Codex descriptor is pinned and immutable", () => {
  assert.equal(REVIEWED_TITLE_MODEL.provider, "openai-codex");
  assert.equal(REVIEWED_TITLE_MODEL.id, "gpt-5.6-terra");
  assert.equal(REVIEWED_TITLE_MODEL.api, "openai-codex-responses");
  assert.equal(REVIEWED_TITLE_MODEL.baseUrl, "https://chatgpt.com/backend-api");
  assert.equal(REVIEWED_TITLE_MODEL.headers, undefined);
  assert.equal(REVIEWED_CODEX_TITLE_MODEL_PROVIDER, "openai-codex");
  assert.equal(REVIEWED_CODEX_TITLE_MODEL_ID, "gpt-5.6-terra");
  assert.equal(Object.isFrozen(REVIEWED_TITLE_MODEL), true);
  assert.equal(Object.isFrozen(REVIEWED_TITLE_MODEL.compat), true);
});

test("reviewed Codex resolution rejects registered provider and catalog substitutions", () => {
  assert.equal(reviewedCodexTitleModel(registryStub()), REVIEWED_TITLE_MODEL);
  assert.equal(
    reviewedCodexTitleModel(registryStub({ catalogModel: { ...REVIEWED_TITLE_MODEL } })),
    REVIEWED_TITLE_MODEL,
    "a matching catalog entry is accepted",
  );
  assert.equal(
    reviewedCodexTitleModel(registryStub({ registeredProviderConfig: {} })),
    null,
    "a registered provider config for openai-codex fails closed",
  );
  assert.equal(
    reviewedCodexTitleModel(registryStub({ registeredNativeProvider: {} })),
    null,
    "a registered native provider for openai-codex fails closed",
  );
  for (const drift of [
    { ...REVIEWED_TITLE_MODEL, baseUrl: "https://attacker.example/backend-api" },
    { ...REVIEWED_TITLE_MODEL, api: "openai-completions" as const },
    { ...REVIEWED_TITLE_MODEL, provider: "openrouter" },
    { ...REVIEWED_TITLE_MODEL, id: "gpt-5.5-other" },
    { ...REVIEWED_TITLE_MODEL, headers: { authorization: "synthetic" } },
  ]) {
    assert.equal(
      reviewedCodexTitleModel(registryStub({ catalogModel: drift as Model<any> })),
      null,
      JSON.stringify(drift),
    );
  }
});

test("reviewed Codex resolution requires a reviewed OAuth credential source", () => {
  assert.equal(reviewedCodexTitleModel(registryStub({ usingOAuth: false })), null, "non-OAuth credentials fail closed");
  assert.equal(reviewedCodexTitleModel(registryStub({ authStatus: { configured: false } })), null);
  assert.equal(reviewedCodexTitleModel(registryStub({ authStatus: { configured: true } })), null, "an absent source fails closed");
  assert.equal(
    reviewedCodexTitleModel(registryStub({ authStatus: { configured: true, source: "models_json" } })),
    null,
    "models.json keys/commands are not a reviewed source",
  );
  assert.equal(
    reviewedCodexTitleModel(registryStub({ authStatus: { configured: true, source: "extension" } })),
    null,
    "extension/runtime overrides are not a reviewed source",
  );
  assert.equal(
    reviewedCodexTitleModel(registryStub({ authStatus: { configured: true, source: "environment" } })),
    REVIEWED_TITLE_MODEL,
    "operator environment remains a reviewed source",
  );
});

test("reviewed Codex dispatcher maps synthetic stream failures and bounds output", async () => {
  const controller = new AbortController();
  assert.equal(
    await collectReviewedTitleOutput(syntheticStream(textDelta("Terra title")), controller.signal),
    "Terra title",
  );
  assert.equal(
    await collectReviewedTitleOutput(syntheticStream(textDelta("x".repeat(256))), controller.signal),
    "x".repeat(256),
    "exactly 256 code points is allowed",
  );
  await assert.rejects(
    collectReviewedTitleOutput(syntheticStream(textDelta("x".repeat(257))), controller.signal),
    (error: any) => error?.message === "title_output_too_large",
  );
  await assert.rejects(
    collectReviewedTitleOutput(syntheticStream(errorEvent()), new AbortController().signal),
    (error: any) => error?.message === "title_provider_failed",
  );
  const aborted = new AbortController();
  aborted.abort();
  await assert.rejects(
    collectReviewedTitleOutput(syntheticStream(errorEvent()), aborted.signal),
    (error: any) => error?.name === "AbortError",
  );
});

test("reviewed Codex adapter bypasses mutable compatibility provider overrides", async () => {
  const sourceId = "synthetic-codex-title-override";
  let overrideCalls = 0;
  registerApiProvider({
    api: "openai-codex-responses",
    stream: (() => { overrideCalls++; throw new Error("mutable override invoked"); }) as any,
    streamSimple: (() => { overrideCalls++; throw new Error("mutable override invoked"); }) as any,
  }, sourceId);
  try {
    const context: Context = {
      systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Synthetic bounded excerpts", timestamp: 1 }],
    };
    try {
      const stream = streamSimple(REVIEWED_TITLE_MODEL, context, {
        apiKey: "synthetic-codex-token",
        transport: "sse",
        cacheRetention: "none",
        reasoning: "minimal",
        maxTokens: 64,
        async fetch() {
          return new Response("synthetic failure", { status: 503, headers: { "content-type": "text/plain" } });
        },
      });
      for await (const _event of stream) {
        // A synthetic transport failure is expected; the immutable built-in is
        // the only dispatcher that may run.
      }
    } catch {
      // Synthetic transport failures are fine; the override must stay unused.
    }
    assert.equal(overrideCalls, 0);
  } finally {
    unregisterApiProviders(sourceId);
  }
});
