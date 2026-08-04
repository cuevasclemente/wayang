import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getStore } from "../db.js";
import { getWayangDataRoot } from "../protected-artifacts.js";
import {
  MAX_PROTECTED_AUTOMATION_SNAPSHOT_BYTES_GLOBAL,
  MAX_PROTECTED_AUTOMATION_SNAPSHOT_BYTES_PER_PROJECT_AGENT,
  MAX_PROTECTED_AUTOMATION_SNAPSHOT_REVISIONS_PER_JOB,
} from "./types.js";

export const PROTECTED_AUTOMATION_SNAPSHOT_LIMITS = Object.freeze({
  maxFiles: 1_024,
  maxDirectories: 512,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 32 * 1024 * 1024,
  maxDepth: 32,
  maxRelativePathBytes: 1_024,
  maxRevisionsPerJob: MAX_PROTECTED_AUTOMATION_SNAPSHOT_REVISIONS_PER_JOB,
  maxProjectAgentBytes: MAX_PROTECTED_AUTOMATION_SNAPSHOT_BYTES_PER_PROJECT_AGENT,
  maxGlobalBytes: MAX_PROTECTED_AUTOMATION_SNAPSHOT_BYTES_GLOBAL,
});

const SNAPSHOT_VERSION = 1 as const;
const SNAPSHOT_ROOT_NAME = "protected-automation";
const MANIFEST_NAME = "manifest.json";
const SOURCE_NAME = "source";
const PRIVATE_DIRECTORY_MODE = 0o700;
const IMMUTABLE_DIRECTORY_MODE = 0o500;
const PRIVATE_FILE_MODE = 0o600;
const IMMUTABLE_FILE_MODE = 0o400;
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/u;
const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const MANIFEST_MAX_BYTES = 2 * 1024 * 1024;
const ALLOCATION_BLOCK_BYTES = 512;
const DIRECTORY_ALLOCATION_FLOOR_BYTES = 4 * 1024;
const TEMP_NAME_PATTERN = /^\.[1-9][0-9]*\.tmp-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;
const PURGE_NAME_PATTERN = /^\.purge-[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/u;

export interface CaptureProtectedAutomationSnapshotInput {
  projectRoot: string;
  projectId: string;
  agentProfileId: string;
  jobId: string;
  revision: number;
  /** Canonical POSIX-style path relative to the project root. `.` means the root. */
  sourceDirectory: string;
  /** Canonical POSIX-style path relative to sourceDirectory. */
  entrypoint: string;
}

export interface VerifyProtectedAutomationSnapshotInput {
  projectId: string;
  agentProfileId: string;
  jobId: string;
  revision: number;
  /** The hash retained in the protected automation job row. */
  expectedManifestSha256: string;
}

export interface DiscardProtectedAutomationSnapshotInput extends VerifyProtectedAutomationSnapshotInput {
  /** Must be the exact process-local result returned by the creating capture call. */
  capture: ProtectedAutomationSnapshotCaptureResult;
}

/** Safe for metadata surfaces: this deliberately contains no host snapshot path. */
export interface ProtectedAutomationSnapshotMetadata {
  revision: number;
  entrypoint: string;
  manifestSha256: string;
  entrypointSha256: string;
  fileCount: number;
  directoryCount: number;
  totalBytes: number;
}

/** Internal capture lifecycle metadata; tool results deliberately omit `created`. */
export interface ProtectedAutomationSnapshotCaptureResult extends ProtectedAutomationSnapshotMetadata {
  created: boolean;
  /** Actual bounded allocation charged to aggregate quotas. */
  allocatedBytes: number;
}

interface DiscardReceipt {
  projectId: string;
  agentProfileId: string;
  jobId: string;
  revision: number;
  manifestSha256: string;
  revisionRoot: string;
}

const discardReceipts = new WeakMap<ProtectedAutomationSnapshotCaptureResult, DiscardReceipt>();
const activeTempRoots = new Set<string>();
const activePublishedRoots = new Set<string>();

interface ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
}

interface SnapshotManifest {
  version: typeof SNAPSHOT_VERSION;
  projectId: string;
  agentProfileId: string;
  jobId: string;
  revision: number;
  entrypoint: string;
  directories: string[];
  files: ManifestFile[];
  totalBytes: number;
}

interface SourceFile extends Omit<ManifestFile, "sha256"> {
  absolutePath: string;
  stat: fs.Stats;
}

interface SourceDirectory {
  path: string;
  absolutePath: string;
  stat: fs.Stats;
}

interface PreflightTree {
  root: SourceDirectory;
  directories: SourceDirectory[];
  files: SourceFile[];
  totalBytes: number;
}

export class ProtectedAutomationSnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProtectedAutomationSnapshotError";
  }
}

function fail(message: string): never {
  throw new ProtectedAutomationSnapshotError(message);
}

function ownUid(): number | undefined {
  return typeof process.getuid === "function" ? process.getuid() : undefined;
}

function validateIdentity(value: string, label: string): string {
  if (typeof value !== "string" || !ID_PATTERN.test(value)) fail(`Invalid snapshot ${label}`);
  return value;
}

function validateRevision(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) fail("Invalid snapshot revision");
  return value;
}

function pathBytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function normalizeRelativePath(value: string, label: string, allowRoot: boolean): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0") || value.includes("\\")) {
    fail(`${label} must be a canonical project-relative path`);
  }
  if (path.posix.isAbsolute(value) || value.startsWith("/") || value.endsWith("/") || value.includes("//")) {
    fail(`${label} must be a canonical project-relative path`);
  }
  if (allowRoot && value === ".") return value;
  const components = value.split("/");
  if (components.length === 0 || components.some((component) => component === "" || component === "." || component === "..")) {
    fail(`${label} must be a canonical project-relative path`);
  }
  if (components.length > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxDepth ||
      pathBytes(value) > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxRelativePathBytes ||
      path.posix.normalize(value) !== value) {
    fail(`${label} exceeds the snapshot path bounds`);
  }
  return value;
}

function isForbiddenComponent(component: string): boolean {
  const lower = component.toLowerCase();
  return lower === ".pi" || lower === ".ssh" || lower === ".gnupg" ||
    lower === ".env" || lower.startsWith(".env.") ||
    lower === "auth.json" || lower === "command-guard-identity-pin" ||
    lower === ".npmrc" || lower === ".netrc" || lower === ".pypirc";
}

function rejectForbiddenPath(relativePath: string): void {
  if (relativePath.split("/").some(isForbiddenComponent)) {
    fail("Snapshot source contains a forbidden secret-bearing path");
  }
}

