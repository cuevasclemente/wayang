import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { spawnSync } from "node:child_process";
import { getProject } from "./projects.js";
import { WorkspaceStoreError } from "./workspace-types.js";

const MAX_INSTRUCTIONS_BYTES = 2 * 1024 * 1024;

export interface ProjectInstructions {
  path: string;
  exists: boolean;
  text: string | null;
  sha256: string | null;
  git_tracked: boolean | null;
  git_changed: boolean | null;
}

export interface ProjectInstructionsCommitHookContext {
  root: string;
  file: string;
  replacingExisting: boolean;
}

let commitHookForTests: ((context: ProjectInstructionsCommitHookContext) => void) | undefined;

/** Deterministic synthetic race injection; production callers leave this unset. */
export function setProjectInstructionsCommitHookForTests(hook?: (context: ProjectInstructionsCommitHookContext) => void): void {
  commitHookForTests = hook;
}

function sha256(contents: Buffer | string): string {
  return crypto.createHash("sha256").update(contents).digest("hex");
}

function projectRoot(id: string): string {
  const project = getProject(id);
  if (!project) throw new WorkspaceStoreError("Project not found", 404);
  let real: string;
  try { real = fs.realpathSync.native(project.cwd); } catch { throw new WorkspaceStoreError("Project cwd is unavailable", 409); }
  if (real !== project.cwd) throw new WorkspaceStoreError("Project cwd no longer resolves to its registered path", 409);
  const stat = fs.lstatSync(project.cwd);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new WorkspaceStoreError("Project cwd is not a safe directory", 409);
  return project.cwd;
}

function instructionPath(projectId: string): { root: string; file: string } {
  const root = projectRoot(projectId);
  return { root, file: path.join(root, "AGENTS.md") };
}

function gitStatus(root: string): { tracked: boolean | null; changed: boolean | null } {
  const common = { cwd: root, encoding: "utf-8" as const, timeout: 1_000, windowsHide: true };
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", "AGENTS.md"], common);
  if (tracked.error && (tracked.error as NodeJS.ErrnoException).code === "ENOENT") return { tracked: null, changed: null };
  if (tracked.status !== 0 && tracked.status !== 1) return { tracked: null, changed: null };
  const status = spawnSync("git", ["status", "--porcelain", "--untracked-files=all", "--", "AGENTS.md"], common);
  if (status.error || status.status !== 0) return { tracked: tracked.status === 0, changed: null };
  return { tracked: tracked.status === 0, changed: Boolean(status.stdout.trim()) };
}

function bestEffortGitStatus(root: string): { tracked: boolean | null; changed: boolean | null } {
  try {
    return gitStatus(root);
  } catch {
    return { tracked: null, changed: null };
  }
}

function readRegularFile(file: string): { contents: Buffer; stat: fs.Stats } | null {
  let lstat: fs.Stats;
  try { lstat = fs.lstatSync(file); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (lstat.isSymbolicLink() || !lstat.isFile()) throw new WorkspaceStoreError("AGENTS.md must be a regular file, not a symlink", 409);
  if (lstat.size > MAX_INSTRUCTIONS_BYTES) throw new WorkspaceStoreError("AGENTS.md is too large", 413);
  const noFollow = fs.constants.O_NOFOLLOW ?? 0;
  const fd = fs.openSync(file, fs.constants.O_RDONLY | noFollow);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.dev !== lstat.dev || stat.ino !== lstat.ino) throw new WorkspaceStoreError("AGENTS.md changed while it was being opened", 409);
    return { contents: fs.readFileSync(fd), stat };
  } finally {
    fs.closeSync(fd);
  }
}

function revalidateRoot(projectId: string, expectedRoot: string): void {
  if (projectRoot(projectId) !== expectedRoot) throw new WorkspaceStoreError("Project root changed while AGENTS.md was being saved", 409);
}

function fsyncDirectoryBestEffort(root: string): void {
  let fd: number | null = null;
  try {
    fd = fs.openSync(root, fs.constants.O_RDONLY);
    fs.fsyncSync(fd);
  } catch {
    console.warn("[project-instructions] parent directory fsync failed after committed AGENTS.md update");
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* commit already occurred */ }
    }
  }
}

