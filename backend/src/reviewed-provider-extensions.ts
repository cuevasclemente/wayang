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
 * this compile-time descriptor. Runtime model contexts separately execute a
 * private copy of the exact verified bytes and retain only provider registration;
 * Project/Profile resource authority is not an input to provider availability.
 */
export const REVIEWED_EXTERNAL_MODELS: readonly ReviewedExternalModelEntry[] = Object.freeze([
  Object.freeze({
    extensionPath: "narwhal-horn/index.ts",
    sha256: "f446d7651a16ea38435f70be63264f40a7a7c17f6a020de382f545ef5c782fa8",
    credentialRelativeToHome: "src/mypi/secure_data/ruminant_key",
    model: Object.freeze({
      provider: "narwhal-horn",
      id: "qwen3.8-flash-next",
      name: "Qwen 3.8 Flash Next (Unsloth IQ4_XS, ROCm/NVMe, native 262K)",
      api: "openai-completions",
      reasoning: true,
      input: Object.freeze(["text", "image"]),
      contextWindow: 262144,
    }),
  }),
]);
