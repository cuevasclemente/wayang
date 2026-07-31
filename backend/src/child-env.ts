const INTERNAL_CAPABILITY_ENV_NAMES = new Set([
  "BW_SESSION",
  "WAYANG_AUTH_PASSWORD_HASH",
  "WAYANG_AUTH_SESSION_SECRET",
  "WAYANG_BROWSER_AGENT_TOKEN",
  "PI_COMMAND_GUARD_IDENTITY_PIN",
]);

const PROTECTED_PIN_ENV_NAME = /^(?:(?:WAYANG|PI_WEB_UI|PI)_(?:[A-Z0-9]+_)*(?:PIN|PASSCODE)(?:_[A-Z0-9]+)*|(?:COMMAND_GUARD|COMMAND_AUTHORIZATION)(?:_[A-Z0-9]+)*_(?:PIN|PASSCODE)(?:_[A-Z0-9]+)*)$/;

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
