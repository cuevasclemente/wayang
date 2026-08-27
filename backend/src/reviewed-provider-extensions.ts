export interface ReviewedExternalModelEntry {
  extensionPath: string;
  sha256: string;
  credentialRelativeToHome?: string;
  model: {
    provider: string;
    id: string;
    name: string;
    api: string;
    reasoning: boolean;
    input: readonly string[];
    contextWindow: number;
  };
}

/**
 * Static metadata for externally provided models approved for the model picker.
 *
 * Model listing must never execute an installed extension. The backend verifies
 * the exact regular-file hash and credential-file metadata, then projects only
 * this compile-time descriptor. The provider extension is loaded later through
 * the normal Standard-session resource path after Project-Agent authorization.
 */
export const REVIEWED_EXTERNAL_MODELS: readonly ReviewedExternalModelEntry[] = Object.freeze([
  Object.freeze({
    extensionPath: "narwhal-horn/index.ts",
    sha256: "40b5461de830744a488b54f0c8c6632aa92cfdabde17b59b767d5115b2c0f1e5",
    credentialRelativeToHome: "src/mypi/secure_data/ruminant_key",
    model: Object.freeze({
      provider: "narwhal-horn",
      id: "qwen3.8-flash-next",
      name: "Qwen 3.8 Flash Next (Unsloth IQ4_XS, ROCm/NVMe, experimental 512K)",
      api: "openai-completions",
      reasoning: true,
      input: Object.freeze(["text", "image"]),
      contextWindow: 524288,
    }),
  }),
]);
