import { existsSync, promises as fs } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { ensurePrivateDirectory, readBoundedRegularFile } from "./fs-state.mjs";
import { isFullOid } from "./schema.mjs";
import { runProcess, runProcessParsed } from "./process.mjs";
import { normalizeRepositoryPath } from "./policy.mjs";

const REF = /^refs\/(?:heads|maintenance)\/[A-Za-z0-9][A-Za-z0-9._\/-]{0,254}$/;
const ALLOWED_MIRROR_CONFIG = /^(?:core\.(?:repositoryformatversion|filemode|bare|ignorecase|precomposeunicode|logallrefupdates|symlinks)|remote\.origin\.(?:url|tagopt))$/;
const REQUIRED_MIRROR_CONFIG = new Set([
  "core.repositoryformatversion", "core.filemode", "core.bare",
  "remote.origin.url", "remote.origin.tagopt",
]);
const FORBIDDEN_MIRROR_PATHS = [
  "refs/replace", "info/grafts", "info/attributes", "shallow", "shallow.lock",
  "objects/info/alternates", "objects/info/http-alternates",
];

export class GitCommandError extends Error {
  constructor(message, result) {
    super(message);
    this.name = "GitCommandError";
    if (result) {
      const { parsedStdout: _parsed, ...safeResult } = result;
      this.result = Object.freeze(safeResult);
    }
  }
}

