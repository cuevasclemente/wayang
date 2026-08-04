#!/usr/bin/env node
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

const MAX_ENUMERATED_FILES = 100_000;
const MAX_DEPTH = 4;

function fail(message) {
  const error = new Error(message);
  error.code = "DREAM_POLICY_DENIED";
  throw error;
}

function projectionPathDefault() {
  const dataDir = process.env.WAYANG_DATA_DIR || process.env.PI_WEB_UI_DATA_DIR || path.join(os.homedir(), ".wayang");
  return path.join(dataDir, "project-access-policy.json");
}

export function loadCompleteProjection(filePath) {
  let stat;
  try { stat = fs.lstatSync(filePath); } catch { fail("Dream policy projection is unavailable"); }
  if (!stat.isFile() || stat.isSymbolicLink()) fail("Dream policy projection must be a regular file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fail("Dream policy projection is not private");
  let bytes;
  try { bytes = fs.readFileSync(filePath); } catch { fail("Dream policy projection cannot be read"); }
  let value;
  try { value = JSON.parse(bytes.toString("utf8")); } catch { fail("Dream policy projection is malformed"); }
  if (!value || typeof value !== "object" || value.schema_version !== 1 || value.complete !== true
    || !Number.isInteger(value.generation) || value.generation < 1 || !Array.isArray(value.projects)
    || !Array.isArray(value.sessions) || !value.source_store || typeof value.source_store !== "object") {
    fail("Dream policy projection is incomplete or unsupported");
  }
  const source = value.source_store;
  if (![source.size, source.mtime_ms, source.ctime_ms, source.ino].every((number) => typeof number === "number" && Number.isFinite(number))) {
    fail("Dream policy projection has an invalid source-store fingerprint");
  }
  const storePath = path.join(path.dirname(filePath), "store.json");
  let storeStat;
  try { storeStat = fs.lstatSync(storePath); } catch { fail("Dream policy projection source store is unavailable"); }
  if (!storeStat.isFile() || storeStat.isSymbolicLink()
    || storeStat.size !== source.size || storeStat.mtimeMs !== source.mtime_ms
    || storeStat.ctimeMs !== source.ctime_ms || (Number(storeStat.ino) || 0) !== source.ino) {
    fail("Dream policy projection is stale");
  }
  const decisions = new Map();
  for (const entry of value.sessions) {
    if (!entry || typeof entry !== "object" || typeof entry.session_id !== "string" || !entry.session_id
      || typeof entry.path !== "string" || !path.isAbsolute(entry.path) || typeof entry.cwd !== "string"
      || typeof entry.dream !== "boolean" || decisions.has(entry.path)) {
      fail("Dream policy projection contains an invalid or ambiguous session decision");
    }
    decisions.set(entry.path, entry);
  }
  return {
    generation: value.generation,
    fingerprint: createHash("sha256").update(bytes).digest("hex"),
    decisions,
  };
}

function within(target, root) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function canonicalRoot(root) {
  try { return fs.realpathSync.native(root); } catch { fail("Dream sessions root is unavailable"); }
}

function enumerateJsonl(root) {
  const results = [];
  const visit = (directory, depth) => {
    if (depth > MAX_DEPTH) return;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (results.length >= MAX_ENUMERATED_FILES) fail("Dream session enumeration exceeded its safety bound");
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) visit(candidate, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) results.push(fs.realpathSync.native(candidate));
    }
  };
  visit(root, 0);
  return results;
}

function allowedDecision(projection, canonicalPath) {
  const entry = projection.decisions.get(canonicalPath);
  return Boolean(entry?.dream);
}

export function listAuthorizedSessions({ projectionPath = projectionPathDefault(), sessionsRoot }) {
  if (!sessionsRoot) fail("Dream sessions root is required");
  const root = canonicalRoot(sessionsRoot);
  loadCompleteProjection(projectionPath); // fail closed before enumeration
  const candidates = enumerateJsonl(root); // names/stats only; no JSONL bytes
  const current = loadCompleteProjection(projectionPath); // race-safe current decisions
  return {
    schema_version: 1,
    generation: current.generation,
    sessions: candidates.filter((candidate) => within(candidate, root) && allowedDecision(current, candidate)).sort(),
  };
}

export function readAuthorizedSession(
  { projectionPath = projectionPathDefault(), sessionsRoot, sessionPath },
  hooks = {},
) {
  if (!sessionsRoot || !sessionPath) fail("Dream sessions root and session path are required");
  const root = canonicalRoot(sessionsRoot);
  let canonical;
  try { canonical = fs.realpathSync.native(sessionPath); } catch { fail("Dream session path is unavailable"); }
  if (!within(canonical, root)) fail("Dream session path escapes the sessions root");

  const initial = loadCompleteProjection(projectionPath);
  if (!allowedDecision(initial, canonical)) fail("Dream access to this session is denied or unknown");
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(canonical, flags);
  try {
    const before = fs.fstatSync(fd);
    if (!before.isFile()) fail("Dream session path is not a regular file");
    const preOpen = loadCompleteProjection(projectionPath);
    if (!allowedDecision(preOpen, canonical)) fail("Dream access changed before transcript read");
    hooks.beforeRead?.();
    const preRead = loadCompleteProjection(projectionPath);
    if (!allowedDecision(preRead, canonical)) fail("Dream access changed before transcript read");

    const bytes = fs.readFileSync(fd);
    hooks.afterRead?.();
    const afterRead = loadCompleteProjection(projectionPath);
    if (afterRead.fingerprint !== preRead.fingerprint || !allowedDecision(afterRead, canonical)) {
      fail("Dream policy changed during transcript read");
    }
    const after = fs.fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size
      || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs) {
      fail("Dream session changed during transcript read");
    }
    return bytes;
  } finally {
    fs.closeSync(fd);
  }
}

function parseArgs(argv) {
  const command = argv[0];
  const values = {};
  for (let index = 1; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) fail("Invalid Dream runner arguments");
    values[key.slice(2)] = value;
  }
  return { command, values };
}

function main() {
  const { command, values } = parseArgs(process.argv.slice(2));
  const options = {
    projectionPath: values.projection || projectionPathDefault(),
    sessionsRoot: values["sessions-root"],
    sessionPath: values.session,
  };
  if (command === "list") {
    process.stdout.write(`${JSON.stringify(listAuthorizedSessions(options), null, 2)}\n`);
    return;
  }
  if (command === "read") {
    process.stdout.write(readAuthorizedSession(options));
    return;
  }
  fail("Usage: dream-authorized-sessions.mjs list|read --sessions-root PATH [--session PATH] [--projection PATH]");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); }
  catch (error) {
    process.stderr.write(`dream authorization denied: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 3;
  }
}
