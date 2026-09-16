import * as path from "node:path";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { streamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import type { AssistantMessageEvent, Context, Model } from "@earendil-works/pi-ai";
import { AUTO_TITLE_SYSTEM_PROMPT } from "./session-title-policy.js";

export interface PreparedTitleRequest {
  /** Invoke synchronously immediately after the caller's final disclosure gate. */
  dispatch(input: string): Promise<string>;
}

export interface TitleProvider {
  prepare(): Promise<PreparedTitleRequest>;
}

export const REVIEWED_CODEX_TITLE_MODEL_PROVIDER = "openai-codex";
export const REVIEWED_CODEX_TITLE_MODEL_ID = "gpt-5.6-terra";
const PINNED_TITLE_BASE_URL = "https://chatgpt.com/backend-api";

/**
 * Immutable reviewed descriptor for the opt-in Codex/Terra automatic-title
 * model.
 *
 * The outgoing request is always built from this object, never from the mutable
 * runtime catalog, so a catalog refresh or models.json provider entry cannot
 * silently redirect bounded conversation prose to a different model, API, or
 * endpoint. Codex OAuth is pinned alongside the model: only the built-in
 * `openai-codex` OAuth credential is accepted, and no provider-level baseUrl,
 * header, or env override is allowed to change the disclosure target.
 */
export const REVIEWED_TITLE_MODEL: Readonly<Model<"openai-codex-responses">> = Object.freeze({
  id: REVIEWED_CODEX_TITLE_MODEL_ID,
  name: "GPT-5.6 Terra",
  api: "openai-codex-responses",
  provider: REVIEWED_CODEX_TITLE_MODEL_PROVIDER,
  baseUrl: PINNED_TITLE_BASE_URL,
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
    // Title disclosure uses only the reviewed built-in Codex provider
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

/**
 * Resolve the reviewed Codex descriptor only from reviewed built-in state.
 *
 * Exported for deterministic tests: an unreviewed registered provider,
 * registered native provider, unreviewed credential source, non-OAuth credential,
 * or a drifted runtime catalog entry all fail closed. This never builds a
 * descriptor from models.json or extension/runtime overrides.
 */
export function reviewedCodexTitleModel(registry: ModelRegistry): Readonly<Model<"openai-codex-responses">> | null {
  if (
    registry.getRegisteredProviderConfig(REVIEWED_CODEX_TITLE_MODEL_PROVIDER) !== undefined
    || registry.getRegisteredNativeProvider(REVIEWED_CODEX_TITLE_MODEL_PROVIDER) !== undefined
  ) return null;
  const authStatus = registry.getProviderAuthStatus(REVIEWED_CODEX_TITLE_MODEL_PROVIDER);
  if (!authStatus.configured || authStatus.source === undefined) return null;
  if (!REVIEWED_AUTH_SOURCES.has(authStatus.source)) return null;
  // Codex title disclosure is OAuth-only: an API-key/plain credential for the
  // same provider id must not become the disclosure target.
  if (!registry.isUsingOAuth(REVIEWED_TITLE_MODEL as Model<"openai-codex-responses">)) return null;
  // When a catalog entry is nonetheless present, it must still match the
  // reviewed descriptor; drift fails closed.
  const selected = registry.find(REVIEWED_CODEX_TITLE_MODEL_PROVIDER, REVIEWED_CODEX_TITLE_MODEL_ID);
  if (selected && !isReviewedTitleDescriptor(selected)) return null;
  return REVIEWED_TITLE_MODEL;
}

function hasEntries(value: object | undefined): boolean {
  return value !== undefined && Object.keys(value).length > 0;
}

function assistantText(event: AssistantMessageEvent): string {
  return event.type === "text_delta" ? event.delta : "";
}

/**
 * Map one reviewed provider stream to a bounded title string.
 *
 * Error semantics are identical to the DeepSeek provider: an `error` event with
 * an aborted controller is a timeout (`AbortError`), any other `error` event is
 * `title_provider_failed`, and more than 256 accumulated code points is
 * `title_output_too_large`. Exported so the mapping can be exercised with a
 * synthetic stream without contacting the provider.
 */
export async function collectReviewedTitleOutput(
  stream: AsyncIterable<AssistantMessageEvent>,
  signal: AbortSignal,
): Promise<string> {
  let output = "";
  for await (const event of stream) {
    output += assistantText(event);
    if (event.type === "error") {
      if (signal.aborted) throw new DOMException("Timed out", "AbortError");
      throw new Error("title_provider_failed");
    }
    if (Array.from(output).length > 256) throw new Error("title_output_too_large");
  }
  return output;
}

export class CodexTitleProvider implements TitleProvider {
  async prepare(): Promise<PreparedTitleRequest> {
    const { registry } = await titleModelContext();
    const model = reviewedCodexTitleModel(registry);
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
          try {
            return await collectReviewedTitleOutput(stream, controller.signal);
          } finally {
            clearTimeout(timer);
          }
        })();
      },
    };
  }
}
