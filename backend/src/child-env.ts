const INTERNAL_CAPABILITY_ENV_NAMES = new Set([
  "BW_SESSION",
  "WAYANG_AUTH_PASSWORD_HASH",
  "WAYANG_AUTH_SESSION_SECRET",
  "WAYANG_BROWSER_AGENT_TOKEN",
  "PI_COMMAND_GUARD_IDENTITY_PIN",
]);

const PROTECTED_PIN_ENV_NAME = /^(?:(?:WAYANG|PI_WEB_UI|PI)_(?:[A-Z0-9]+_)*(?:PIN|PASSCODE)(?:_[A-Z0-9]+)*|(?:COMMAND_GUARD|COMMAND_AUTHORIZATION)(?:_[A-Z0-9]+)*_(?:PIN|PASSCODE)(?:_[A-Z0-9]+)*)$/;

const RESTRICTED_SANDBOX_ENV_NAMES = new Set([
  "COLORTERM",
  "FORCE_COLOR",
  "HOME",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LOGNAME",
  "NO_COLOR",
  "PATH",
  "SHELL",
  "TERM",
  "TMPDIR",
  "TZ",
  "USER",
  // Created by the one-command sandbox helper after its inherited environment
  // has already passed through this allowlist.
  "CLAUDE_CODE_TMPDIR",
]);

const RESTRICTED_SANDBOX_LOCALE_ENV_NAME = /^LC_[A-Z0-9_]+$/;

/** Names only: protected values must never be read while deciding. */
export function isInternalCapabilityEnvName(name: string): boolean {
  if (INTERNAL_CAPABILITY_ENV_NAMES.has(name)) return true;
  if (PROTECTED_PIN_ENV_NAME.test(name)) return true;
  return /^(?:WAYANG|PI_WEB_UI)_[A-Z0-9_]*(?:TOKEN|SECRET|CAPABILITY|UNLOCK_SOCKET)$/.test(name);
}

/** Build a fresh child environment without mutating or exposing the source. */
export function stripInternalCapabilityEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(source)) {
    if (isInternalCapabilityEnvName(name)) continue;
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}

/**
 * Sandboxed bash receives only non-secret process mechanics. Provider keys,
 * OAuth/AWS credentials, proxy credentials, loader hooks, and arbitrary
 * deployment variables stay in the backend. Production host-network mode
 * injects no proxy variables; legacy proxy-mode tests may add their own through
 * Bubblewrap only after this filtering step.
 */
export function buildRestrictedSandboxEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of Object.keys(source)) {
    if (!RESTRICTED_SANDBOX_ENV_NAMES.has(name) && !RESTRICTED_SANDBOX_LOCALE_ENV_NAME.test(name)) continue;
    const value = source[name];
    if (value !== undefined) result[name] = value;
  }
  return result;
}
