/**
 * Executable provider extensions approved for model-list discovery.
 *
 * This registry is intentionally compile-time and empty by default. Never
 * populate it from settings, environment variables, package discovery, or an
 * agent directory: every entry executes JavaScript while serving /api/models
 * and therefore requires source review plus a focused regression test.
 */
export const REVIEWED_PROVIDER_EXTENSION_PATHS: readonly string[] = Object.freeze([]);
