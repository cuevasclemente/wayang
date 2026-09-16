import test from "node:test";
import assert from "node:assert/strict";
import { DeepSeekTitleProvider } from "./deepseek-title-provider.js";
import { CodexTitleProvider } from "./codex-title-provider.js";
import { AUTO_TITLE_PROVIDER_ENV, createTitleProvider } from "./title-provider-select.js";

async function withProvider(value: string | undefined, run: () => void | Promise<void>): Promise<void> {
  const previous = process.env[AUTO_TITLE_PROVIDER_ENV];
  if (value === undefined) delete process.env[AUTO_TITLE_PROVIDER_ENV];
  else process.env[AUTO_TITLE_PROVIDER_ENV] = value;
  try {
    await run();
  } finally {
    if (previous === undefined) delete process.env[AUTO_TITLE_PROVIDER_ENV];
    else process.env[AUTO_TITLE_PROVIDER_ENV] = previous;
  }
}

test("unset or empty selector keeps the reviewed OpenRouter DeepSeek default", async () => {
  for (const value of [undefined, ""] as const) {
    await withProvider(value, () => {
      assert.ok(createTitleProvider() instanceof DeepSeekTitleProvider, JSON.stringify(value));
    });
  }
});

test("reviewed selector values map to exactly one of the two descriptors", async () => {
  for (const value of ["openrouter", "deepseek"] as const) {
    await withProvider(value, () => {
      assert.ok(createTitleProvider() instanceof DeepSeekTitleProvider, value);
    });
  }
  for (const value of ["codex", "terra"] as const) {
    await withProvider(value, () => {
      assert.ok(createTitleProvider() instanceof CodexTitleProvider, value);
    });
  }
});

test("any other selector value fails closed without substituting a provider", async () => {
  for (const value of [
    "unknown",
    "openai-codex",
    "gpt-5.6-terra",
    "OPENROUTER",
    "Codex",
    "codex ",
    "deepseek-v4.1-flash",
  ]) {
    await withProvider(value, async () => {
      const provider = createTitleProvider();
      assert.ok(!(provider instanceof DeepSeekTitleProvider), `${value} must not select DeepSeek`);
      assert.ok(!(provider instanceof CodexTitleProvider), `${value} must not select Codex`);
      await assert.rejects(
        provider.prepare(),
        (error: any) => error?.message === "title_model_unavailable",
        `${value} must fail closed with title_model_unavailable`,
      );
    });
  }
});