function sameStat(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function allocatedBytes(metadata: fs.Stats, kind: "file" | "directory"): number {
  const blocks = metadata.blocks;
  if (!Number.isSafeInteger(metadata.size) || metadata.size < 0 ||
      !Number.isSafeInteger(blocks) || blocks < 0 || blocks > Math.floor(Number.MAX_SAFE_INTEGER / ALLOCATION_BLOCK_BYTES)) {
    fail("Snapshot storage allocation metadata is invalid");
  }
  const allocation = Math.max(
    metadata.size,
    blocks * ALLOCATION_BLOCK_BYTES,
    kind === "directory" ? DIRECTORY_ALLOCATION_FLOOR_BYTES : 0,
  );
  if (!Number.isSafeInteger(allocation) || allocation > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxGlobalBytes) {
    fail("Snapshot storage allocation exceeds its compiled bound");
  }
  return allocation;
}

function addAllocation(total: number, value: number): number {
  const result = total + value;
  if (!Number.isSafeInteger(result) || result > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxGlobalBytes) {
    fail("Snapshot storage allocation exceeds its compiled bound");
  }
  return result;
}

function destinationAllocationUnit(target: string): number {
  try {
    const unit = fs.statfsSync(target).bsize;
    if (Number.isSafeInteger(unit) && unit >= ALLOCATION_BLOCK_BYTES &&
        unit <= PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes) return unit;
  } catch {
    // The compiled floor remains conservative on ordinary supported filesystems.
  }
  return DIRECTORY_ALLOCATION_FLOOR_BYTES;
}

function roundedAllocation(size: number, unit: number): number {
  if (size === 0) return 0;
  const rounded = Math.ceil(size / unit) * unit;
  if (!Number.isSafeInteger(rounded) || rounded > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxGlobalBytes) {
    fail("Snapshot storage allocation exceeds its compiled bound");
  }
  return rounded;
}

function lstatSafe(target: string, message: string): fs.Stats {
  try {
    return fs.lstatSync(target);
  } catch {
    fail(message);
  }
}

function realpathSafe(target: string, message: string): string {
  try {
    return fs.realpathSync.native(target);
  } catch {
    fail(message);
  }
}

function ensureCanonicalDirectory(target: string, message: string): fs.Stats {
  const metadata = lstatSafe(target, message);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) fail(message);
  if (realpathSafe(target, message) !== path.resolve(target)) fail(message);
  return metadata;
}

function canonicalProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0 || !path.isAbsolute(projectRoot)) {
    fail("Project root must be an absolute directory");
  }
  const canonical = realpathSafe(projectRoot, "Project root is unavailable");
  ensureCanonicalDirectory(canonical, "Project root must be a canonical regular directory");
  return canonical;
}

function pathsOverlap(left: string, right: string): boolean {
  const relativeLeft = path.relative(left, right);
  const relativeRight = path.relative(right, left);
  const isInside = (relative: string): boolean => relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
  return isInside(relativeLeft) || isInside(relativeRight);
}

function resolveSourceRoot(projectRoot: string, sourceDirectory: string): string {
  let cursor = projectRoot;
  if (sourceDirectory === ".") return cursor;
  for (const component of sourceDirectory.split("/")) {
    rejectForbiddenPath(component);
    cursor = path.join(cursor, component);
    ensureCanonicalDirectory(cursor, "Snapshot source path must contain only canonical regular directories");
  }
  return cursor;
}

function sortedNames(directory: string, message: string): string[] {
  try {
    return fs.readdirSync(directory).sort((left, right) => left < right ? -1 : left > right ? 1 : 0);
  } catch {
    fail(message);
  }
}

/** Metadata-only first pass: forbidden names and unsafe entries are rejected before content is opened. */
function preflightSourceTree(sourceRoot: string): PreflightTree {
  const root: SourceDirectory = {
    path: "",
    absolutePath: sourceRoot,
    stat: ensureCanonicalDirectory(sourceRoot, "Snapshot source must be a canonical regular directory"),
  };
  const directories: SourceDirectory[] = [];
  const files: SourceFile[] = [];
  let totalBytes = 0;

  const visit = (absoluteDirectory: string, relativeDirectory: string, depth: number): void => {
    if (depth > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxDepth) fail("Snapshot source exceeds the directory depth bound");
    const directoryStat = ensureCanonicalDirectory(
      absoluteDirectory,
      "Snapshot source changed or contains a non-canonical directory",
    );
    if (relativeDirectory) directories.push({ path: relativeDirectory, absolutePath: absoluteDirectory, stat: directoryStat });
    if (directories.length > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxDirectories) {
      fail("Snapshot source exceeds the directory count bound");
    }

    for (const name of sortedNames(absoluteDirectory, "Snapshot source directory cannot be read safely")) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      normalizeRelativePath(relativePath, "Snapshot source path", false);
      rejectForbiddenPath(relativePath);
      const absolutePath = path.join(absoluteDirectory, name);
      const metadata = lstatSafe(absolutePath, "Snapshot source changed during validation");
      if (metadata.isSymbolicLink()) fail("Snapshot source must not contain symbolic links");
      if (metadata.isDirectory()) {
        visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!metadata.isFile()) fail("Snapshot source must contain only regular files and directories");
      if (metadata.nlink !== 1) fail("Snapshot source must not contain hardlinked files");
      if (metadata.size > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes) {
        fail("Snapshot source exceeds the per-file byte bound");
      }
      files.push({ path: relativePath, absolutePath, bytes: metadata.size, stat: metadata });
      if (files.length > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFiles) fail("Snapshot source exceeds the file count bound");
      totalBytes += metadata.size;
      if (!Number.isSafeInteger(totalBytes) || totalBytes > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxTotalBytes) {
        fail("Snapshot source exceeds the total byte bound");
      }
    }
    const after = lstatSafe(absoluteDirectory, "Snapshot source changed during validation");
    if (!sameStat(directoryStat, after)) fail("Snapshot source changed during validation");
  };

  visit(sourceRoot, "", 0);
  if (!sameStat(root.stat, lstatSafe(sourceRoot, "Snapshot source changed during validation"))) {
    fail("Snapshot source changed during validation");
  }
  return { root, directories, files, totalBytes };
}

function validatePrivateDirectory(target: string): void {
  const metadata = lstatSafe(target, "Private snapshot storage is unsafe");
  const uid = ownUid();
  if (!metadata.isDirectory() || metadata.isSymbolicLink() || (uid !== undefined && metadata.uid !== uid)) {
    fail("Private snapshot storage is unsafe");
  }
  if ((metadata.mode & 0o077) !== 0) fail("Private snapshot storage is not owner-only");
  if (realpathSafe(target, "Private snapshot storage is unsafe") !== path.resolve(target)) {
    fail("Private snapshot storage is non-canonical");
  }
}

function privateDirectoryAllocation(target: string): number {
  const before = lstatSafe(target, "Private snapshot storage is unsafe");
  validatePrivateDirectory(target);
  const after = lstatSafe(target, "Private snapshot storage is unsafe");
  if (!sameStat(before, after)) fail("Private snapshot storage changed during allocation accounting");
  return allocatedBytes(after, "directory");
}

function ensurePrivateDirectory(target: string): void {
  let created = false;
  try {
    fs.mkdirSync(target, { mode: PRIVATE_DIRECTORY_MODE });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") fail("Private snapshot storage cannot be created safely");
  }
  if (created) {
    try { fs.chmodSync(target, PRIVATE_DIRECTORY_MODE); } catch { fail("Private snapshot storage permissions cannot be secured"); }
  }
  validatePrivateDirectory(target);
}

function opaqueJobKey(projectId: string, agentProfileId: string, jobId: string): string {
  return createHash("sha256")
    .update("wayang.protected-automation.snapshot-job.v1\0")
    .update(projectId).update("\0")
    .update(agentProfileId).update("\0")
    .update(jobId)
    .digest("hex");
}

