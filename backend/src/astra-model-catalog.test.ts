import { getModel, getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import assert from "node:assert/strict";
import test from "node:test";

test("vendored Pi AI exposes GPT-6 Astra with reviewed OpenAI metadata", () => {
  const model = getModel("openai", "gpt-6-astra");

  assert.deepEqual(
    {
      id: model.id,
      name: model.name,
      api: model.api,
      provider: model.provider,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevels: getSupportedThinkingLevels(model),
      cost: model.cost,
    },
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      api: "openai-responses",
      provider: "openai",
      input: ["text", "image"],
      contextWindow: 272000,
      maxTokens: 128000,
      thinkingLevels: ["low", "medium", "high", "xhigh", "max"],
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: 20,
            output: 75,
            cacheRead: 2,
            cacheWrite: 25,
          },
        ],
      },
    },
  );
});

test("vendored Pi AI exposes the forward-compatible Codex OAuth Astra placeholder", () => {
  const model = getModel("openai-codex", "gpt-6-astra");

  assert.deepEqual(
    {
      id: model.id,
      name: model.name,
      api: model.api,
      provider: model.provider,
      baseUrl: model.baseUrl,
      input: model.input,
      contextWindow: model.contextWindow,
      maxTokens: model.maxTokens,
      thinkingLevels: getSupportedThinkingLevels(model),
      cost: model.cost,
    },
    {
      id: "gpt-6-astra",
      name: "GPT-6 Astra",
      api: "openai-codex-responses",
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      input: ["text", "image"],
      contextWindow: 272000,
      maxTokens: 128000,
      thinkingLevels: ["off", "minimal", "low", "medium", "high", "xhigh", "max"],
      cost: {
        input: 10,
        output: 50,
        cacheRead: 1,
        cacheWrite: 12.5,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: 20,
            output: 75,
            cacheRead: 2,
            cacheWrite: 25,
          },
        ],
      },
    },
  );
});