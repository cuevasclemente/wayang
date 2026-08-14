import { constants, promises as fs } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { parseStrictJson, SchemaError, isFullOid } from "./schema.mjs";

export const STATE_SCHEMA = "wayang-maintenance-state/v1";
export const MAX_STATE_BYTES = 64 * 1024;
const PHASES = new Set(["initialized", "locked", "refs_snapshot", "policy_passed", "merging", "candidate_ready", "completed", "blocked", "failed"]);
const TERMINAL = new Set(["completed", "blocked", "failed"]);
const TRANSITIONS = new Map([
  ["initialized", new Set(["locked", "failed"])],
  ["locked", new Set(["refs_snapshot", "failed"])],
  ["refs_snapshot", new Set(["policy_passed", "completed", "blocked", "failed"])],
  ["policy_passed", new Set(["merging", "failed"])],
  ["merging", new Set(["candidate_ready", "blocked", "failed"])],
  ["candidate_ready", new Set(["completed", "failed"])],
]);

export function boundDetail(value, maxBytes = 512) {
  const text = String(value);
  if (Buffer.byteLength(text, "utf8") <= maxBytes) return text;
  const marker = "...[truncated]";
  const budget = maxBytes - Buffer.byteLength(marker);
  let result = "";
  let used = 0;
  for (const character of text) {
    const size = Buffer.byteLength(character);
    if (used + size > budget) break;
    result += character;
    used += size;
  }
  return result + marker;
}

export function canonicalJson(value) {
  function normalize(item) {
    if (item === null || typeof item === "string" || typeof item === "boolean") return item;
    if (typeof item === "number" && Number.isFinite(item)) return item;
    if (Array.isArray(item)) return item.map(normalize);
    if (item && typeof item === "object" && [Object.prototype, null].includes(Object.getPrototypeOf(item))) {
      const result = Object.create(null);
      for (const key of Object.keys(item).sort()) {
        if (item[key] === undefined) throw new TypeError(`undefined JSON value at ${key}`);
        result[key] = normalize(item[key]);
      }
      return result;
    }
    throw new TypeError("state contains a non-JSON value");
  }
  return `${JSON.stringify(normalize(value))}\n`;
}

export async function fsyncDirectory(path) {
  const handle = await fs.open(path, constants.O_RDONLY);
  try { await handle.sync(); }
  finally { await handle.close(); }
}

export async function ensureEmptyRegularFile(path) {
  if (!isAbsolute(path)) throw new TypeError("empty control file path must be absolute");
  await ensurePrivateDirectory(dirname(path));
  let handle;
  try {
    handle = await fs.open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fsyncDirectory(dirname(path));
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (error.code !== "EEXIST") throw error;
  }
  const metadata = await fs.lstat(path);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== 0) throw new Error(`control file is not empty and regular: ${path}`);
}

function isOwnerPrivate(metadata) {
  if (process.platform === "win32") return true;
  return (typeof process.getuid !== "function" || metadata.uid === process.getuid()) && (metadata.mode & 0o077) === 0;
}

function validatePrivateDirectory(path, metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`unsafe directory: ${path}`);
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`directory has unexpected owner: ${path}`);
    if ((metadata.mode & 0o077) !== 0) throw new Error(`directory permissions are not private: ${path}`);
  }
}