function storagePaths(projectId: string, agentProfileId: string, jobId: string, revision: number, create: boolean): {
  automationRoot: string;
  jobsRoot: string;
  jobRoot: string;
  revisionsRoot: string;
  revisionRoot: string;
} {
  const dataRoot = getWayangDataRoot();
  if (create) {
    try {
      fs.mkdirSync(dataRoot, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
    } catch {
      fail("Wayang data storage is unavailable");
    }
  }
  const automationRoot = path.join(dataRoot, SNAPSHOT_ROOT_NAME);
  const jobsRoot = path.join(automationRoot, "jobs");
  const jobRoot = path.join(jobsRoot, opaqueJobKey(projectId, agentProfileId, jobId));
  const revisionsRoot = path.join(jobRoot, "revisions");
  for (const directory of [automationRoot, jobsRoot, jobRoot, revisionsRoot]) {
    if (create) ensurePrivateDirectory(directory);
    else validatePrivateDirectory(directory);
  }
  return { automationRoot, jobsRoot, jobRoot, revisionsRoot, revisionRoot: path.join(revisionsRoot, String(revision)) };
}

function pathDoesNotExist(target: string): boolean {
  try {
    fs.lstatSync(target);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    fail("Snapshot publication target cannot be validated safely");
  }
}

function openNoFollowRegularFile(target: string, expected?: fs.Stats): number {
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | noFollow);
  } catch {
    fail("Snapshot file cannot be opened safely");
  }
  try {
    const metadata = fs.fstatSync(descriptor);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || (expected && !sameStat(metadata, expected))) {
      fail("Snapshot file is not one unchanged regular file");
    }
    return descriptor;
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

function readBoundedDescriptor(descriptor: number, expectedBytes: number): Buffer {
  if (expectedBytes > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes) fail("Snapshot file exceeds the byte bound");
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(descriptor);
  } catch {
    fail("Snapshot file cannot be read safely");
  }
  if (bytes.length !== expectedBytes) fail("Snapshot file changed while it was read");
  return bytes;
}

function writePrivateFile(target: string, bytes: Buffer): void {
  let descriptor: number;
  try {
    descriptor = fs.openSync(target, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, PRIVATE_FILE_MODE);
  } catch {
    fail("Private snapshot file cannot be created safely");
  }
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fsyncDirectory(target: string): void {
  const directoryFlag = typeof fs.constants.O_DIRECTORY === "number" ? fs.constants.O_DIRECTORY : 0;
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(target, fs.constants.O_RDONLY | directoryFlag);
    fs.fsyncSync(descriptor);
  } catch {
    // Some supported filesystems do not implement directory fsync. File fsync and atomic rename remain enforced.
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function canonicalManifestBytes(manifest: SnapshotManifest): Buffer {
  return Buffer.from(`${JSON.stringify(manifest)}\n`, "utf8");
}

function metadataFor(manifest: SnapshotManifest, manifestSha256: string): ProtectedAutomationSnapshotMetadata {
  const entrypoint = manifest.files.find((file) => file.path === manifest.entrypoint);
  if (!entrypoint) fail("Snapshot entrypoint is absent from the manifest");
  return Object.freeze({
    revision: manifest.revision,
    entrypoint: manifest.entrypoint,
    manifestSha256,
    entrypointSha256: entrypoint.sha256,
    fileCount: manifest.files.length,
    directoryCount: manifest.directories.length,
    totalBytes: manifest.totalBytes,
  });
}

function makeTreeWritableForCleanup(root: string): void {
  try {
    const metadata = fs.lstatSync(root);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) return;
    fs.chmodSync(root, PRIVATE_DIRECTORY_MODE);
    for (const name of fs.readdirSync(root)) makeTreeWritableForCleanup(path.join(root, name));
  } catch {
    // Cleanup is best effort; published roots are fully verified before this helper is used.
  }
}

function removePrivateTemp(root: string): void {
  makeTreeWritableForCleanup(root);
  try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* leave an inert private temp on failure */ }
}

function lockCapturedTree(tempRoot: string, directories: string[]): void {
  for (const relativePath of directories.slice().sort((left, right) => right.split("/").length - left.split("/").length)) {
    fs.chmodSync(path.join(tempRoot, SOURCE_NAME, ...relativePath.split("/")), IMMUTABLE_DIRECTORY_MODE);
  }
  fs.chmodSync(path.join(tempRoot, SOURCE_NAME), IMMUTABLE_DIRECTORY_MODE);
  fs.chmodSync(path.join(tempRoot, MANIFEST_NAME), IMMUTABLE_FILE_MODE);
  fs.chmodSync(tempRoot, IMMUTABLE_DIRECTORY_MODE);
}

function validateSourceUnchanged(preflight: PreflightTree, message: string): void {
  for (const directory of [preflight.root, ...preflight.directories]) {
    if (!sameStat(directory.stat, lstatSafe(directory.absolutePath, message))) fail(message);
  }
  for (const sourceFile of preflight.files) {
    if (!sameStat(sourceFile.stat, lstatSafe(sourceFile.absolutePath, message))) fail(message);
  }
}

function manifestFromSource(
  preflight: PreflightTree,
  identity: Pick<SnapshotManifest, "projectId" | "agentProfileId" | "jobId" | "revision" | "entrypoint">,
  destinationSource?: string,
): SnapshotManifest {
  const files: ManifestFile[] = [];
  for (const sourceFile of preflight.files) {
    const before = lstatSafe(sourceFile.absolutePath, "Snapshot source changed after validation");
    if (!sameStat(before, sourceFile.stat) ||
        realpathSafe(sourceFile.absolutePath, "Snapshot source file is non-canonical") !== sourceFile.absolutePath) {
      fail("Snapshot source changed after validation");
    }
    const descriptor = openNoFollowRegularFile(sourceFile.absolutePath, sourceFile.stat);
    let bytes: Buffer;
    try {
      bytes = readBoundedDescriptor(descriptor, sourceFile.bytes);
      if (!sameStat(fs.fstatSync(descriptor), sourceFile.stat)) fail("Snapshot source changed while it was read");
    } finally {
      fs.closeSync(descriptor);
    }
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    if (destinationSource !== undefined) {
      const destination = path.join(destinationSource, ...sourceFile.path.split("/"));
      writePrivateFile(destination, bytes);
      fs.chmodSync(destination, IMMUTABLE_FILE_MODE);
    }
    files.push({ path: sourceFile.path, bytes: sourceFile.bytes, sha256 });
  }
  validateSourceUnchanged(preflight, "Snapshot source changed before publication");
  return {
    version: SNAPSHOT_VERSION,
    ...identity,
    directories: preflight.directories.map((directory) => directory.path),
    files,
    totalBytes: preflight.totalBytes,
  };
}

function estimatedCaptureAllocation(
  preflight: PreflightTree,
  identity: Pick<SnapshotManifest, "projectId" | "agentProfileId" | "jobId" | "revision" | "entrypoint">,
  destinationUnit: number,
): number {
  const estimatedManifest: SnapshotManifest = {
    version: SNAPSHOT_VERSION,
    ...identity,
    directories: preflight.directories.map((directory) => directory.path),
    files: preflight.files.map((file) => ({ path: file.path, bytes: file.bytes, sha256: "0".repeat(64) })),
    totalBytes: preflight.totalBytes,
  };
  const manifestBytes = canonicalManifestBytes(estimatedManifest).length;
  if (manifestBytes > MANIFEST_MAX_BYTES) fail("Snapshot manifest exceeds its byte bound");
  let allocation = Math.max(manifestBytes, roundedAllocation(manifestBytes, destinationUnit));
  // The published revision and source roots are distinct allocated directories.
  const rootAllocation = Math.max(allocatedBytes(preflight.root.stat, "directory"), destinationUnit);
  allocation = addAllocation(allocation, rootAllocation * 2);
  for (const directory of preflight.directories) {
    allocation = addAllocation(allocation, Math.max(allocatedBytes(directory.stat, "directory"), destinationUnit));
  }
  for (const file of preflight.files) {
    allocation = addAllocation(
      allocation,
      Math.max(allocatedBytes(file.stat, "file"), roundedAllocation(file.bytes, destinationUnit)),
    );
  }
  return allocation;
}