export function readProjectInstructions(projectId: string): ProjectInstructions {
  const { root, file } = instructionPath(projectId);
  const existing = readRegularFile(file);
  const git = bestEffortGitStatus(root);
  if (!existing) return { path: file, exists: false, text: null, sha256: null, git_tracked: git.tracked, git_changed: git.changed };
  return {
    path: file,
    exists: true,
    text: existing.contents.toString("utf-8"),
    sha256: sha256(existing.contents),
    git_tracked: git.tracked,
    git_changed: git.changed,
  };
}

export function writeProjectInstructions(projectId: string, input: {
  text: string;
  expected_sha256?: string | null;
  create_if_missing?: boolean;
}): ProjectInstructions {
  if (typeof input.text !== "string") throw new WorkspaceStoreError("text is required");
  if (Buffer.byteLength(input.text, "utf-8") > MAX_INSTRUCTIONS_BYTES) throw new WorkspaceStoreError("AGENTS.md is too large", 413);
  if (input.expected_sha256 != null && !/^[a-f0-9]{64}$/i.test(input.expected_sha256)) {
    throw new WorkspaceStoreError("expected_sha256 must be a SHA-256 hex digest");
  }

  const { root, file } = instructionPath(projectId);
  const existing = readRegularFile(file);
  const expectedHash = input.expected_sha256?.toLowerCase() ?? null;
  if (existing) {
    if (!expectedHash) throw new WorkspaceStoreError("expected_sha256 is required when AGENTS.md exists", 428);
    if (sha256(existing.contents) !== expectedHash) throw new WorkspaceStoreError("AGENTS.md changed externally", 412);
  } else if (input.create_if_missing !== true) {
    throw new WorkspaceStoreError("create_if_missing must be true when AGENTS.md does not exist", 412);
  }

  const temp = path.join(root, `.AGENTS.md.wayang-${process.pid}-${crypto.randomUUID()}.tmp`);
  let fd: number | null = null;
  let committed = false;
  try {
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, existing ? existing.stat.mode & 0o777 : 0o644);
    fs.writeFileSync(fd, input.text, "utf-8");
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = null;

    if (existing) {
      commitHookForTests?.({ root, file, replacingExisting: true });
      // Reopen with O_NOFOLLOW immediately before replacement. Identity alone
      // is insufficient because a same-inode writer can truncate/modify the
      // file; bind the final check to the approved content hash as well.
      const current = readRegularFile(file);
      if (!current || current.stat.dev !== existing.stat.dev || current.stat.ino !== existing.stat.ino) {
        throw new WorkspaceStoreError("AGENTS.md changed while it was being saved", 409);
      }
      if (sha256(current.contents) !== expectedHash) throw new WorkspaceStoreError("AGENTS.md changed externally", 412);
      revalidateRoot(projectId, root);
      fs.renameSync(temp, file);
      committed = true;
    } else {
      if (readRegularFile(file)) throw new WorkspaceStoreError("AGENTS.md was created while it was being saved", 409);
      revalidateRoot(projectId, root);
      // Synthetic tests inject the narrow race here; link(2) remains the actual
      // no-overwrite boundary if another writer wins after the absence check.
      commitHookForTests?.({ root, file, replacingExisting: false });
      try {
        fs.linkSync(temp, file);
        committed = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new WorkspaceStoreError("AGENTS.md was created while it was being saved", 409);
        }
        throw error;
      }
    }
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort before commit */ }
    }
    try { fs.unlinkSync(temp); } catch { /* temp may already be renamed or removed */ }
  }

  if (!committed) throw new WorkspaceStoreError("AGENTS.md update did not commit", 409);

  // The path update is irreversible at this point. Directory fsync and Git
  // metadata are best-effort and cannot turn committed content into an error.
  fsyncDirectoryBestEffort(root);
  const git = bestEffortGitStatus(root);
  return {
    path: file,
    exists: true,
    text: input.text,
    sha256: sha256(input.text),
    git_tracked: git.tracked,
    git_changed: git.changed,
  };
}
