/**
 * Hermetic test-environment preload for the backend suite.
 *
 * `npm test` may run inside a Wayang-spawned pi session whose process
 * environment inherits production runtime configuration from the service
 * `.env` (browser-profile host mode, paused background search indexing,
 * paused session-catalog sync, deployment data dir, and similar runtime
 * flags). Those values legitimately differ in production and must never leak
 * into tests: suites either exercise defaults or set their own explicit
 * values. Delete every inherited WAYANG_* variable (and the command-guard
 * runtime knobs) before any test module loads.
 *
 * Loaded via `--import` before the test files; the node:test runner passes
 * the same execArgv to every per-file child process, so every suite starts
 * from this scrubbed environment.
 */
for (const name of Object.keys(process.env)) {
  if (name.startsWith("WAYANG_")) delete process.env[name];
  else if (name.startsWith("PI_COMMAND_GUARD")) delete process.env[name];
}
