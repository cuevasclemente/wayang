import { randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  fchmodSync,
  fsyncSync,
  fstatSync,
  linkSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, normalize, resolve } from "node:path";

export const CAPABILITY_APPROVAL_STATE_VERSION = 1;
export const CAPABILITY_APPROVAL_STATE_RELATIVE_PATH = join(
  "workspace-capability-approval",
  "pin-attempt-state.json",
);
const INITIAL_STATE = Object.freeze({
  version: CAPABILITY_APPROVAL_STATE_VERSION,
  attemptCount: 0,
  lastAttemptAtMs: 0,
  reservation: null,
});
const MAX_STATE_BYTES = 16 * 1024;
const MAX_PIN_BYTES = 1024;

function currentUid(getUid = process.getuid) {
  if (typeof getUid !== "function") return null;
  const uid = getUid();
  return Number.isInteger(uid) && uid >= 0 ? uid : null;
}

export function capabilityApprovalPaths({ env = process.env, home = homedir() } = {}) {
  const configuredDataDir = env.WAYANG_DATA_DIR || env.PI_WEB_UI_DATA_DIR;
  if (configuredDataDir && !isAbsolute(configuredDataDir)) {
    throw new Error("WAYANG_DATA_DIR must be an absolute path for owner PIN confirmation setup");
  }
  const dataDir = resolve(configuredDataDir || join(home, ".wayang"));
  const configuredConfigHome = env.XDG_CONFIG_HOME;
  const configHome = configuredConfigHome && isAbsolute(configuredConfigHome)
    ? configuredConfigHome
    : join(home, ".config");
  return {
    dataDir,
    pinPath: join(configHome, "pi", "command-guard-identity-pin"),
    stateDirectory: join(dataDir, "workspace-capability-approval"),
    statePath: join(dataDir, CAPABILITY_APPROVAL_STATE_RELATIVE_PATH),
  };
}

function inspectCanonicalDirectory(directoryPath, { requireOwner = false, requirePrivate = false, getUid = process.getuid } = {}) {
  const uid = currentUid(getUid);
  if (uid === null) return { ok: false, reason: "the current numeric uid is unavailable" };
  const expected = resolve(directoryPath);
  if (!isAbsolute(directoryPath) || normalize(directoryPath) !== directoryPath) {
    return { ok: false, reason: "the path is not absolute and normalized" };
  }
  try {
    const metadata = lstatSync(expected);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return { ok: false, reason: "the path is not a no-follow directory" };
    if (realpathSync.native(expected) !== expected) return { ok: false, reason: "the path has a symlinked or non-canonical component" };
    if ((requireOwner || requirePrivate) && metadata.uid !== uid) return { ok: false, reason: "the directory is not owned by the current uid" };
    if (requirePrivate && (metadata.mode & 0o7777) !== 0o700) return { ok: false, reason: "the directory mode is not 0700" };
    return { ok: true, metadata };
  } catch {
    return { ok: false, reason: "the directory is missing or unreadable" };
  }
}

export function inspectOwnerOnlyRegularFileMetadata(
  filePath,
  { minSize = 1, maxSize = Number.MAX_SAFE_INTEGER, getUid = process.getuid } = {},
) {
  const uid = currentUid(getUid);
  if (uid === null) return { ok: false, reason: "the current numeric uid is unavailable" };
  if (!isAbsolute(filePath) || normalize(filePath) !== filePath) {
    return { ok: false, reason: "the path is not absolute and normalized" };
  }
  const parent = inspectCanonicalDirectory(dirname(filePath), { requirePrivate: true, getUid });
  if (!parent.ok) return { ok: false, reason: `the parent is unsafe: ${parent.reason}` };
  try {
    const metadata = lstatSync(filePath);
    if (!metadata.isFile() || metadata.isSymbolicLink()) return { ok: false, reason: "the path is not a no-follow regular file" };
    if (metadata.nlink !== 1) return { ok: false, reason: "the file has more than one hard link" };
    if (metadata.uid !== uid) return { ok: false, reason: "the file is not owned by the current uid" };
    if ((metadata.mode & 0o7777) !== 0o600) return { ok: false, reason: "the file mode is not 0600" };
    if (metadata.size < minSize || metadata.size > maxSize) return { ok: false, reason: "the file size is outside the accepted bound" };
    return { ok: true, metadata };
  } catch {
    return { ok: false, reason: "the file is missing or unreadable" };
  }
}

function validReservation(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "expiresAt,operationDigest,realm,requestId,reservationId"
    && typeof value.realm === "string" && value.realm.length > 0 && value.realm.length <= 256
    && typeof value.reservationId === "string" && value.reservationId.length > 0 && value.reservationId.length <= 256
    && typeof value.requestId === "string" && value.requestId.length > 0 && value.requestId.length <= 256
    && typeof value.operationDigest === "string" && /^[a-f0-9]{64}$/u.test(value.operationDigest)
    && Number.isSafeInteger(value.expiresAt) && value.expiresAt > 0;
}

export function isValidCapabilityApprovalState(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).sort().join(",") === "attemptCount,lastAttemptAtMs,reservation,version"
    && value.version === CAPABILITY_APPROVAL_STATE_VERSION
    && Number.isSafeInteger(value.attemptCount) && value.attemptCount >= 0
    && Number.isSafeInteger(value.lastAttemptAtMs) && value.lastAttemptAtMs >= 0
    && (value.reservation === null || validReservation(value.reservation));
}

