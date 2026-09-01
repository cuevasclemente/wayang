import type { Api, Model } from "@earendil-works/pi-ai";

export interface CuratedTogetherModelSpec {
  reasoning: boolean;
  input: Array<"text" | "image">;
  maxTokens: number;
  thinkingLevelMap?: Model<Api>["thinkingLevelMap"];
}

/**
 * Current production/serverless Together chat catalog.
 *
 * The authenticated `/v1/models` endpoint also returns dozens of legacy priced
 * endpoints. Keep Wayang's picker focused on current general, coding, reasoning,
 * and multimodal models; the underlying Together credential remains usable by
 * other clients for models outside this list.
 */
export const CURATED_TOGETHER_MODELS: Readonly<Record<string, CuratedTogetherModelSpec>> = Object.freeze({
  "zai-org/GLM-5.3-Flash": { reasoning: true, input: ["text", "image"], maxTokens: 131072, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } },
  "zai-org/GLM-5.3": { reasoning: true, input: ["text"], maxTokens: 262144, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } },
  "zai-org/GLM-5.2": { reasoning: true, input: ["text"], maxTokens: 164000 },
  "Qwen/Qwen3.8-2.4T-A95B": { reasoning: true, input: ["text"], maxTokens: 131072, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } },
  "Qwen/Qwen3.7-Max": { reasoning: false, input: ["text"], maxTokens: 131072 },
  "Qwen/Qwen3.7-Plus": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "Qwen/Qwen3.6-Plus": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "Qwen/Qwen3.5-397B-A17B": { reasoning: true, input: ["text", "image"], maxTokens: 131072 },
  "Qwen/Qwen3.5-9B": { reasoning: true, input: ["text", "image"], maxTokens: 65536 },
  "moonshotai/Kimi-K3": { reasoning: true, input: ["text", "image"], maxTokens: 131072 },
  "moonshotai/Kimi-K2.7-Code": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "deepseek-ai/DeepSeek-V4-Pro": { reasoning: true, input: ["text"], maxTokens: 384000 },
  "deepseek-ai/DeepSeek-V4-Pro-0813": { reasoning: true, input: ["text"], maxTokens: 384000 },
  "deepseek-ai/DeepSeek-V4-Flash-0731": { reasoning: true, input: ["text"], maxTokens: 384000 },
  "MiniMaxAI/MiniMax-M3": { reasoning: true, input: ["text", "image"], maxTokens: 250000 },
  "MiniMaxAI/MiniMax-M2.7": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "thinkingmachines/Inkling": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "thinkingmachines/Inkling-Small": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "nvidia/nemotron-3-ultra-550b-a55b": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "meta-models/Muse-Glimmer-30B": { reasoning: false, input: ["text"], maxTokens: 131072 },
  "google/gemma-4-31B-it": { reasoning: true, input: ["text", "image"], maxTokens: 131072 },
  "pearl-ai/gemma-4-31b-it": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "openai/gpt-oss-120b": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "openai/gpt-oss-20b": { reasoning: true, input: ["text"], maxTokens: 131072 },
  "meta-llama/Llama-3.3-70B-Instruct-Turbo": { reasoning: false, input: ["text"], maxTokens: 131072 },
});

export function isCuratedTogetherModel(modelId: string): boolean {
  return Object.hasOwn(CURATED_TOGETHER_MODELS, modelId);
}

export function curateTogetherModelRecords(records: unknown[]): Record<string, unknown>[] {
  return records.filter((entry): entry is Record<string, unknown> => (
    !!entry
    && typeof entry === "object"
    && typeof (entry as Record<string, unknown>).id === "string"
    && isCuratedTogetherModel(String((entry as Record<string, unknown>).id))
    && ((entry as Record<string, unknown>).type === "chat" || (entry as Record<string, unknown>).type === "code")
  ));
}
