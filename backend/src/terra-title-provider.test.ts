import test from "node:test";
import assert from "node:assert/strict";
import { getModel, registerApiProvider, unregisterApiProviders } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { Context } from "@earendil-works/pi-ai";
import { AUTO_TITLE_MODEL_ID, AUTO_TITLE_MODEL_PROVIDER, AUTO_TITLE_SYSTEM_PROMPT } from "./session-title-policy.js";

test("reviewed Codex adapter sends title requests with store false and no source-session affinity", async () => {
  const model = getModel(AUTO_TITLE_MODEL_PROVIDER, AUTO_TITLE_MODEL_ID);
  assert.ok(model);
  assert.equal(model.api, "openai-codex-responses");
  let payload: any;
  let fetchCalls = 0;
  const context: Context = {
    systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
    messages: [{ role: "user", content: "Synthetic bounded excerpts", timestamp: 1 }],
  };
  const syntheticClaims = Buffer.from(JSON.stringify({
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
  })).toString("base64url");
  const stream = streamSimple(model, context, {
    apiKey: `synthetic.${syntheticClaims}.signature`,
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
  assert.equal(payload?.store, false);
  assert.equal(payload?.stream, true);
  assert.equal(payload?.prompt_cache_key, undefined);
  assert.equal(payload?.instructions, AUTO_TITLE_SYSTEM_PROMPT);
  assert.deepEqual(payload?.tools, undefined);
});

test("reviewed Codex adapter bypasses mutable compatibility provider overrides", async () => {
  const sourceId = "synthetic-title-override";
  let overrideCalls = 0;
  registerApiProvider({
    api: "openai-codex-responses",
    stream: (() => { overrideCalls++; throw new Error("mutable override invoked"); }) as any,
    streamSimple: (() => { overrideCalls++; throw new Error("mutable override invoked"); }) as any,
  }, sourceId);
  try {
    const model = getModel(AUTO_TITLE_MODEL_PROVIDER, AUTO_TITLE_MODEL_ID);
    assert.ok(model);
    const syntheticClaims = Buffer.from(JSON.stringify({
      "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-account" },
    })).toString("base64url");
    const stream = streamSimple(model, {
      systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
      messages: [{ role: "user", content: "Synthetic bounded excerpts", timestamp: 1 }],
    }, {
      apiKey: `synthetic.${syntheticClaims}.signature`,
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