interface SnapshotUsage {
  globalBytes: number;
  projectAgentBytes: number;
  jobRevisions: number;
}

function validateOwnedTempTree(tempRoot: string): void {
  validatePrivateDirectory(tempRoot);
  let directories = 0;
  let files = 0;
  const visitSource = (absoluteDirectory: string, relativeDirectory: string, depth: number): void => {
    if (depth > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxDepth) fail("Private snapshot temp path exceeds its depth bound");
    const directoryMetadata = lstatSafe(absoluteDirectory, "Private snapshot temp tree is unsafe");
    const uid = ownUid();
    if (!directoryMetadata.isDirectory() || directoryMetadata.isSymbolicLink() ||
        (uid !== undefined && directoryMetadata.uid !== uid) || (directoryMetadata.mode & 0o077) !== 0 ||
        realpathSafe(absoluteDirectory, "Private snapshot temp tree is unsafe") !== absoluteDirectory) {
      fail("Private snapshot temp tree is unsafe");
    }
    for (const name of sortedNames(absoluteDirectory, "Private snapshot temp tree cannot be enumerated safely")) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      normalizeRelativePath(relativePath, "Private snapshot temp path", false);
      rejectForbiddenPath(relativePath);
      const target = path.join(absoluteDirectory, name);
      const metadata = lstatSafe(target, "Private snapshot temp entry is unsafe");
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        directories += 1;
        if (directories > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxDirectories) fail("Private snapshot temp tree has too many directories");
        visitSource(target, relativePath, depth + 1);
      } else {
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
            (uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o077) !== 0 ||
            metadata.size > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes) {
          fail("Private snapshot temp entry is unsafe");
        }
        files += 1;
        if (files > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFiles) fail("Private snapshot temp tree has too many files");
      }
    }
  };

  const rootEntries = sortedNames(tempRoot, "Private snapshot temp tree cannot be enumerated safely");
  if (rootEntries.some((name) => name !== MANIFEST_NAME && name !== SOURCE_NAME)) {
    fail("Private snapshot temp tree has an invalid schema");
  }
  if (rootEntries.includes(MANIFEST_NAME)) {
    const metadata = lstatSafe(path.join(tempRoot, MANIFEST_NAME), "Private snapshot temp manifest is unsafe");
    const uid = ownUid();
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
        (uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o077) !== 0 ||
        metadata.size > MANIFEST_MAX_BYTES) {
      fail("Private snapshot temp manifest is unsafe");
    }
  }
  if (rootEntries.includes(SOURCE_NAME)) visitSource(path.join(tempRoot, SOURCE_NAME), "", 0);
}

function removeValidatedTree(root: string, label: string): void {
  makeTreeWritableForCleanup(root);
  try { fs.rmSync(root, { recursive: true, force: false }); } catch { fail(`${label} could not be removed safely`); }
  if (!pathDoesNotExist(root)) fail(`${label} could not be removed safely`);
}

function cleanupEmptyJobParents(jobRoot: string, revisionsRoot: string): void {
  if (sortedNames(revisionsRoot, "Private snapshot revisions cannot be enumerated safely").length !== 0) return;
  if (removeEmptyPrivateDirectory(revisionsRoot)) removeEmptyPrivateDirectory(jobRoot);
}

/** Reconcile only verified crash/orphan artifacts; current and historical durable revisions are retained. */
export function reconcileProtectedAutomationSnapshots(): void {
  const automationRoot = path.join(getWayangDataRoot(), SNAPSHOT_ROOT_NAME);
  if (pathDoesNotExist(automationRoot)) return;
  validatePrivateDirectory(automationRoot);
  const automationEntries = sortedNames(automationRoot, "Private snapshot metadata cannot be enumerated safely");
  const allowedAutomationEntries = new Set(["jobs", "browser-realms", "runtime"]);
  if (automationEntries.some((entry) => !allowedAutomationEntries.has(entry))) fail("Private snapshot metadata has an invalid schema");
  if (!automationEntries.includes("jobs")) return;
  const jobsRoot = path.join(automationRoot, "jobs");
  validatePrivateDirectory(jobsRoot);
  const durableJobs = new Map(getStore().protectedAutomationJobs.map((row) => [row.id, row]));

  for (const storedJobKey of sortedNames(jobsRoot, "Private snapshot metadata cannot be enumerated safely")) {
    const jobRoot = path.join(jobsRoot, storedJobKey);
    validatePrivateDirectory(jobRoot);
    const jobEntries = sortedNames(jobRoot, "Private snapshot job metadata cannot be enumerated safely");
    if (jobEntries.length !== 1 || jobEntries[0] !== "revisions") fail("Private snapshot job metadata has an invalid schema");
    const revisionsRoot = path.join(jobRoot, "revisions");
    validatePrivateDirectory(revisionsRoot);
    if (PURGE_NAME_PATTERN.test(storedJobKey)) {
      let identity: Pick<SnapshotManifest, "projectId" | "agentProfileId" | "jobId"> | undefined;
      for (const revisionName of sortedNames(revisionsRoot, "Private snapshot revisions cannot be enumerated safely")) {
        if (!/^[1-9][0-9]*$/u.test(revisionName)) fail("Staged snapshot purge contains an invalid revision");
        const published = readPublishedSnapshot(path.join(revisionsRoot, revisionName), true).manifest;
        if (!identity) identity = published;
        if (published.projectId !== identity.projectId || published.agentProfileId !== identity.agentProfileId
          || published.jobId !== identity.jobId || published.revision !== Number(revisionName)) {
          fail("Staged snapshot purge contains mixed owner identities");
        }
      }
      if (!identity) fail("Staged snapshot purge is empty");
      const durable = durableJobs.get(identity.jobId);
      const canonicalKey = opaqueJobKey(identity.projectId, identity.agentProfileId, identity.jobId);
      const canonicalRoot = path.join(jobsRoot, canonicalKey);
      if (durable) {
        if (durable.project_id !== identity.projectId || durable.agent_profile_id !== identity.agentProfileId
          || !pathDoesNotExist(canonicalRoot)) fail("Staged snapshot purge conflicts with durable ownership");
        fs.renameSync(jobRoot, canonicalRoot);
        fsyncDirectory(jobsRoot);
      } else {
        removeValidatedTree(jobRoot, "Committed staged snapshot purge");
      }
      continue;
    }
    if (!SHA256_PATTERN.test(storedJobKey)) fail("Private snapshot metadata contains an invalid job key");

    for (const revisionName of sortedNames(revisionsRoot, "Private snapshot revisions cannot be enumerated safely")) {
      const revisionRoot = path.join(revisionsRoot, revisionName);
      if (TEMP_NAME_PATTERN.test(revisionName)) {
        if (activeTempRoots.has(revisionRoot)) continue;
        validateOwnedTempTree(revisionRoot);
        removeValidatedTree(revisionRoot, "Inactive private snapshot temp tree");
        continue;
      }
      if (!/^[1-9][0-9]*$/u.test(revisionName) || String(validateRevision(Number(revisionName))) !== revisionName) {
        fail("Private snapshot metadata contains an invalid revision");
      }
      if (activePublishedRoots.has(revisionRoot)) continue;
      const published = readPublishedSnapshot(revisionRoot, false);
      const manifest = published.manifest;
      if (opaqueJobKey(manifest.projectId, manifest.agentProfileId, manifest.jobId) !== storedJobKey ||
          String(manifest.revision) !== revisionName) {
        fail("Private snapshot metadata is bound to a different owner or revision");
      }
      const durable = durableJobs.get(manifest.jobId);
      if (durable && (durable.project_id !== manifest.projectId || durable.agent_profile_id !== manifest.agentProfileId)) {
        fail("Private snapshot metadata conflicts with durable job ownership");
      }
      if (!durable || manifest.revision > durable.source_revision) {
        readPublishedSnapshot(revisionRoot, true);
        removeValidatedTree(revisionRoot, "Verified orphan snapshot revision");
      }
    }
    cleanupEmptyJobParents(jobRoot, revisionsRoot);
  }
  if (pathDoesNotExist(jobsRoot)) return;
  if (sortedNames(jobsRoot, "Private snapshot metadata cannot be enumerated safely").length === 0 &&
      removeEmptyPrivateDirectory(jobsRoot)) {
    removeEmptyPrivateDirectory(automationRoot);
  }
}

