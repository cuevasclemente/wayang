import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WREN_AGENT_PROFILE_ID } from "./workspace-types.js";

const ACTIVATION_SCHEMA_VERSION = 1;
const MAX_RECORD_BYTES = 4_096;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export interface LegacyAgentActivationRecord {
  schema_version: typeof ACTIVATION_SCHEMA_VERSION;
  deployment_id: string;
  agent_profile_id: typeof WREN_AGENT_PROFILE_ID;
  activation_revision: number;
  activated_at: number;
}

export interface LegacyAgentActivationStatus {
  active: boolean;
  reason:
    | "active"
    | "deployment_id_missing"
    | "deployment_id_unsafe"
    | "deployment_id_malformed"
    | "activation_missing"
    | "activation_unsafe"
    | "activation_malformed"
    | "deployment_mismatch";
  activationRevision: number | null;
}

export interface LegacyAgentActivationPaths {
  configDir: string;
  deploymentIdPath: string;
  activationPath: string;
}

function configHome(): string {
  const configured = process.env.XDG_CONFIG_HOME;
  return configured && path.isAbsolute(configured) ? configured : path.join(os.homedir(), ".config");
}

export function legacyAgentActivationPaths(): LegacyAgentActivationPaths {
  const configDir = path.join(configHome(), "wayang");
  return {
    configDir,
    deploymentIdPath: path.join(configDir, "deployment-id"),
    activationPath: path.join(configDir, "historical-agent-activation.json"),
  };
}

function readOwnerPrivateRegularFile(filePath: string): { ok: true; contents: string } | { ok: false; missing: boolean } {
  try {
    const stat = fs.lstatSync(filePath);
    const uid = process.getuid?.();
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
      || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o7777) !== 0o600
      || stat.size < 1 || stat.size > MAX_RECORD_BYTES
      || fs.realpathSync.native(filePath) !== path.resolve(filePath)) {
      return { ok: false, missing: false };
    }
    return { ok: true, contents: fs.readFileSync(filePath, "utf8") };
  } catch (error) {
    return { ok: false, missing: (error as NodeJS.ErrnoException).code === "ENOENT" };
  }
}

function exactKeys(value: object, keys: readonly string[]): boolean {
  return Object.keys(value).sort().join(",") === [...keys].sort().join(",");
}

export function parseLegacyAgentActivationRecord(raw: string): LegacyAgentActivationRecord | null {
  let value: unknown;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !exactKeys(value, ["schema_version", "deployment_id", "agent_profile_id", "activation_revision", "activated_at"])) {
    return null;
  }
  const record = value as Partial<LegacyAgentActivationRecord>;
  if (record.schema_version !== ACTIVATION_SCHEMA_VERSION
    || typeof record.deployment_id !== "string" || !UUID_PATTERN.test(record.deployment_id)
    || record.agent_profile_id !== WREN_AGENT_PROFILE_ID
    || !Number.isSafeInteger(record.activation_revision) || record.activation_revision! < 1
    || typeof record.activated_at !== "number" || !Number.isFinite(record.activated_at) || record.activated_at < 0) {
    return null;
  }
  return record as LegacyAgentActivationRecord;
}

let cachedStatus: LegacyAgentActivationStatus | null = null;

/**
 * Startup-immutable deployment-local compatibility witness. Store/profile rows
 * remain necessary but are never sufficient. A normal source install creates
 * neither file, and copying store.json cannot activate historical authority.
 */
export function getLegacyAgentActivationStatus(): LegacyAgentActivationStatus {
  if (cachedStatus) return cachedStatus;
  const paths = legacyAgentActivationPaths();
  const deployment = readOwnerPrivateRegularFile(paths.deploymentIdPath);
  if (!deployment.ok) {
    return cachedStatus = {
      active: false,
      reason: deployment.missing ? "deployment_id_missing" : "deployment_id_unsafe",
      activationRevision: null,
    };
  }
  const deploymentId = deployment.contents.trim();
  if (!UUID_PATTERN.test(deploymentId)) {
    return cachedStatus = { active: false, reason: "deployment_id_malformed", activationRevision: null };
  }
  const activation = readOwnerPrivateRegularFile(paths.activationPath);
  if (!activation.ok) {
    return cachedStatus = {
      active: false,
      reason: activation.missing ? "activation_missing" : "activation_unsafe",
      activationRevision: null,
    };
  }
  const record = parseLegacyAgentActivationRecord(activation.contents);
  if (!record) return cachedStatus = { active: false, reason: "activation_malformed", activationRevision: null };
  if (record.deployment_id !== deploymentId) {
    return cachedStatus = { active: false, reason: "deployment_mismatch", activationRevision: null };
  }
  return cachedStatus = { active: true, reason: "active", activationRevision: record.activation_revision };
}

/** Tests only: production activation is immutable for the process lifetime. */
export function resetLegacyAgentActivationCacheForTests(): void {
  cachedStatus = null;
}
