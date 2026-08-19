import { randomUUID } from "node:crypto";
import {
  closeSync,
  chmodSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";

const PROFILE_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const MAX_BYTES = 4_096;

function effectiveConfigHome(explicit) {
  if (explicit !== undefined) {
    if (!isAbsolute(explicit)) throw new Error("configHome must be absolute");
    return resolve(explicit);
  }
  const configured = process.env.XDG_CONFIG_HOME;
  return configured && isAbsolute(configured) ? resolve(configured) : join(homedir(), ".config");
}

export function historicalAgentActivationPaths(options = {}) {
  const configHome = effectiveConfigHome(options.configHome);
  const wayangConfigDir = join(configHome, "wayang");
  return {
    pinPath: join(configHome, "pi", "command-guard-identity-pin"),
    wayangConfigDir,
    deploymentIdPath: join(wayangConfigDir, "deployment-id"),
    activationPath: join(wayangConfigDir, "historical-agent-activation.json"),
  };
}

function readPrivate(filePath, label) {
  let stat;
  try { stat = lstatSync(filePath); } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`${label} metadata is unavailable`);
  }
  const uid = process.getuid?.();
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1
    || (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o7777) !== 0o600
    || stat.size < 1 || stat.size > MAX_BYTES
    || realpathSync.native(filePath) !== resolve(filePath)) {
    throw new Error(`${label} must be one owner-private mode-0600 regular file`);
  }
  return readFileSync(filePath, "utf8");
}

function writePrivateCreateOrReplace(filePath, contents, replace) {
  mkdirSync(dirname(filePath), { recursive: true, mode: 0o700 });
  chmodSync(dirname(filePath), 0o700);
  if (!replace) {
    const fd = openSync(filePath, "wx", 0o600);
    try {
      writeFileSync(fd, contents, { encoding: "utf8" });
      fsyncSync(fd);
      chmodSync(filePath, 0o600);
      return;
    } finally {
      closeSync(fd);
    }
  }
  const temporary = `${filePath}.${process.pid}.${randomUUID()}.tmp`;
  const fd = openSync(temporary, "wx", 0o600);
  try {
    writeFileSync(fd, contents, { encoding: "utf8" });
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  chmodSync(temporary, 0o600);
  renameSync(temporary, filePath);
  chmodSync(filePath, 0o600);
}

function parseActivation(raw) {
  let value;
  try { value = JSON.parse(raw); } catch { return null; }
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join(",") !== ["schema_version", "deployment_id", "agent_profile_id", "activation_revision", "activated_at"].sort().join(",")
    || value.schema_version !== 1 || typeof value.deployment_id !== "string" || !UUID_PATTERN.test(value.deployment_id)
    || value.agent_profile_id !== PROFILE_ID || !Number.isSafeInteger(value.activation_revision) || value.activation_revision < 1
    || typeof value.activated_at !== "number" || !Number.isFinite(value.activated_at) || value.activated_at < 0) return null;
  return value;
}

export function historicalAgentActivationStatus(options = {}) {
  const paths = historicalAgentActivationPaths(options);
  let deployment;
  try { deployment = readPrivate(paths.deploymentIdPath, "Wayang deployment ID"); }
  catch (error) { return { active: false, reason: error.message, paths }; }
  if (deployment === null) return { active: false, reason: "Wayang deployment ID is absent", paths };
  const deploymentId = deployment.trim();
  if (!UUID_PATTERN.test(deploymentId)) return { active: false, reason: "Wayang deployment ID is malformed", paths };
  let activation;
  try { activation = readPrivate(paths.activationPath, "Historical agent activation"); }
  catch (error) { return { active: false, reason: error.message, paths }; }
  if (activation === null) return { active: false, reason: "Historical agent activation is absent", paths };
  const record = parseActivation(activation);
  if (!record) return { active: false, reason: "Historical agent activation is malformed", paths };
  if (record.deployment_id !== deploymentId) return { active: false, reason: "Historical agent activation belongs to another deployment", paths };
  return { active: true, reason: "active", deploymentId, activationRevision: record.activation_revision, paths };
}

export function provisionHistoricalAgentActivation(options = {}) {
  const pin = options.pin;
  if (typeof pin !== "string" || !/^\d{8}$/u.test(pin)) throw new Error("An 8-digit identity PIN is required");
  const paths = historicalAgentActivationPaths(options);
  const configuredPin = readPrivate(paths.pinPath, "Command-guard identity PIN");
  if (configuredPin === null || !/^\d{8}\s*$/u.test(configuredPin) || configuredPin.trim() !== pin) {
    throw new Error("Identity PIN verification failed");
  }

  let deployment = readPrivate(paths.deploymentIdPath, "Wayang deployment ID");
  let deploymentId;
  let deploymentCreated = false;
  if (deployment === null) {
    deploymentId = options.deploymentId ?? randomUUID();
    if (!UUID_PATTERN.test(deploymentId)) throw new Error("Generated deployment ID is invalid");
    writePrivateCreateOrReplace(paths.deploymentIdPath, `${deploymentId}\n`, false);
    deploymentCreated = true;
  } else {
    deploymentId = deployment.trim();
    if (!UUID_PATTERN.test(deploymentId)) throw new Error("Wayang deployment ID is malformed");
  }

  const existing = readPrivate(paths.activationPath, "Historical agent activation");
  if (existing !== null) {
    const record = parseActivation(existing);
    if (!record || record.deployment_id !== deploymentId) {
      throw new Error("Existing historical agent activation is unsafe or belongs to another deployment");
    }
    return { created: false, deploymentCreated, deploymentId, activationRevision: record.activation_revision, paths };
  }

  const activatedAt = options.now ?? Date.now();
  if (typeof activatedAt !== "number" || !Number.isFinite(activatedAt) || activatedAt < 0) throw new Error("Invalid activation time");
  const record = {
    schema_version: 1,
    deployment_id: deploymentId,
    agent_profile_id: PROFILE_ID,
    activation_revision: 1,
    activated_at: activatedAt,
  };
  writePrivateCreateOrReplace(paths.activationPath, `${JSON.stringify(record)}\n`, false);
  return { created: true, deploymentCreated, deploymentId, activationRevision: 1, paths };
}