function readPublishedSnapshot(revisionRoot: string, verifyContents: boolean): {
  manifest: SnapshotManifest;
  manifestSha256: string;
  allocatedBytes: number;
} {
  verifyImmutableMetadata(revisionRoot, "directory");
  const manifestPath = path.join(revisionRoot, MANIFEST_NAME);
  const manifestMetadata = verifyImmutableMetadata(manifestPath, "file");
  if (manifestMetadata.size <= 0 || manifestMetadata.size > MANIFEST_MAX_BYTES) fail("Snapshot manifest exceeds its byte bound");
  const descriptor = openNoFollowRegularFile(manifestPath, manifestMetadata);
  let manifestBytes: Buffer;
  try { manifestBytes = fs.readFileSync(descriptor); } catch { fail("Snapshot manifest cannot be read safely"); } finally { fs.closeSync(descriptor); }
  const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
  const manifest = parseManifest(manifestBytes);
  if (!canonicalManifestBytes(manifest).equals(manifestBytes)) fail("Snapshot manifest is not canonically encoded");
  const treeAllocation = verifySnapshotTree(revisionRoot, manifest, verifyContents);
  return {
    manifest,
    manifestSha256,
    allocatedBytes: addAllocation(treeAllocation, allocatedBytes(manifestMetadata, "file")),
  };
}

function scanSnapshotUsage(
  projectId: string,
  agentProfileId: string,
  jobId: string,
  ignoredTempRoot?: string,
): SnapshotUsage {
  const { automationRoot, jobsRoot } = storagePaths(projectId, agentProfileId, jobId, 1, true);
  const automationEntries = sortedNames(automationRoot, "Private snapshot metadata cannot be enumerated safely");
  const allowedAutomationEntries = new Set(["jobs", "browser-realms", "runtime"]);
  if (!automationEntries.includes("jobs") || automationEntries.some((entry) => !allowedAutomationEntries.has(entry))) {
    fail("Private snapshot metadata has an invalid schema");
  }
  let globalBytes = addAllocation(
    privateDirectoryAllocation(automationRoot),
    privateDirectoryAllocation(jobsRoot),
  );
  const pairBytes = new Map<string, number>();
  const revisionCounts = new Map<string, number>();
  const requestedPairKey = JSON.stringify([projectId, agentProfileId]);
  const requestedJobKey = opaqueJobKey(projectId, agentProfileId, jobId);
  for (const storedJobKey of sortedNames(jobsRoot, "Private snapshot metadata cannot be enumerated safely")) {
    if (!SHA256_PATTERN.test(storedJobKey)) fail("Private snapshot metadata contains an invalid job key");
    const jobRoot = path.join(jobsRoot, storedJobKey);
    validatePrivateDirectory(jobRoot);
    const jobEntries = sortedNames(jobRoot, "Private snapshot job metadata cannot be enumerated safely");
    if (jobEntries.length !== 1 || jobEntries[0] !== "revisions") fail("Private snapshot job metadata has an invalid schema");
    const revisionsRoot = path.join(jobRoot, "revisions");
    validatePrivateDirectory(revisionsRoot);
    const jobParentAllocation = addAllocation(
      privateDirectoryAllocation(jobRoot),
      privateDirectoryAllocation(revisionsRoot),
    );
    let chargedJobParents = false;
    for (const revisionName of sortedNames(revisionsRoot, "Private snapshot revisions cannot be enumerated safely")) {
      const storedRevisionRoot = path.join(revisionsRoot, revisionName);
      if (TEMP_NAME_PATTERN.test(revisionName)) {
        if (storedRevisionRoot === ignoredTempRoot || activeTempRoots.has(storedRevisionRoot)) continue;
        fail("Private snapshot metadata contains an inactive temp tree");
      }
      if (!/^[1-9][0-9]*$/u.test(revisionName) || String(validateRevision(Number(revisionName))) !== revisionName) {
        fail("Private snapshot metadata contains an invalid revision");
      }
      const { manifest, allocatedBytes: treeAllocation } = readPublishedSnapshot(storedRevisionRoot, false);
      const revisionAllocation = chargedJobParents ? treeAllocation : addAllocation(treeAllocation, jobParentAllocation);
      chargedJobParents = true;
      if (opaqueJobKey(manifest.projectId, manifest.agentProfileId, manifest.jobId) !== storedJobKey ||
          String(manifest.revision) !== revisionName) {
        fail("Private snapshot metadata is bound to a different owner or revision");
      }
      globalBytes += revisionAllocation;
      if (!Number.isSafeInteger(globalBytes) || globalBytes > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxGlobalBytes) {
        fail("Global protected automation snapshot byte quota is exhausted");
      }
      const pairKey = JSON.stringify([manifest.projectId, manifest.agentProfileId]);
      const nextPairBytes = (pairBytes.get(pairKey) ?? 0) + revisionAllocation;
      if (!Number.isSafeInteger(nextPairBytes) ||
          nextPairBytes > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxProjectAgentBytes) {
        fail("Exact Project-Agent snapshot byte quota is exhausted");
      }
      pairBytes.set(pairKey, nextPairBytes);
      const nextRevisionCount = (revisionCounts.get(storedJobKey) ?? 0) + 1;
      if (nextRevisionCount > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxRevisionsPerJob) {
        fail("Protected automation snapshot revision limit is exhausted for a stored job");
      }
      revisionCounts.set(storedJobKey, nextRevisionCount);
    }
  }
  return {
    globalBytes,
    projectAgentBytes: pairBytes.get(requestedPairKey) ?? 0,
    jobRevisions: revisionCounts.get(requestedJobKey) ?? 0,
  };
}

function assertCaptureCapacity(usage: SnapshotUsage, incomingBytes: number): void {
  if (usage.jobRevisions >= PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxRevisionsPerJob) {
    fail("Protected automation snapshot revision limit is exhausted for this job");
  }
  if (usage.projectAgentBytes + incomingBytes > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxProjectAgentBytes) {
    fail("Exact Project-Agent snapshot byte quota would be exceeded");
  }
  if (usage.globalBytes + incomingBytes > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxGlobalBytes) {
    fail("Global protected automation snapshot byte quota would be exceeded");
  }
}