export async function ensurePrivateDirectory(path) {
  if (!isAbsolute(path)) throw new TypeError("private directory path must be absolute");
  const target = resolve(path);
  const missing = [];
  let ancestor = target;
  let ancestorMetadata;
  while (true) {
    try {
      ancestorMetadata = await fs.lstat(ancestor);
      break;
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = dirname(ancestor);
      if (parent === ancestor) throw new Error(`no existing absolute ancestor for ${target}`);
      missing.unshift(ancestor);
      ancestor = parent;
    }
  }
  if (!ancestorMetadata.isDirectory() || ancestorMetadata.isSymbolicLink()) throw new Error(`unsafe directory ancestor: ${ancestor}`);

  // Syncing the nearest existing ancestor's parent makes a retry after a prior
  // mkdir/fsync failure durable before any deeper component is created.
  if (ancestor !== dirname(ancestor)) await fsyncDirectory(dirname(ancestor));
  for (const component of missing) {
    const parent = dirname(component);
    try { await fs.mkdir(component, { mode: 0o700 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    const metadata = await fs.lstat(component);
    validatePrivateDirectory(component, metadata);
    await fsyncDirectory(parent);
  }
  const finalMetadata = missing.length === 0 ? ancestorMetadata : await fs.lstat(target);
  validatePrivateDirectory(target, finalMetadata);

  // Walk upward through the owner-private hierarchy so an existing target
  // cannot hide a symlinked component below its trusted public ancestor.
  let current = target;
  while (dirname(current) !== current) {
    const parent = dirname(current);
    const metadata = await fs.lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`unsafe directory ancestor: ${parent}`);
    if (!isOwnerPrivate(metadata)) break;
    current = parent;
  }
}

export async function writeJsonAtomic(path, value, { maxBytes = MAX_STATE_BYTES } = {}) {
  if (!isAbsolute(path)) throw new TypeError("atomic state path must be absolute");
  const parent = dirname(path);
  await ensurePrivateDirectory(parent);
  const content = canonicalJson(value);
  if (Buffer.byteLength(content) > maxBytes) throw new Error(`state exceeds ${maxBytes} bytes`);
  const temporary = join(parent, `.${randomBytes(16).toString("hex")}.tmp`);
  let handle;
  try {
    handle = await fs.open(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await fs.rename(temporary, path);
    await fsyncDirectory(parent);
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await fs.unlink(temporary).catch(() => {});
    throw error;
  }
}

export async function readBoundedRegularFile(path, { maxBytes = MAX_STATE_BYTES } = {}) {
  const noFollow = constants.O_NOFOLLOW || 0;
  const handle = await fs.open(path, constants.O_RDONLY | noFollow);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1) throw new Error("state path is not a single-link regular file");
    if (metadata.size > maxBytes) throw new Error(`state exceeds ${maxBytes} bytes`);
    return await handle.readFile();
  } finally {
    await handle.close();
  }
}

function validateState(value) {
  const fields = ["schema", "runId", "sequence", "phase", "previousPhase", "reason", "refs", "candidateOid", "details", "updatedAt"];
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new SchemaError("state must be an object");
  for (const key of Object.keys(value)) if (!fields.includes(key)) throw new SchemaError(`state contains unknown field ${JSON.stringify(key)}`);
  for (const key of fields) if (!Object.hasOwn(value, key)) throw new SchemaError(`state is missing field ${JSON.stringify(key)}`);
  if (value.schema !== STATE_SCHEMA) throw new SchemaError("state schema is unsupported");
  if (typeof value.runId !== "string" || value.runId.length < 1 || value.runId.length > 64) throw new SchemaError("invalid state runId");
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new SchemaError("invalid state sequence");
  if (!PHASES.has(value.phase)) throw new SchemaError("invalid state phase");
  if (value.previousPhase !== null && !PHASES.has(value.previousPhase)) throw new SchemaError("invalid previous state phase");
  if (value.reason !== null && (typeof value.reason !== "string" || value.reason.length > 128)) throw new SchemaError("invalid state reason");
  if (value.candidateOid !== null && !isFullOid(value.candidateOid)) throw new SchemaError("invalid candidate object ID");
  if (value.refs !== null) {
    if (!value.refs || typeof value.refs !== "object" || Array.isArray(value.refs)) throw new SchemaError("invalid refs");
    const keys = Object.keys(value.refs);
    if (keys.length !== 2 || !keys.includes("upstream") || !keys.includes("downstream")) throw new SchemaError("refs must contain only upstream and downstream");
    if (!isFullOid(value.refs.upstream) || !isFullOid(value.refs.downstream)) throw new SchemaError("invalid refs object ID");
  }
  if (!Array.isArray(value.details) || value.details.length > 64 || value.details.some((item) => typeof item !== "string" || Buffer.byteLength(item) > 512)) {
    throw new SchemaError("invalid state details");
  }
  if (typeof value.updatedAt !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value.updatedAt)) throw new SchemaError("invalid state timestamp");

  if (value.phase === "initialized") {
    if (value.sequence !== 0 || value.previousPhase !== null) throw new SchemaError("initialized state sequence is invalid");
  } else if (value.previousPhase === null || !TRANSITIONS.get(value.previousPhase)?.has(value.phase) || value.sequence < 1) {
    throw new SchemaError("state predecessor is invalid");
  }
  const normalSequence = { initialized: 0, locked: 1, refs_snapshot: 2, policy_passed: 3, merging: 4, candidate_ready: 5, completed: 6 };
  const expectedSequence = value.phase === "completed" && value.reason === "pi_up_to_date"
    ? 3
    : value.phase === "blocked" || value.phase === "failed"
      ? normalSequence[value.previousPhase] + 1
      : normalSequence[value.phase];
  if (value.sequence !== expectedSequence) throw new SchemaError("state sequence does not match phase");
  const refsRequired = new Set(["refs_snapshot", "policy_passed", "merging", "candidate_ready", "completed", "blocked"]);
  if (refsRequired.has(value.phase) && value.refs === null) throw new SchemaError("state refs do not match phase");
  if (["initialized", "locked"].includes(value.phase) && value.refs !== null) throw new SchemaError("state refs do not match phase");
  const candidateRequired = value.phase === "candidate_ready" || value.phase === "completed" || (value.phase === "blocked" && value.reason === "candidate_tree_policy");
  if (candidateRequired && value.candidateOid === null) throw new SchemaError("state candidate does not match phase");
  if (value.phase !== "failed" && !candidateRequired && value.candidateOid !== null) throw new SchemaError("state candidate does not match phase");
  if (["initialized", "locked", "refs_snapshot", "policy_passed", "merging", "candidate_ready"].includes(value.phase) && value.reason !== null) throw new SchemaError("nonterminal state has a reason");
  if (value.phase === "completed" && ![null, "pi_up_to_date"].includes(value.reason)) throw new SchemaError("completed state reason is invalid");
  if (value.phase === "blocked" && !["stale_base", "critical_path_policy", "candidate_tree_policy", "merge_conflict"].includes(value.reason)) throw new SchemaError("blocked state reason is invalid");
  if (value.phase === "blocked") {
    const expectedPrevious = ["stale_base", "critical_path_policy"].includes(value.reason) ? "refs_snapshot" : "merging";
    if (value.previousPhase !== expectedPrevious) throw new SchemaError("blocked state reason does not match predecessor");
  }
  if (value.phase === "failed" && value.reason !== "internal_error") throw new SchemaError("failed state reason is invalid");
  if (value.phase === "failed" && value.reason === "internal_error" && value.details.length === 0) throw new SchemaError("internal error state requires bounded details");
  if (value.phase === "completed" && value.reason === "pi_up_to_date" && (value.previousPhase !== "refs_snapshot" || value.candidateOid !== value.refs?.downstream)) {
    throw new SchemaError("no-action state payload is invalid");
  }
  if (value.phase === "completed" && value.reason === null && value.previousPhase !== "candidate_ready") throw new SchemaError("completed candidate state predecessor is invalid");
  if (!["blocked", "failed"].includes(value.phase) && value.details.length !== 0) throw new SchemaError("state details do not match phase");
  if (value.phase === "blocked" && value.details.length === 0) throw new SchemaError("blocked state requires bounded details");
  return Object.freeze({
    schema: value.schema,
    runId: value.runId,
    sequence: value.sequence,
    phase: value.phase,
    previousPhase: value.previousPhase,
    reason: value.reason,
    refs: value.refs === null ? null : Object.freeze({ upstream: value.refs.upstream, downstream: value.refs.downstream }),
    candidateOid: value.candidateOid,
    details: Object.freeze([...value.details]),
    updatedAt: value.updatedAt,
  });
}