function readExistingStateNoFollow(statePath) {
  const metadata = inspectOwnerOnlyRegularFileMetadata(statePath, { minSize: 2, maxSize: MAX_STATE_BYTES });
  if (!metadata.ok) throw new Error(`Existing owner PIN confirmation cooldown state is unsafe: ${metadata.reason}`);
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("This platform cannot perform no-follow owner PIN confirmation setup");
  let descriptor = null;
  try {
    descriptor = openSync(statePath, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = fstatSync(descriptor);
    if (opened.dev !== metadata.metadata.dev || opened.ino !== metadata.metadata.ino) {
      throw new Error("Existing owner PIN confirmation cooldown state changed during validation");
    }
    const state = JSON.parse(readFileSync(descriptor, "utf8"));
    if (!isValidCapabilityApprovalState(state)) throw new Error("Existing owner PIN confirmation cooldown state has an invalid schema");
    return state;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Existing owner PIN confirmation")) throw error;
    throw new Error("Existing owner PIN confirmation cooldown state is unreadable or malformed");
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function ensurePrivateDirectory(directoryPath) {
  const existing = inspectCanonicalDirectory(directoryPath, { requirePrivate: true });
  if (existing.ok) return false;
  try {
    lstatSync(directoryPath);
    throw new Error(`Refusing unsafe owner PIN confirmation directory: ${existing.reason}`);
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Refusing")) throw error;
  }

  const missing = [];
  let candidate = directoryPath;
  while (true) {
    try {
      lstatSync(candidate);
      break;
    } catch {
      missing.push(candidate);
      const parent = dirname(candidate);
      if (parent === candidate) throw new Error("No existing parent is available for owner PIN confirmation state");
      candidate = parent;
    }
  }
  const parent = inspectCanonicalDirectory(candidate, { requireOwner: true });
  if (!parent.ok) throw new Error(`Refusing unsafe owner PIN confirmation parent: ${parent.reason}`);

  for (const component of missing.reverse()) {
    try {
      mkdirSync(component, { mode: 0o700 });
    } catch {
      const raced = inspectCanonicalDirectory(component, { requirePrivate: true });
      if (!raced.ok) throw new Error("Could not create an owner-only owner PIN confirmation directory without replacing an existing path");
    }
    const created = inspectCanonicalDirectory(component, { requirePrivate: true });
    if (!created.ok) throw new Error(`Created owner PIN confirmation directory is unsafe: ${created.reason}`);
  }
  return true;
}

function writeInitialStateNoReplace(statePath) {
  if (typeof constants.O_NOFOLLOW !== "number") throw new Error("This platform cannot perform no-follow owner PIN confirmation setup");
  const parent = dirname(statePath);
  const temporary = join(parent, `.pin-attempt-setup-${process.pid}-${randomBytes(8).toString("hex")}.tmp`);
  let descriptor = null;
  try {
    descriptor = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    writeFileSync(descriptor, `${JSON.stringify(INITIAL_STATE)}\n`, "utf8");
    fchmodSync(descriptor, 0o600);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    // link(2) publishes the complete file atomically and refuses an existing
    // destination; unlike rename, it cannot replace live cooldown authority.
    linkSync(temporary, statePath);
    unlinkSync(temporary);
    try {
      const directoryDescriptor = openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      try { fsyncSync(directoryDescriptor); } finally { closeSync(directoryDescriptor); }
    } catch { /* best-effort directory durability on portable filesystems */ }
  } finally {
    if (descriptor !== null) closeSync(descriptor);
    try { unlinkSync(temporary); } catch { /* already published or cleanup best effort */ }
  }
}

export function diagnoseCapabilityApprovalMetadata(options = {}) {
  let paths;
  try {
    paths = capabilityApprovalPaths(options);
  } catch (error) {
    return {
      pin: { ok: false, reason: error.message },
      state: { ok: false, reason: error.message },
    };
  }
  return {
    pin: inspectOwnerOnlyRegularFileMetadata(paths.pinPath, { minSize: 1, maxSize: MAX_PIN_BYTES }),
    state: inspectOwnerOnlyRegularFileMetadata(paths.statePath, { minSize: 2, maxSize: MAX_STATE_BYTES }),
  };
}

/**
 * Provision only durable PIN-attempt cooldown state. The existing identity PIN
 * is checked by metadata and is never opened, read, copied, or replaced.
 */
export function provisionCapabilityApprovalState(options = {}) {
  const paths = capabilityApprovalPaths(options);
  const pin = inspectOwnerOnlyRegularFileMetadata(paths.pinPath, { minSize: 1, maxSize: MAX_PIN_BYTES });
  if (!pin.ok) throw new Error(`Command-guard identity PIN metadata is unavailable or unsafe: ${pin.reason}`);

  ensurePrivateDirectory(paths.dataDir);
  ensurePrivateDirectory(paths.stateDirectory);

  try {
    lstatSync(paths.statePath);
    readExistingStateNoFollow(paths.statePath);
    return { created: false, paths };
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("Existing owner PIN confirmation")) throw error;
  }

  try {
    writeInitialStateNoReplace(paths.statePath);
    readExistingStateNoFollow(paths.statePath);
    return { created: true, paths };
  } catch (error) {
    // A concurrent safe initializer may have won the no-overwrite publication.
    // Accept only a fully valid existing file; otherwise preserve and refuse it.
    try {
      readExistingStateNoFollow(paths.statePath);
      return { created: false, paths };
    } catch {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      throw new Error(`Could not atomically provision owner PIN confirmation cooldown state${typeof code === "string" ? ` (${code})` : ""}`);
    }
  }
}