function captureResult(
  metadata: ProtectedAutomationSnapshotMetadata,
  created: boolean,
  allocation: number,
  receipt?: DiscardReceipt,
): ProtectedAutomationSnapshotCaptureResult {
  const result = Object.freeze({ ...metadata, created, allocatedBytes: allocation });
  if (receipt) {
    discardReceipts.set(result, receipt);
    activePublishedRoots.add(receipt.revisionRoot);
  }
  return result;
}

/** Consume a new-capture discard receipt after its durable job reference commits. */
export function finalizeProtectedAutomationSnapshotCapture(capture: ProtectedAutomationSnapshotCaptureResult): void {
  if (!capture.created) return;
  const receipt = discardReceipts.get(capture);
  if (!receipt || !activePublishedRoots.has(receipt.revisionRoot)) {
    fail("Protected automation snapshot capture cannot be finalized safely");
  }
  activePublishedRoots.delete(receipt.revisionRoot);
  discardReceipts.delete(capture);
}

export function captureProtectedAutomationSnapshot(
  input: CaptureProtectedAutomationSnapshotInput,
): ProtectedAutomationSnapshotCaptureResult {
  const projectId = validateIdentity(input.projectId, "project id");
  const agentProfileId = validateIdentity(input.agentProfileId, "agent profile id");
  const jobId = validateIdentity(input.jobId, "job id");
  const revision = validateRevision(input.revision);
  const sourceDirectory = normalizeRelativePath(input.sourceDirectory, "Source directory", true);
  const entrypoint = normalizeRelativePath(input.entrypoint, "Entrypoint", false);
  rejectForbiddenPath(sourceDirectory);
  rejectForbiddenPath(entrypoint);

  const projectRoot = canonicalProjectRoot(input.projectRoot);
  const sourceRoot = resolveSourceRoot(projectRoot, sourceDirectory);
  if (pathsOverlap(sourceRoot, getWayangDataRoot())) fail("Snapshot source must not overlap private Wayang data");
  reconcileProtectedAutomationSnapshots();
  const preflight = preflightSourceTree(sourceRoot);
  const entrypointSource = preflight.files.find((file) => file.path === entrypoint);
  if (!entrypointSource) fail("Snapshot entrypoint must be one regular file inside the requested source directory");

  const identity = { projectId, agentProfileId, jobId, revision, entrypoint };
  const { jobRoot, revisionsRoot, revisionRoot } = storagePaths(projectId, agentProfileId, jobId, revision, true);
  let incomingAllocationEstimate = estimatedCaptureAllocation(
    preflight,
    identity,
    destinationAllocationUnit(revisionsRoot),
  );
  const initialUsage = scanSnapshotUsage(projectId, agentProfileId, jobId);
  if (initialUsage.jobRevisions === 0) {
    incomingAllocationEstimate = addAllocation(
      incomingAllocationEstimate,
      addAllocation(privateDirectoryAllocation(jobRoot), privateDirectoryAllocation(revisionsRoot)),
    );
  }
  if (!pathDoesNotExist(revisionRoot)) {
    const existing = readPublishedSnapshot(revisionRoot, true);
    const requested = manifestFromSource(preflight, identity);
    const requestedBytes = canonicalManifestBytes(requested);
    const requestedSha256 = createHash("sha256").update(requestedBytes).digest("hex");
    if (requestedSha256 !== existing.manifestSha256 || !requestedBytes.equals(canonicalManifestBytes(existing.manifest))) {
      fail("Snapshot revision already exists with different exact content");
    }
    return captureResult(metadataFor(existing.manifest, existing.manifestSha256), false, existing.allocatedBytes);
  }
  assertCaptureCapacity(initialUsage, incomingAllocationEstimate);

  const tempRoot = path.join(revisionsRoot, `.${revision}.tmp-${randomUUID()}`);
  let tempCreated = false;
  activeTempRoots.add(tempRoot);
  try {
    fs.mkdirSync(tempRoot, { mode: PRIVATE_DIRECTORY_MODE });
    tempCreated = true;
    const destinationSource = path.join(tempRoot, SOURCE_NAME);
    fs.mkdirSync(destinationSource, { mode: PRIVATE_DIRECTORY_MODE });
    for (const directory of preflight.directories) {
      fs.mkdirSync(path.join(destinationSource, ...directory.path.split("/")), { mode: PRIVATE_DIRECTORY_MODE });
    }

    const manifest = manifestFromSource(preflight, identity, destinationSource);
    const manifestBytes = canonicalManifestBytes(manifest);
    if (manifestBytes.length > MANIFEST_MAX_BYTES) fail("Snapshot manifest exceeds its byte bound");
    const manifestSha256 = createHash("sha256").update(manifestBytes).digest("hex");
    writePrivateFile(path.join(tempRoot, MANIFEST_NAME), manifestBytes);
    for (const directory of manifest.directories) {
      fsyncDirectory(path.join(destinationSource, ...directory.split("/")));
    }
    fsyncDirectory(destinationSource);
    fsyncDirectory(tempRoot);
    lockCapturedTree(tempRoot, manifest.directories);

    if (!pathDoesNotExist(revisionRoot)) {
      const existing = readPublishedSnapshot(revisionRoot, true);
      if (existing.manifestSha256 !== manifestSha256 ||
          !canonicalManifestBytes(existing.manifest).equals(manifestBytes)) {
        fail("Snapshot revision already exists with different exact content");
      }
      removePrivateTemp(tempRoot);
      activeTempRoots.delete(tempRoot);
      return captureResult(metadataFor(existing.manifest, existing.manifestSha256), false, existing.allocatedBytes);
    }
    reconcileProtectedAutomationSnapshots();
    const tempAllocation = readPublishedSnapshot(tempRoot, false).allocatedBytes;
    const publicationUsage = scanSnapshotUsage(projectId, agentProfileId, jobId, tempRoot);
    const publicationAllocation = publicationUsage.jobRevisions === 0
      ? addAllocation(
        tempAllocation,
        addAllocation(privateDirectoryAllocation(jobRoot), privateDirectoryAllocation(revisionsRoot)),
      )
      : tempAllocation;
    assertCaptureCapacity(publicationUsage, publicationAllocation);
    try {
      fs.renameSync(tempRoot, revisionRoot);
    } catch {
      fail("Snapshot revision could not be published without overwrite");
    }
    activeTempRoots.delete(tempRoot);
    fsyncDirectory(revisionsRoot);
    const metadata = metadataFor(manifest, manifestSha256);
    return captureResult(
      metadata,
      true,
      publicationAllocation,
      { projectId, agentProfileId, jobId, revision, manifestSha256, revisionRoot },
    );
  } catch (error) {
    activeTempRoots.delete(tempRoot);
    if (tempCreated && !pathDoesNotExist(tempRoot)) removePrivateTemp(tempRoot);
    if (error instanceof ProtectedAutomationSnapshotError) throw error;
    fail("Snapshot capture failed safely");
  }
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) fail(`Snapshot ${label} has an invalid schema`);
}