function validateOwnerControlledDirectory(path, metadata) {
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Git administrative path is not a real directory: ${path}`);
  if (process.platform !== "win32") {
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) throw new Error(`Git administrative directory has an unexpected owner: ${path}`);
    if ((metadata.mode & 0o022) !== 0) throw new Error(`Git administrative directory is group/world writable: ${path}`);
  }
}

function safeRef(ref) {
  if (typeof ref !== "string" || !REF.test(ref) || ref.includes("..") || ref.includes("//") || ref.endsWith(".") || ref.endsWith("/")) {
    throw new TypeError("unsafe Git ref");
  }
  return ref;
}

function safeRemote(remote) {
  if (typeof remote !== "string" || remote.length < 1 || remote.length > 4096 || remote.includes("\0") || /[\r\n]/.test(remote) || remote.startsWith("-")) {
    throw new TypeError("unsafe Git remote identifier");
  }
  if (isAbsolute(remote)) {
    if (remote.trim() !== remote || /[\u0000-\u001f\u007f"\\#;]/.test(remote)) throw new TypeError("local Git remote path contains unsafe configuration characters");
    return remote;
  }
  let parsed;
  try { parsed = new URL(remote); } catch { throw new TypeError("Git remote must be an absolute local path, file URL, or HTTPS URL"); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new TypeError("Git remote URL embeds forbidden data");
  if (parsed.protocol === "https:" && parsed.hostname && parsed.pathname) return remote;
  if (parsed.protocol === "file:" && (!parsed.hostname || parsed.hostname === "localhost") && parsed.pathname.startsWith("/")) return remote;
  throw new TypeError("Git remote transport is forbidden in the M1 preparation slice");
}

function decodeExact(buffer) {
  try { return new TextDecoder("utf-8", { fatal: true }).decode(buffer); }
  catch { throw new Error("Git protocol output is not valid UTF-8"); }
}

function parseSingleLine(buffer) {
  const text = decodeExact(buffer);
  const lines = text.endsWith("\n") ? text.slice(0, -1).split("\n") : text.split("\n");
  if (lines.length !== 1 || lines[0].includes("\r")) throw new Error("Git protocol output is not one canonical line");
  return lines[0];
}

function parseLines(buffer) {
  const text = decodeExact(buffer);
  const body = text.endsWith("\n") ? text.slice(0, -1) : text;
  if (!body) return [];
  const lines = body.split("\n");
  if (lines.some((line) => line.includes("\r"))) throw new Error("Git protocol output contains a carriage return");
  return lines;
}

function parseNulPaths(buffer) {
  const text = decodeExact(buffer);
  if (text && !text.endsWith("\0")) throw new Error("Git path output is not NUL terminated");
  return text.split("\0").filter(Boolean).map(normalizeRepositoryPath);
}

function parseMirrorConfigFile(buffer) {
  const text = decodeExact(buffer);
  const entries = [];
  let section = null;
  for (const rawLine of text.split(/\n/)) {
    if (rawLine.endsWith("\r")) throw new Error("maintenance mirror config has noncanonical line endings");
    if (rawLine.trim() === "") continue;
    if (["[core]", '[remote "origin"]'].includes(rawLine)) {
      section = rawLine === '[remote "origin"]' ? "remote.origin" : rawLine.slice(1, -1);
      continue;
    }
    if (!section) throw new Error("maintenance mirror config contains data outside an allowed section");
    const assignment = rawLine.match(/^\s+([A-Za-z][A-Za-z0-9.-]*)\s*=\s*([^\r\n]*)$/);
    if (!assignment) throw new Error("maintenance mirror config contains unsupported syntax");
    entries.push({ name: `${section}.${assignment[1]}`, values: [assignment[2].trim()] });
  }
  return entries;
}

function parseUnmergedEntries(buffer) {
  const records = parseNulPathsRaw(buffer);
  const paths = new Set();
  for (const record of records) {
    const match = record.match(/^([0-7]{6}) ([0-9a-f]{40}) ([123])\t([\s\S]+)$/);
    if (!match) throw new Error("Git unmerged-index output is malformed");
    paths.add(normalizeRepositoryPath(match[4]));
    if (paths.size > 64) throw new Error("merge has more than 64 conflict paths");
  }
  return [...paths].sort();
}

function parseNulPathsRaw(buffer) {
  const text = decodeExact(buffer);
  if (text && !text.endsWith("\0")) throw new Error("Git protocol output is not NUL terminated");
  return text.split("\0").filter(Boolean);
}

export function validateMirrorConfigEntries(entries, expectedRemote) {
  safeRemote(expectedRemote);
  if (!Array.isArray(entries) || entries.length > 32) throw new Error("maintenance mirror configuration is invalid or too large");
  const normalized = {};
  for (const entry of entries) {
    if (!entry || typeof entry.name !== "string" || !Array.isArray(entry.values)) throw new Error("maintenance mirror configuration entry is malformed");
    const name = entry.name.toLowerCase();
    if (!ALLOWED_MIRROR_CONFIG.test(name)) throw new Error(`maintenance mirror contains forbidden Git configuration: ${entry.name}`);
    if (Object.hasOwn(normalized, name) || entry.values.length !== 1 || typeof entry.values[0] !== "string") {
      throw new Error(`maintenance mirror configuration must have one value for ${entry.name}`);
    }
    normalized[name] = entry.values[0];
  }
  for (const name of REQUIRED_MIRROR_CONFIG) if (!Object.hasOwn(normalized, name)) throw new Error(`maintenance mirror is missing required Git configuration: ${name}`);
  const boolean = (name) => normalized[name] === "true" || normalized[name] === "false";
  if (normalized["core.repositoryformatversion"] !== "0") throw new Error("M1 maintenance caches require SHA-1 repository format 0");
  if (!boolean("core.filemode")) throw new Error("maintenance mirror filemode configuration is invalid");
  if (normalized["core.bare"] !== "true") throw new Error("maintenance mirror must be bare");
  for (const name of ["core.ignorecase", "core.precomposeunicode", "core.logallrefupdates", "core.symlinks"]) {
    if (Object.hasOwn(normalized, name) && !boolean(name)) throw new Error(`maintenance mirror ${name} configuration is invalid`);
  }
  if (normalized["remote.origin.url"] !== expectedRemote) throw new Error("maintenance cache origin does not match trusted configuration");
  if (normalized["remote.origin.tagopt"] !== "--no-tags") throw new Error("maintenance mirror tag option is invalid");
  return Object.freeze(Object.fromEntries(Object.entries(normalized).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)));
}

export class GitClient {
  constructor({ gitPath, environment, cwd, hooksPath, attributesFile, timeoutMs = 60_000, maxOutputBytes = 256 * 1024 }) {
    for (const [name, value] of Object.entries({ gitPath, cwd, hooksPath, attributesFile })) {
      if (!isAbsolute(value)) throw new TypeError(`${name} must be absolute`);
    }
    this.gitPath = gitPath;
    this.environment = environment;
    this.cwd = cwd;
    this.hooksPath = hooksPath;
    this.attributesFile = attributesFile;
    this.timeoutMs = timeoutMs;
    this.maxOutputBytes = maxOutputBytes;
  }

  async #validateInvocationControls() {
    const expectedUid = typeof process.getuid === "function" ? process.getuid() : null;
    const hooks = await fs.lstat(this.hooksPath);
    if (!hooks.isDirectory() || hooks.isSymbolicLink() || (hooks.mode & 0o077) !== 0 || (expectedUid !== null && hooks.uid !== expectedUid) || (await fs.readdir(this.hooksPath)).length !== 0) {
      throw new Error("Git hooks control directory is unsafe or nonempty");
    }
    for (const path of [this.attributesFile, this.environment.GIT_CONFIG_GLOBAL]) {
      const metadata = await fs.lstat(path);
      if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== 0 || (metadata.mode & 0o077) !== 0 || (expectedUid !== null && metadata.uid !== expectedUid)) {
        throw new Error("Git empty control file is unsafe");
      }
    }
  }

  async #run(args, { cwd = this.cwd, allowFailure = false, maxOutputBytes = this.maxOutputBytes, parseStdout } = {}) {
    await this.#validateInvocationControls();
    const options = {
      executable: this.gitPath,
      args: ["-c", `core.hooksPath=${this.hooksPath}`, "-c", `core.attributesFile=${this.attributesFile}`, ...args],
      cwd,
      environment: this.environment,
      timeoutMs: this.timeoutMs,
      maxOutputBytes,
    };
    const result = parseStdout ? await runProcessParsed(options, parseStdout) : await runProcess(options);
    if ((!result.ok || result.code !== 0) && !allowFailure) throw new GitCommandError(`Git command failed (${result.code ?? result.signal ?? "unknown"}): ${result.stderr.trim() || "no diagnostic"}`, result);
    return result;
  }

  async ensureMirror(remote, mirrorPath) {
    safeRemote(remote);
    if (!isAbsolute(mirrorPath)) throw new TypeError("mirror path must be absolute");
    await ensurePrivateDirectory(dirname(mirrorPath));
    if (!existsSync(mirrorPath)) {
      await this.#run(["init", "--bare", "--", mirrorPath]);
      const configPath = join(mirrorPath, "config");
      await this.#run(["config", `--file=${configPath}`, "--add", "remote.origin.url", remote]);
      await this.#run(["config", `--file=${configPath}`, "--add", "remote.origin.tagOpt", "--no-tags"]);
    }
    const mirrorMetadata = await fs.lstat(mirrorPath);
    validateOwnerControlledDirectory(mirrorPath, mirrorMetadata);
    await this.validateMirrorTrustBoundary(mirrorPath, remote);
    this.expectedRemote = remote;
    const bare = await this.#run([`--git-dir=${mirrorPath}`, "rev-parse", "--is-bare-repository"], { parseStdout: parseSingleLine });
    if (bare.parsedStdout !== "true") throw new Error("maintenance mirror is not bare");
  }

  async validateMirrorTrustBoundary(mirrorPath, expectedRemote) {
    const configPath = join(mirrorPath, "config");
    const metadata = await fs.lstat(configPath);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 64 * 1024) throw new Error("maintenance mirror config is not a bounded single-link regular file");
    validateMirrorConfigEntries(parseMirrorConfigFile(await readBoundedRegularFile(configPath, { maxBytes: 64 * 1024 })), expectedRemote);

    for (const name of ["objects", "refs", "hooks", "info"]) {
      const path = join(mirrorPath, name);
      validateOwnerControlledDirectory(path, await fs.lstat(path));
    }
    const worktreesPath = join(mirrorPath, "worktrees");
    try { validateOwnerControlledDirectory(worktreesPath, await fs.lstat(worktreesPath)); }
    catch (error) { if (error.code !== "ENOENT") throw error; }

    for (const relative of FORBIDDEN_MIRROR_PATHS) {
      try { await fs.lstat(join(mirrorPath, ...relative.split("/"))); throw new Error(`maintenance mirror contains forbidden state: ${relative}`); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const replacements = await this.#run([`--git-dir=${mirrorPath}`, "for-each-ref", "--format=%(refname)", "refs/replace/"], { parseStdout: parseLines });
    if (replacements.parsedStdout.length !== 0) throw new Error("maintenance mirror contains replacement refs");

    const hookEntries = await fs.readdir(join(mirrorPath, "hooks"), { withFileTypes: true });
    for (const entry of hookEntries) {
      if (!entry.name.endsWith(".sample") || !entry.isFile() || entry.isSymbolicLink()) throw new Error("maintenance mirror contains a non-sample hook entry");
    }
  }

  async fetchExact(mirrorPath, remoteName, mappings) {
    if (!isAbsolute(mirrorPath)) throw new TypeError("mirror path must be absolute");
    if (remoteName !== "origin") throw new TypeError("only the fixed origin remote is allowed");
    if (!Array.isArray(mappings) || mappings.length < 1 || mappings.length > 16) throw new TypeError("invalid fetch mappings");
    const refspecs = mappings.map(({ source, destination }) => {
      safeRef(source);
      safeRef(destination);
      if (!source.startsWith("refs/heads/") || !destination.startsWith("refs/maintenance/")) throw new TypeError("fetch mappings must copy exact heads into maintenance refs");
      return `${source}:${destination}`;
    });
    if (!this.expectedRemote) throw new Error("mirror must be validated before fetch");
    await this.#run([`--git-dir=${mirrorPath}`, "fetch", "--no-tags", "--no-recurse-submodules", "origin", ...refspecs]);
    await this.validateMirrorTrustBoundary(mirrorPath, this.expectedRemote);
  }

  async resolveCommit(repositoryArgs, revision) {
    if (!(typeof revision === "string" && (REF.test(revision) || /^HEAD(?:\^[12])?$/.test(revision)))) throw new TypeError("unsafe Git revision");
    const result = await this.#run([...repositoryArgs, "rev-parse", "--verify", `${revision}^{commit}`], { parseStdout: parseSingleLine });
    if (!isFullOid(result.parsedStdout)) throw new Error("Git returned a non-full object ID");
    return result.parsedStdout;
  }

  async isAncestor(repositoryArgs, ancestorOid, descendantOid) {
    if (!isFullOid(ancestorOid) || !isFullOid(descendantOid)) throw new TypeError("invalid ancestry inputs");
    const result = await this.#run([...repositoryArgs, "merge-base", "--is-ancestor", ancestorOid, descendantOid], { allowFailure: true });
    if (result.code === 0) return true;
    if (result.code === 1 && !result.timedOut && !result.outputLimitExceeded) return false;
    throw new GitCommandError("unable to determine Git ancestry", result);
  }

  async changedPaths(mirrorPath, baseOid, headOid, { mergeBase = true } = {}) {
    if (!isAbsolute(mirrorPath) || !isFullOid(baseOid) || !isFullOid(headOid)) throw new TypeError("invalid diff inputs");
    const range = mergeBase ? `${baseOid}...${headOid}` : `${baseOid}..${headOid}`;
    const result = await this.#run([`--git-dir=${mirrorPath}`, "diff", "--name-only", "-z", "--no-renames", range, "--"], { parseStdout: parseNulPaths });
    return result.parsedStdout;
  }

  async listTreePaths(mirrorPath, oid) {
    if (!isAbsolute(mirrorPath) || !isFullOid(oid)) throw new TypeError("invalid tree listing inputs");
    const result = await this.#run([`--git-dir=${mirrorPath}`, "ls-tree", "-r", "-z", "--name-only", oid, "--"], { parseStdout: parseNulPaths });
    return result.parsedStdout;
  }

  async createWorktree(mirrorPath, worktreePath, oid) {
    if (!isAbsolute(mirrorPath) || !isAbsolute(worktreePath) || !isFullOid(oid)) throw new TypeError("invalid worktree inputs");
    await ensurePrivateDirectory(dirname(worktreePath));
    await this.#run([`--git-dir=${mirrorPath}`, "worktree", "add", "--detach", "--", worktreePath, oid]);
    const worktreesPath = join(mirrorPath, "worktrees");
    validateOwnerControlledDirectory(worktreesPath, await fs.lstat(worktreesPath));
  }

  async mergeExact(worktreePath, upstreamOid) {
    if (!isAbsolute(worktreePath) || !isFullOid(upstreamOid)) throw new TypeError("invalid merge inputs");
    const downstreamOid = await this.resolveCommit(["-C", worktreePath], "HEAD");
    const result = await this.#run([
      "-C", worktreePath,
      "-c", "user.name=Wayang Maintenance",
      "-c", "user.email=maintenance.invalid@example.invalid",
      "merge", "--no-ff", "--no-edit", "--", upstreamOid,
    ], { allowFailure: true });
    if (result.ok && result.code === 0) {
      const candidateOid = await this.resolveCommit(["-C", worktreePath], "HEAD");
      const firstParent = await this.resolveCommit(["-C", worktreePath], "HEAD^1");
      const secondParent = await this.resolveCommit(["-C", worktreePath], "HEAD^2");
      if (firstParent !== downstreamOid || secondParent !== upstreamOid) throw new Error("merge candidate does not have the exact expected parents");
      return Object.freeze({ ok: true, candidateOid, conflicts: [] });
    }
    if (result.timedOut || result.outputLimitExceeded || result.signal !== null || result.code !== 1) throw new GitCommandError("merge did not complete as a conflict", result);
    const unmerged = await this.#run(["-C", worktreePath, "ls-files", "-u", "-z", "--"], { parseStdout: parseUnmergedEntries });
    if (unmerged.parsedStdout.length === 0) throw new GitCommandError("merge failed without verified unmerged index entries", result);
    return Object.freeze({ ok: false, candidateOid: null, conflicts: unmerged.parsedStdout });
  }
}
