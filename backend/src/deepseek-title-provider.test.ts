import test from "node:test";
import assert from "node:assert/strict";
import { registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
import type { Context } from "@earendil-works/pi-ai";
import { AUTO_TITLE_MODEL_ID, AUTO_TITLE_SYSTEM_PROMPT } from "./session-title-policy.js";
import { REVIEWED_TITLE_MODEL } from "./deepseek-title-provider.js";

test("reviewed OpenRouter adapter sends ZDR-routed title requests with no source-session affinity", async () => {
  const model = REVIEWED_TITLE_MODEL;
  assert.ok(model);
  assert.equal(model.id, AUTO_TITLE_MODEL_ID);
  assert.equal(model.api, "openai-completions");
  let payload: any;
  let fetchCalls = 0;
  const context: Context = {
    systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "Synthetic bounded excerpts", timestamp: 1 }],
  };
  const stream = streamSimple(model, context, {
    apiKey: "synthetic-openrouter-key",
    maxTokens: 64,
    transport: "sse",
    cacheRetention: "none",
    onPayload(value) { payload = value; },
    async fetch() {
      fetchCalls++;
      return new Response("synthetic failure", { status: 503, headers: { "content-type": "text/plain" } });
    },
  });
  for await (const _event of stream) {
    // A synthetic HTTP failure is expected; payload inspection is the contract.
  }
  assert.equal(fetchCalls, 1);
  assert.equal(payload?.model, AUTO_TITLE_MODEL_ID);
  assert.equal(payload?.stream, true);
  assert.equal(payload?.store, false);
  assert.deepEqual(payload?.provider, { zdr: true, allow_fallbacks: true, require_parameters: true });
  assert.deepEqual(payload?.reasoning, { effort: "none" });
  assert.equal(payload?.max_tokens, 64);
  assert.equal(payload?.max_completion_tokens, undefined);
  assert.deepEqual(payload?.messages, [
    { role: "system", content: AUTO_TITLE_SYSTEM_PROMPT },
    { role: "user", content: "Synthetic bounded excerpts" },
  ]);
  assert.deepEqual(payload?.tools, undefined);
});

test("reviewed OpenRouter adapter bypasses mutable compatibility provider overrides", async () => {
  const sourceId = "synthetic-title-override";
  let overrideCalls = 0;
  registerApiProvider({
    api: "openai-completions",
    stream: (() => { overrideCalls++; throw new Error("mutable override invoked"); }) as any,
    streamSimple: (() => { overrideCalls++; throw new Error("mutable override invoked"); }) as any,
  }, sourceId);
  try {
    const model = REVIEWED_TITLE_MODEL;
    const stream = streamSimple(model, {
      systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Synthetic bounded excerpts", timestamp: 1 }],
    }, {
      apiKey: "synthetic-openrouter-key",
      transport: "sse",
      cacheRetention: "none",
      async fetch() {
        return new Response("synthetic failure", { status: 503, headers: { "content-type": "text/plain" } });
      },
    });
    for await (const _event of stream) {
      // The immutable built-in reaches only the synthetic fetch above.
    }
    assert.equal(overrideCalls, 0);
  } finally {
    unregisterApiProviders(sourceId);
  }
});
