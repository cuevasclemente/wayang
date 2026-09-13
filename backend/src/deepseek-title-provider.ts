import * as path from "node:path";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-completions";
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

const PINNED_TITLE_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Immutable reviewed descriptor for the single automatic-title model.
 *
 * The outgoing request is always built from this object, never from the mutable
 * runtime catalog, so a catalog refresh or models.json provider entry cannot
 * silently redirect bounded conversation prose to a different model, API, or
 * endpoint. OpenRouter zero-data-retention routing is pinned alongside the model.
 */
export const REVIEWED_TITLE_MODEL: Readonly<Model<"openai-completions">> = Object.freeze({
  id: AUTO_TITLE_MODEL_ID,
  name: "DeepSeek V4.1 Flash (OpenRouter ZDR)",
  api: "openai-completions",
  provider: AUTO_TITLE_MODEL_PROVIDER,
  baseUrl: PINNED_TITLE_BASE_URL,
  reasoning: true,
  input: Object.freeze(["text", "image"]) as ("text" | "image")[],
  cost: Object.freeze({ input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 }),
  contextWindow: 1_048_576,
  maxTokens: 384_000,
  // Title requests disable reasoning, so only the level mappings that the harness
  // can send are pinned. `off` maps to OpenRouter's normalized `none` effort.
  thinkingLevelMap: Object.freeze({
    off: "none",
    minimal: "low",
    low: "low",
    medium: "high",
    high: "high",
    xhigh: "max",
    max: "max",
  }) as unknown as Model<"openai-completions">["thinkingLevelMap"],
  compat: Object.freeze({
    supportsDeveloperRole: false,
    thinkingFormat: "openrouter",
    maxTokensField: "max_tokens",
    openRouterRouting: Object.freeze({ zdr: true, allow_fallbacks: true, require_parameters: true }),
  }) as unknown as Model<"openai-completions">["compat"],
});

/**
 * Credential origins that were reviewed for this disclosure path. `stored` is pi
 * auth.json, `environment` is an operator-provided process variable. models.json
 * keys/commands and extension/runtime overrides are deliberately excluded.
 */
const REVIEWED_AUTH_SOURCES: ReadonlySet<string> = new Set(["stored", "environment"]);

let contextPromise: Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> | null = null;

async function titleModelContext(): Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> {
  contextPromise ??= ModelRuntime.create({
    authPath: path.join(getAgentDir(), "auth.json"),
    // Title disclosure uses only the reviewed built-in OpenRouter provider
    // credential. Never compose user-configurable models.json OAuth/provider
    // substitutions here.
    modelsPath: null,
    allowModelNetwork: false,
  }).then((runtime) => ({ runtime, registry: new ModelRegistry(runtime) }));
  return contextPromise;
}

function isReviewedTitleDescriptor(model: Model<any> | undefined): boolean {
  return Boolean(model)
    && model!.id === REVIEWED_TITLE_MODEL.id
    && model!.provider === REVIEWED_TITLE_MODEL.provider
    && model!.api === REVIEWED_TITLE_MODEL.api
    && model!.baseUrl === REVIEWED_TITLE_MODEL.baseUrl
    && model!.headers === undefined;
}

function reviewedTitleModel(registry: ModelRegistry): Readonly<Model<"openai-completions">> | null {
  if (
    registry.getRegisteredProviderConfig(AUTO_TITLE_MODEL_PROVIDER) !== undefined
    || registry.getRegisteredNativeProvider(AUTO_TITLE_MODEL_PROVIDER) !== undefined
  ) return null;
  const authStatus = registry.getProviderAuthStatus(AUTO_TITLE_MODEL_PROVIDER);
  if (!authStatus.configured || authStatus.source === undefined) return null;
  if (!REVIEWED_AUTH_SOURCES.has(authStatus.source)) return null;
  // The bundled catalog does not yet list this model and the runtime catalog is
  // refreshed without network access here. When a catalog entry is nonetheless
  // present, it must still match the reviewed descriptor; drift fails closed.
  const selected = registry.find(AUTO_TITLE_MODEL_PROVIDER, AUTO_TITLE_MODEL_ID);
  if (selected && !isReviewedTitleDescriptor(selected)) return null;
  return REVIEWED_TITLE_MODEL;
}

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function assistantText(event: AssistantMessageEvent): string {
  return event.type === "text_delta" ? event.delta : "";
}

export class DeepSeekTitleProvider implements TitleProvider {
  async prepare(): Promise<PreparedTitleRequest> {
    const { registry } = await titleModelContext();
    const model = reviewedTitleModel(registry);
    if (!model) throw new Error("title_model_unavailable");
    const auth = await registry.getApiKeyAndHeaders(model as Model<"openai-completions">);
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
        // its final disclosure gate and this invocation. Omitting `reasoning` makes
        // the pinned OpenRouter compatibility send `reasoning: { effort: "none" }`,
        // which keeps the whole bounded output budget for the title itself.
        const stream = streamSimple(model as Model<"openai-completions">, context, {
          apiKey,
          signal: controller.signal,
          timeoutMs: 20_000,
          maxRetries: 0,
          maxTokens: 64,
          transport: "sse",
          cacheRetention: "none",
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