function parseManifest(bytes: Buffer): SnapshotManifest {
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    fail("Snapshot manifest is malformed");
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) fail("Snapshot manifest is malformed");
  const value = raw as Record<string, unknown>;
  exactKeys(value, ["version", "projectId", "agentProfileId", "jobId", "revision", "entrypoint", "directories", "files", "totalBytes"], "manifest");
  if (value.version !== SNAPSHOT_VERSION) fail("Snapshot manifest version is unsupported");
  const projectId = validateIdentity(value.projectId as string, "manifest project id");
  const agentProfileId = validateIdentity(value.agentProfileId as string, "manifest agent profile id");
  const jobId = validateIdentity(value.jobId as string, "manifest job id");
  const revision = validateRevision(value.revision as number);
  const entrypoint = normalizeRelativePath(value.entrypoint as string, "Manifest entrypoint", false);
  rejectForbiddenPath(entrypoint);
  if (!Array.isArray(value.directories) || value.directories.length > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxDirectories) {
    fail("Snapshot manifest directory list is invalid");
  }
  const directories = value.directories.map((item) => normalizeRelativePath(item as string, "Manifest directory", false));
  for (const item of directories) rejectForbiddenPath(item);
  if (directories.some((item, index) => index > 0 && item <= directories[index - 1]!)) fail("Snapshot manifest directories are not unique and sorted");
  if (!Array.isArray(value.files) || value.files.length > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFiles) {
    fail("Snapshot manifest file list is invalid");
  }
  const files: ManifestFile[] = value.files.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) fail("Snapshot manifest file is malformed");
    const file = item as Record<string, unknown>;
    exactKeys(file, ["path", "bytes", "sha256"], "manifest file");
    const filePath = normalizeRelativePath(file.path as string, "Manifest file path", false);
    rejectForbiddenPath(filePath);
    if (!Number.isSafeInteger(file.bytes) || (file.bytes as number) < 0 ||
        (file.bytes as number) > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes ||
        typeof file.sha256 !== "string" || !SHA256_PATTERN.test(file.sha256)) {
      fail("Snapshot manifest file metadata is invalid");
    }
    return { path: filePath, bytes: file.bytes as number, sha256: file.sha256 };
  });
  if (files.some((item, index) => index > 0 && item.path <= files[index - 1]!.path)) fail("Snapshot manifest files are not unique and sorted");
  const summedBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  if (!Number.isSafeInteger(value.totalBytes) || value.totalBytes !== summedBytes || summedBytes > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxTotalBytes) {
    fail("Snapshot manifest total byte count is invalid");
  }
  const filePaths = new Set(files.map((file) => file.path));
  if (!filePaths.has(entrypoint)) fail("Snapshot manifest entrypoint is absent");
  return { version: SNAPSHOT_VERSION, projectId, agentProfileId, jobId, revision, entrypoint, directories, files, totalBytes: summedBytes };
}

function verifyImmutableMetadata(target: string, kind: "file" | "directory"): fs.Stats {
  const metadata = lstatSafe(target, "Snapshot storage has been removed or replaced");
  const uid = ownUid();
  const correctType = kind === "file" ? metadata.isFile() : metadata.isDirectory();
  const expectedMode = kind === "file" ? IMMUTABLE_FILE_MODE : IMMUTABLE_DIRECTORY_MODE;
  if (!correctType || metadata.isSymbolicLink() || (kind === "file" && metadata.nlink !== 1) ||
      (uid !== undefined && metadata.uid !== uid) || (metadata.mode & 0o777) !== expectedMode) {
    fail("Snapshot storage metadata failed immutable owner-only verification");
  }
  return metadata;
}

function verifySnapshotTree(revisionRoot: string, manifest: SnapshotManifest, verifyContents = true): number {
  let allocation = allocatedBytes(verifyImmutableMetadata(revisionRoot, "directory"), "directory");
  const rootNames = sortedNames(revisionRoot, "Snapshot revision cannot be enumerated safely");
  if (rootNames.length !== 2 || rootNames[0] !== MANIFEST_NAME || rootNames[1] !== SOURCE_NAME) {
    fail("Snapshot revision contains unexpected entries");
  }
  const sourceRoot = path.join(revisionRoot, SOURCE_NAME);
  allocation = addAllocation(allocation, allocatedBytes(verifyImmutableMetadata(sourceRoot, "directory"), "directory"));
  if (realpathSafe(sourceRoot, "Snapshot source storage is non-canonical") !== sourceRoot) fail("Snapshot source storage is non-canonical");

  const actualDirectories: string[] = [];
  const actualFiles: ManifestFile[] = [];
  const expectedFiles = new Map(manifest.files.map((file) => [file.path, file]));
  const visit = (absoluteDirectory: string, relativeDirectory: string, depth: number): void => {
    if (depth > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxDepth) fail("Snapshot exceeds the directory depth bound");
    for (const name of sortedNames(absoluteDirectory, "Snapshot source cannot be enumerated safely")) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      normalizeRelativePath(relativePath, "Snapshot path", false);
      rejectForbiddenPath(relativePath);
      const absolutePath = path.join(absoluteDirectory, name);
      const metadata = lstatSafe(absolutePath, "Snapshot source entry was removed or replaced");
      if (metadata.isDirectory() && !metadata.isSymbolicLink()) {
        const verifiedDirectory = verifyImmutableMetadata(absolutePath, "directory");
        if (!sameStat(metadata, verifiedDirectory)) fail("Snapshot directory changed during verification");
        allocation = addAllocation(allocation, allocatedBytes(verifiedDirectory, "directory"));
        if (realpathSafe(absolutePath, "Snapshot directory is non-canonical") !== absolutePath) fail("Snapshot directory is non-canonical");
        actualDirectories.push(relativePath);
        if (actualDirectories.length > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxDirectories) fail("Snapshot contains too many directories");
        visit(absolutePath, relativePath, depth + 1);
        continue;
      }
      const verifiedFile = verifyImmutableMetadata(absolutePath, "file");
      if (!sameStat(metadata, verifiedFile)) fail("Snapshot file changed during verification");
      allocation = addAllocation(allocation, allocatedBytes(verifiedFile, "file"));
      if (metadata.size > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFileBytes) fail("Snapshot file exceeds its byte bound");
      let sha256 = expectedFiles.get(relativePath)?.sha256 ?? "";
      if (verifyContents) {
        const descriptor = openNoFollowRegularFile(absolutePath, metadata);
        let bytes: Buffer;
        try { bytes = readBoundedDescriptor(descriptor, metadata.size); } finally { fs.closeSync(descriptor); }
        sha256 = createHash("sha256").update(bytes).digest("hex");
      }
      actualFiles.push({ path: relativePath, bytes: metadata.size, sha256 });
      if (actualFiles.length > PROTECTED_AUTOMATION_SNAPSHOT_LIMITS.maxFiles) fail("Snapshot contains too many files");
    }
  };
  visit(sourceRoot, "", 0);
  if (JSON.stringify(actualDirectories) !== JSON.stringify(manifest.directories) || JSON.stringify(actualFiles) !== JSON.stringify(manifest.files)) {
    fail("Snapshot content does not match its immutable manifest");
  }
  return allocation;
}