export async function readState(path) {
  return validateState(parseStrictJson(await readBoundedRegularFile(path), { maxBytes: MAX_STATE_BYTES, maxDepth: 8 }));
}

export class StateJournal {
  constructor(path, runId, { now = () => new Date() } = {}) {
    if (!isAbsolute(path)) throw new TypeError("state journal path must be absolute");
    this.path = path;
    this.runId = runId;
    this.now = now;
  }

  async initialize() {
    try { await fs.lstat(this.path); throw new Error("state journal already exists"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const state = this.#record("initialized", null, 0, {});
    await writeJsonAtomic(this.path, state);
    return state;
  }

  async transition(expectedPhase, nextPhase, patch = {}) {
    const current = await readState(this.path);
    if (current.runId !== this.runId) throw new Error("state journal run ID mismatch");
    if (current.phase !== expectedPhase) throw new Error(`state transition expected ${expectedPhase}, found ${current.phase}`);
    if (TERMINAL.has(current.phase) || !TRANSITIONS.get(current.phase)?.has(nextPhase)) {
      throw new Error(`state transition ${current.phase} -> ${nextPhase} is forbidden`);
    }
    const allowedPatch = new Set(["reason", "refs", "candidateOid", "details"]);
    for (const key of Object.keys(patch)) if (!allowedPatch.has(key)) throw new Error(`unknown state patch field ${key}`);
    const next = this.#record(nextPhase, current.phase, current.sequence + 1, { ...current, ...patch });
    await writeJsonAtomic(this.path, next);
    return next;
  }

  #record(phase, previousPhase, sequence, patch) {
    return validateState({
      schema: STATE_SCHEMA,
      runId: this.runId,
      sequence,
      phase,
      previousPhase,
      reason: patch.reason ?? null,
      refs: patch.refs ?? null,
      candidateOid: patch.candidateOid ?? null,
      details: patch.details ?? [],
      updatedAt: this.now().toISOString(),
    });
  }
}
