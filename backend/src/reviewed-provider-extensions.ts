/**
 * Executable provider extensions approved for model-list discovery.
 *
 * This registry is intentionally compile-time and empty by default. Never
 * populate it from settings, environment variables, package discovery, or an
 * agent directory: every entry executes JavaScript while serving /api/models
 * and therefore requires source review plus a focused regression test.
 *
 * Entries are exact file paths relative to the agent directory's extensions
 * root (for example "narwhal-horn/index.ts" resolves to
 * `<agentDir>/extensions/narwhal-horn/index.ts`). Resolution is fail-closed:
 * a missing entry is skipped (the provider is simply not deployed on that
 * host), while a symlinked or non-regular-file entry is refused and reported
 * without loading any code.
 *
 * "narwhal-horn/index.ts" was source-reviewed as the identity-neutral
 * Narwhal-Horn Qwen3.8 provider artifact (installed SHA-256
 * 77ab52f4e8156fcd784c6e097f1433733c102c77e3297727659f22cfecf6393e at
 * integration time, 2026-08-19). It registers only the explicitly
 * experimental 512K YaRN tier (`qwen3.8-27b`); keep it in lockstep with the
 * reviewed source artifact distributed through the pi extension pipeline.
 */
export const REVIEWED_PROVIDER_EXTENSION_PATHS: readonly string[] = Object.freeze([
  "narwhal-horn/index.ts",
]);