export function verifyProtectedAutomationSnapshot(
  input: VerifyProtectedAutomationSnapshotInput,
): ProtectedAutomationSnapshotMetadata {
  const projectId = validateIdentity(input.projectId, "project id");
  const agentProfileId = validateIdentity(input.agentProfileId, "agent profile id");
  const jobId = validateIdentity(input.jobId, "job id");
  const revision = validateRevision(input.revision);
  if (typeof input.expectedManifestSha256 !== "string" || !SHA256_PATTERN.test(input.expectedManifestSha256)) {
    fail("Expected snapshot manifest hash is invalid");
  }
  const { revisionRoot } = storagePaths(projectId, agentProfileId, jobId, revision, false);
  const { manifest, manifestSha256 } = readPublishedSnapshot(revisionRoot, true);
  if (manifestSha256 !== input.expectedManifestSha256) fail("Snapshot manifest hash mismatch");
  if (manifest.projectId !== projectId || manifest.agentProfileId !== agentProfileId || manifest.jobId !== jobId || manifest.revision !== revision) {
    fail("Snapshot manifest is bound to a different owner or revision");
  }
  return metadataFor(manifest, manifestSha256);
}

/**
 * Internal execution lease. The caller must re-check authority immediately
 * before spawn; the returned path is never suitable for an API/tool result.
 */
export function resolveProtectedAutomationSnapshotSourceForExecution(
  input: VerifyProtectedAutomationSnapshotInput,
): { sourceRoot: string; metadata: ProtectedAutomationSnapshotMetadata } {
  const metadata = verifyProtectedAutomationSnapshot(input);
  const { revisionRoot } = storagePaths(
    input.projectId,
    input.agentProfileId,
    input.jobId,
    input.revision,
    false,
  );
  const sourceRoot = path.join(revisionRoot, SOURCE_NAME);
  verifyImmutableMetadata(sourceRoot, "directory");
  return { sourceRoot, metadata };
}

function removeEmptyPrivateDirectory(target: string): boolean {
  validatePrivateDirectory(target);
  try {
    fs.rmdirSync(target);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOTEMPTY") return false;
    fail("Empty private snapshot parent could not be removed safely");
  }
}

/**
 * Remove only the exact verified revision created by the supplied capture call.
 * A reused/idempotent capture has no process-local receipt and can never be discarded.
 */
export function discardProtectedAutomationSnapshot(input: DiscardProtectedAutomationSnapshotInput): boolean {
  if (!input || typeof input !== "object" || Array.isArray(input)) fail("Snapshot discard input is invalid");
  const projectId = validateIdentity(input.projectId, "project id");
  const agentProfileId = validateIdentity(input.agentProfileId, "agent profile id");
  const jobId = validateIdentity(input.jobId, "job id");
  const revision = validateRevision(input.revision);
  if (typeof input.expectedManifestSha256 !== "string" || !SHA256_PATTERN.test(input.expectedManifestSha256)) {
    fail("Expected snapshot manifest hash is invalid");
  }
  const receipt = discardReceipts.get(input.capture);
  if (!input.capture?.created || !receipt || receipt.projectId !== projectId ||
      receipt.agentProfileId !== agentProfileId || receipt.jobId !== jobId || receipt.revision !== revision ||
      receipt.manifestSha256 !== input.expectedManifestSha256) {
    return false;
  }
  const paths = storagePaths(projectId, agentProfileId, jobId, revision, false);
  if (paths.revisionRoot !== receipt.revisionRoot) fail("Snapshot discard receipt is not bound to the exact revision");
  const verified = verifyProtectedAutomationSnapshot({
    projectId,
    agentProfileId,
    jobId,
    revision,
    expectedManifestSha256: input.expectedManifestSha256,
  });
  const expectedMetadata = { ...input.capture };
  delete (expectedMetadata as Partial<ProtectedAutomationSnapshotCaptureResult>).created;
  delete (expectedMetadata as Partial<ProtectedAutomationSnapshotCaptureResult>).allocatedBytes;
  if (JSON.stringify(verified) !== JSON.stringify(expectedMetadata)) fail("Snapshot discard metadata does not match its verified revision");

  makeTreeWritableForCleanup(paths.revisionRoot);
  try {
    fs.rmSync(paths.revisionRoot, { recursive: true, force: false });
  } catch {
    fail("Verified snapshot revision could not be discarded safely");
  }
  if (!pathDoesNotExist(paths.revisionRoot)) fail("Verified snapshot revision could not be discarded safely");
  discardReceipts.delete(input.capture);
  activePublishedRoots.delete(paths.revisionRoot);
  fsyncDirectory(paths.revisionsRoot);
  if (removeEmptyPrivateDirectory(paths.revisionsRoot) && removeEmptyPrivateDirectory(paths.jobRoot)) {
    if (removeEmptyPrivateDirectory(paths.jobsRoot)) removeEmptyPrivateDirectory(paths.automationRoot);
  }
  return true;
}

export interface ProtectedAutomationSnapshotPurgeStage {
  readonly staged: boolean;
  rollback(): void;
  finalize(): void;
}

/**
 * Verify and atomically move one exact job's private snapshot tree out of its
 * canonical name before the durable store-row purge. The caller either rolls
 * the move back on store failure or finalizes it after commit.
 */
export function stageProtectedAutomationSnapshotJobPurge(input: {
  projectId: string;
  agentProfileId: string;
  jobId: string;
}): ProtectedAutomationSnapshotPurgeStage {
  const projectId = validateIdentity(input.projectId, "project id");
  const agentProfileId = validateIdentity(input.agentProfileId, "agent profile id");
  const jobId = validateIdentity(input.jobId, "job id");
  const automationRoot = path.join(getWayangDataRoot(), SNAPSHOT_ROOT_NAME);
  if (pathDoesNotExist(automationRoot)) return { staged: false, rollback() {}, finalize() {} };
  const paths = storagePaths(projectId, agentProfileId, jobId, 1, false);
  if (pathDoesNotExist(paths.jobRoot)) return { staged: false, rollback() {}, finalize() {} };
  const entries = sortedNames(paths.revisionsRoot, "Private snapshot revisions cannot be enumerated safely");
  for (const revisionName of entries) {
    if (!/^[1-9][0-9]*$/u.test(revisionName)) fail("Private snapshot metadata contains an invalid revision");
    const revisionRoot = path.join(paths.revisionsRoot, revisionName);
    if (activePublishedRoots.has(revisionRoot) || activeTempRoots.has(revisionRoot)) {
      fail("Protected automation snapshot is still active");
    }
    const published = readPublishedSnapshot(revisionRoot, true);
    if (published.manifest.projectId !== projectId || published.manifest.agentProfileId !== agentProfileId
      || published.manifest.jobId !== jobId || published.manifest.revision !== Number(revisionName)) {
      fail("Private snapshot metadata is bound to a different owner or revision");
    }
  }
  const stagedRoot = path.join(paths.jobsRoot, `.purge-${randomUUID()}`);
  fs.renameSync(paths.jobRoot, stagedRoot);
  fsyncDirectory(paths.jobsRoot);
  let state: "staged" | "rolled_back" | "finalized" = "staged";
  return {
    staged: true,
    rollback() {
      if (state !== "staged") return;
      if (!pathDoesNotExist(paths.jobRoot)) fail("Snapshot purge rollback target is occupied");
      fs.renameSync(stagedRoot, paths.jobRoot);
      fsyncDirectory(paths.jobsRoot);
      state = "rolled_back";
    },
    finalize() {
      if (state !== "staged") return;
      validatePrivateDirectory(stagedRoot);
      removeValidatedTree(stagedRoot, "Staged private snapshot job");
      fsyncDirectory(paths.jobsRoot);
      if (sortedNames(paths.jobsRoot, "Private snapshot metadata cannot be enumerated safely").length === 0
        && removeEmptyPrivateDirectory(paths.jobsRoot)) removeEmptyPrivateDirectory(paths.automationRoot);
      state = "finalized";
    },
  };
}
