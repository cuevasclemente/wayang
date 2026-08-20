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
 * "narwhal-horn/index.ts" was source-reviewed as the identity-neutral,
 * Ruminant-capable Narwhal-Horn Qwen3.8 provider artifact (reviewed SHA-256
 * 67bf45debd9d019da672770164b28832aa9e7a660db6ba16d1d7c0b4eb4c936f at
 * integration time, 2026-08-20). It preserves the explicitly experimental
 * 512K YaRN tier (`qwen3.8-27b`), adds fail-closed shared-gateway routing and
 * session-affinity headers, and retains explicit direct routing for rollback.
 * Keep it in lockstep with the reviewed mypi source and installed artifact.
 */
export const REVIEWED_PROVIDER_EXTENSION_PATHS: readonly string[] = Object.freeze([
  "narwhal-horn/index.ts",
]);
