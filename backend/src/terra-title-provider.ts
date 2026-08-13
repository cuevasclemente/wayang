import * as path from "node:path";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { getModel } from "@earendil-works/pi-ai/compat";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import {
  AUTO_TITLE_MODEL_ID,
  AUTO_TITLE_MODEL_PROVIDER,
  AUTO_TITLE_SYSTEM_PROMPT,
} from "./session-title-policy.js";

export interface PreparedTitleRequest {
  /** Invoke synchronously immediately after the caller's final disclosure gate. */
  dispatch(input: string): Promise<string>;
}

export interface TitleProvider {
  prepare(): Promise<PreparedTitleRequest>;
}

const PINNED_TERRA_BASE_URL = "https://chatgpt.com/backend-api";
const PINNED_TERRA_MODEL: Readonly<Model<"openai-codex-responses">> = Object.freeze({
  id: AUTO_TITLE_MODEL_ID,
  name: "GPT-5.6 Terra",
  api: "openai-codex-responses",
  provider: AUTO_TITLE_MODEL_PROVIDER,
  baseUrl: PINNED_TERRA_BASE_URL,
  reasoning: true,
  input: Object.freeze(["text", "image"]) as ("text" | "image")[],
  cost: Object.freeze({
    input: 2,
    output: 12,
    cacheRead: 0.2,
    cacheWrite: 2.5,
    tiers: Object.freeze([Object.freeze({
      inputTokensAbove: 272_000,
      input: 4,
      output: 18,
      cacheRead: 0.4,
      cacheWrite: 5,
    })]) as unknown as Model<"openai-codex-responses">["cost"]["tiers"],
  }),
  contextWindow: 272_000,
  maxTokens: 128_000,
  thinkingLevelMap: Object.freeze({ xhigh: "xhigh", max: "max", minimal: "low" }),
  compat: Object.freeze({ supportsOpenAIGrammarTools: true, supportsToolSearch: true }),
});

let contextPromise: Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> | null = null;

async function titleModelContext(): Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> {
  contextPromise ??= ModelRuntime.create({
    authPath: path.join(getAgentDir(), "auth.json"),
    modelsPath: path.join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
  }).then((runtime) => ({ runtime, registry: new ModelRegistry(runtime) }));
  return contextPromise;
}

function isPinnedTerraDescriptor(model: Model<any> | undefined): boolean {
  return Boolean(model)
    && model!.provider === AUTO_TITLE_MODEL_PROVIDER
    && model!.id === AUTO_TITLE_MODEL_ID
    && model!.api === "openai-codex-responses"
    && model!.baseUrl === PINNED_TERRA_BASE_URL
    && model!.headers === undefined;
}

function reviewedTerraModel(registry: ModelRegistry): Readonly<Model<"openai-codex-responses">> | null {
  const catalog = getModel(AUTO_TITLE_MODEL_PROVIDER, AUTO_TITLE_MODEL_ID);
  const selected = registry.find(AUTO_TITLE_MODEL_PROVIDER, AUTO_TITLE_MODEL_ID);
  if (
    !isPinnedTerraDescriptor(catalog)
    || !isPinnedTerraDescriptor(selected)
    || !registry.isUsingOAuth(PINNED_TERRA_MODEL as Model<"openai-codex-responses">)
    || registry.getRegisteredProviderConfig(AUTO_TITLE_MODEL_PROVIDER) !== undefined
    || registry.getRegisteredNativeProvider(AUTO_TITLE_MODEL_PROVIDER) !== undefined
  ) return null;
  return PINNED_TERRA_MODEL;
}

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function assistantText(event: AssistantMessageEvent): string {
  return event.type === "text_delta" ? event.delta : "";
}

export class TerraTitleProvider implements TitleProvider {
  async prepare(): Promise<PreparedTitleRequest> {
    const { registry } = await titleModelContext();
    const model = reviewedTerraModel(registry);
    if (!model) throw new Error("title_model_unavailable");
    const auth = await registry.getApiKeyAndHeaders(model as Model<"openai-codex-responses">);
    if (
      !auth.ok
      || typeof auth.apiKey !== "string"
      || auth.apiKey.length === 0
      || auth.baseUrl !== undefined
      || hasEntries(auth.headers)
      || hasEntries(auth.env)
    ) throw new Error("title_model_unavailable");
    const apiKey = auth.apiKey;

    return {
      dispatch(input: string): Promise<string> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        timer.unref?.();
        const context: Context = {
          systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: input, timestamp: Date.now() }],
        };
        // The API-specific immutable dispatcher constructs the reviewed provider
        // request in this same synchronous call. It deliberately bypasses the
        // mutable compatibility registry, and the caller performs no await between
        // its final disclosure gate and this invocation.
        const stream = streamSimple(model as Model<"openai-codex-responses">, context, {
          apiKey,
          signal: controller.signal,
          timeoutMs: 20_000,
          maxRetries: 0,
          maxTokens: 64,
          transport: "sse",
          cacheRetention: "none",
          reasoning: "minimal",
        });
        return (async () => {
          let output = "";
          try {
            for await (const event of stream) {
              output += assistantText(event);
              if (event.type === "error") {
                if (controller.signal.aborted) throw new DOMException("Timed out", "AbortError");
                throw new Error("title_provider_failed");
              }
              if (Array.from(output).length > 256) throw new Error("title_output_too_large");
            }
            return output;
          } finally {
            clearTimeout(timer);
          }
        })();
      },
    };
  }
}
