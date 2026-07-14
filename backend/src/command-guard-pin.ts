import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const COMMAND_GUARD_IDENTITY_PIN_FILENAME = "command-guard-identity-pin";

export interface CommandGuardPinValidationResult {
  ok: boolean;
  pinConfigured: boolean;
  error?: string;
}

export function commandGuardIdentityPinPath(): string {
  const configHome = process.env.XDG_CONFIG_HOME && path.isAbsolute(process.env.XDG_CONFIG_HOME)
    ? process.env.XDG_CONFIG_HOME
    : path.join(os.homedir(), ".config");
  return path.join(configHome, "pi", COMMAND_GUARD_IDENTITY_PIN_FILENAME);
}

function configuredIdentityPin(): string | undefined {
  try {
    const filePath = commandGuardIdentityPinPath();
    if (!fs.existsSync(filePath)) return undefined;
    const pin = fs.readFileSync(filePath, "utf8").trim();
    return /^\d{8}$/.test(pin) ? pin : undefined;
  } catch {
    return undefined;
  }
}

export function validateCommandGuardIdentityPin(pin: unknown): CommandGuardPinValidationResult {
  const configuredPin = configuredIdentityPin();
  if (!configuredPin) {
    return {
      ok: false,
      pinConfigured: false,
      error: `Command guard identity PIN is not configured. Create ${commandGuardIdentityPinPath()} with an 8-digit PIN outside pi sessions and chmod 600 it.`,
    };
  }
  if (typeof pin !== "string" || !/^\d{8}$/.test(pin)) {
    return {
      ok: false,
      pinConfigured: true,
      error: "Command guard identity PIN is required.",
    };
  }
  if (pin !== configuredPin) {
    return {
      ok: false,
      pinConfigured: true,
      error: "Incorrect command guard identity PIN.",
    };
  }
  return { ok: true, pinConfigured: true };
}
