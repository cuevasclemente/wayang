import * as path from "node:path";
import {
  getAgentDir,
  ModelRegistry,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { getModel, streamSimple } from "@earendil-works/pi-ai/compat";
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

let contextPromise: Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> | null = null;

async function titleModelContext(): Promise<{ runtime: ModelRuntime; registry: ModelRegistry }> {
  contextPromise ??= ModelRuntime.create({
    authPath: path.join(getAgentDir(), "auth.json"),
    modelsPath: path.join(getAgentDir(), "models.json"),
    allowModelNetwork: false,
  }).then((runtime) => ({ runtime, registry: new ModelRegistry(runtime) }));
  return contextPromise;
}

function reviewedTerraModel(registry: ModelRegistry): Model<"openai-codex-responses"> | null {
  const builtIn = getModel(AUTO_TITLE_MODEL_PROVIDER, AUTO_TITLE_MODEL_ID);
  const selected = registry.find(AUTO_TITLE_MODEL_PROVIDER, AUTO_TITLE_MODEL_ID);
  if (!builtIn || !selected) return null;
  if (
    builtIn.provider !== AUTO_TITLE_MODEL_PROVIDER
    || builtIn.id !== AUTO_TITLE_MODEL_ID
    || builtIn.api !== "openai-codex-responses"
    || selected.provider !== builtIn.provider
    || selected.id !== builtIn.id
    || selected.api !== builtIn.api
    || selected.baseUrl !== builtIn.baseUrl
    || registry.getRegisteredProviderConfig(AUTO_TITLE_MODEL_PROVIDER) !== undefined
  ) return null;
  return builtIn as Model<"openai-codex-responses">;
}

function assistantText(event: AssistantMessageEvent): string {
  return event.type === "text_delta" ? event.delta : "";
}

export class TerraTitleProvider implements TitleProvider {
  async prepare(): Promise<PreparedTitleRequest> {
    const { registry } = await titleModelContext();
    const model = reviewedTerraModel(registry);
    if (!model) throw new Error("title_model_unavailable");
    const auth = await registry.getApiKeyAndHeaders(model);
    if (!auth.ok || (auth.baseUrl && auth.baseUrl !== model.baseUrl)) throw new Error("title_model_unavailable");
    const requestAuth = { apiKey: auth.apiKey, headers: auth.headers, env: auth.env };

    return {
      dispatch(input: string): Promise<string> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 20_000);
        timer.unref?.();
        const context: Context = {
          systemPrompt: AUTO_TITLE_SYSTEM_PROMPT,
          messages: [{ role: "user", content: input, timestamp: Date.now() }],
        };
        // streamSimple constructs the reviewed provider request in this same
        // synchronous call. The caller deliberately performs no await between
        // its final disclosure gate and this invocation.
        const stream = streamSimple(model, context, {
          apiKey: requestAuth.apiKey,
          headers: requestAuth.headers,
          env: requestAuth.env,
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
