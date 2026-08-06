import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { getWayangDataRoot } from "../protected-artifacts.js";
import type { ProtectedAutomationJobRow, ProtectedAutomationRunRow } from "./types.js";
import {
  MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_GLOBAL,
  MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_PER_JOB,
  MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_PER_PAIR,
  MAX_PROTECTED_AUTOMATION_STATE_BYTES,
  MAX_PROTECTED_AUTOMATION_STATE_FILES,
  MAX_PROTECTED_AUTOMATION_STDERR_BYTES,
  MAX_PROTECTED_AUTOMATION_STDOUT_BYTES,
} from "./types.js";

const OWNER_NAME = "OWNER.json";
const READY_NAME = "READY.json";
const CURRENT_NAME = "CURRENT";
const MAX_RUNTIME_TREE_ENTRIES = 20_000;

type PublishableStatus = "completed" | "needs_user";
type OwnerKind = "run-scratch" | "run-diagnostics" | "job-state" | "state-generation";

export interface ProtectedAutomationRunStorageIdentity {
  projectId: string;
  agentProfileId: string;
  jobId: string;
  runId: string;
}

export interface ProtectedAutomationRuntimeStorageLimits {
  globalBytes: number;
  pairBytes: number;
  jobBytes: number;
  stateBytes: number;
  stateFiles: number;
}

interface OwnerMarker extends Omit<ProtectedAutomationRunStorageIdentity, "runId"> {
  version: 1;
  kind: OwnerKind;
  runId: string | null;
}

interface TreeUsage { bytes: number; files: number; entries: number }

function opaque(domain: string, id: string): string {
  return createHash("sha256").update(domain).update("\0").update(id).digest("hex");
}

function storageError(message: string): Error {
  return new Error(`Protected automation runtime storage: ${message}`);
}

function runIntentionallyPublishesState(run: ProtectedAutomationRunRow): run is ProtectedAutomationRunRow & { status: PublishableStatus } {
  return run.status === "completed"
    || (run.status === "needs_user" && typeof run.outcome_code === "string" && run.outcome_code.startsWith("needs_user:"));
}

function privateDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw storageError("directory is unsafe");
  fs.chmodSync(directory, 0o700);
}

function fsyncDirectory(directory: string): void {
  const descriptor = fs.openSync(directory, fs.constants.O_RDONLY);
  try { fs.fsyncSync(descriptor); } finally { fs.closeSync(descriptor); }
}

function exactOwner(kind: OwnerKind, identity: ProtectedAutomationRunStorageIdentity): OwnerMarker {
  return { version: 1, kind, ...identity, runId: kind === "job-state" ? null : identity.runId };
}

function exactObject(value: unknown, expectedValue: object): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  const expected = expectedValue as Record<string, unknown>;
  const keys = Object.keys(expected).sort();
  return Object.keys(candidate).sort().join("\0") === keys.join("\0")
    && keys.every((key) => candidate[key] === expected[key]);
}

function writeExclusiveDurable(target: string, bytes: Buffer, mode = 0o400): void {
  const descriptor = fs.openSync(target, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, mode);
  try {
    fs.writeFileSync(descriptor, bytes);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

function requireExactJsonFile(target: string, expected: object): void {
  const metadata = fs.lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4_096
    || (metadata.mode & 0o777) !== 0o400) {
    throw storageError("owner marker is unsafe");
  }
  let decoded: unknown;
  try { decoded = JSON.parse(fs.readFileSync(target, "utf8")); } catch { throw storageError("owner marker is malformed"); }
  if (!exactObject(decoded, expected)) throw storageError("owner marker does not match its exact owner");
}

function ensureOwner(directory: string, marker: OwnerMarker): void {
  privateDirectory(directory);
  const target = path.join(directory, OWNER_NAME);
  try {
    writeExclusiveDurable(target, Buffer.from(JSON.stringify(marker), "utf8"));
    fsyncDirectory(directory);
  } catch (error) {
    if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
  }
  requireExactJsonFile(target, marker);
}

function readOwner(directory: string): OwnerMarker {
  const target = path.join(directory, OWNER_NAME);
  const metadata = fs.lstatSync(target);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size > 4_096
    || (metadata.mode & 0o777) !== 0o400) {
    throw storageError("owner marker is unsafe");
  }
  let marker: unknown;
  try { marker = JSON.parse(fs.readFileSync(target, "utf8")); } catch { throw storageError("owner marker is malformed"); }
  if (!marker || typeof marker !== "object" || Array.isArray(marker)) throw storageError("owner marker is malformed");
  const candidate = marker as Record<string, unknown>;
  if (Object.keys(candidate).sort().join("\0") !== ["agentProfileId", "jobId", "kind", "projectId", "runId", "version"].sort().join("\0")
    || candidate.version !== 1 || !["run-scratch", "run-diagnostics", "job-state", "state-generation"].includes(String(candidate.kind))
    || typeof candidate.projectId !== "string" || typeof candidate.agentProfileId !== "string" || typeof candidate.jobId !== "string"
    || !candidate.projectId || !candidate.agentProfileId || !candidate.jobId
    || (candidate.kind === "job-state" ? candidate.runId !== null : typeof candidate.runId !== "string" || !candidate.runId)) {
    throw storageError("owner marker is malformed");
  }
  return candidate as unknown as OwnerMarker;
}

function usageOf(root: string, stateBounds = false): TreeUsage {
  const usage: TreeUsage = { bytes: 0, files: 0, entries: 0 };
  if (!fs.existsSync(root)) return usage;
  const visit = (target: string): void => {
    const metadata = fs.lstatSync(target);
    usage.entries += 1;
    if (usage.entries > MAX_RUNTIME_TREE_ENTRIES) throw storageError("tree entry bound exceeded");
    if (metadata.isSymbolicLink()) throw storageError("tree contains a symlink");
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(target)) visit(path.join(target, name));
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) throw storageError("tree contains a special or multiply-linked file");
    usage.files += 1;
    usage.bytes += metadata.size;
    if (stateBounds && (usage.files > MAX_PROTECTED_AUTOMATION_STATE_FILES
      || usage.bytes > MAX_PROTECTED_AUTOMATION_STATE_BYTES)) {
      throw storageError("persistent state exceeds its compiled bound");
    }
  };
  visit(root);
  return usage;
}

function fsyncTree(root: string): void {
  const visit = (entry: string): void => {
    const metadata = fs.lstatSync(entry);
    if (metadata.isSymbolicLink()) throw storageError("state contains a symlink");
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
      fsyncDirectory(entry);
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) throw storageError("state contains an unsafe file");
    const descriptor = fs.openSync(entry, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    try {
      const opened = fs.fstatSync(descriptor);
      if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
        throw storageError("state changed while becoming durable");
      }
      fs.fsyncSync(descriptor);
    } finally { fs.closeSync(descriptor); }
  };
  visit(root);
}

function copyStateTree(source: string, destination: string): void {
  privateDirectory(destination);
  const visit = (from: string, to: string): void => {
    for (const name of fs.readdirSync(from)) {
      const sourcePath = path.join(from, name);
      const destinationPath = path.join(to, name);
      const metadata = fs.lstatSync(sourcePath);
      if (metadata.isSymbolicLink()) throw storageError("published state contains a symlink");
      if (metadata.isDirectory()) {
        privateDirectory(destinationPath);
        visit(sourcePath, destinationPath);
        continue;
      }
      if (!metadata.isFile() || metadata.nlink !== 1) throw storageError("published state contains an unsafe file");
      const sourceDescriptor = fs.openSync(sourcePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      let destinationDescriptor = -1;
      try {
        const opened = fs.fstatSync(sourceDescriptor);
        if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== metadata.dev || opened.ino !== metadata.ino) {
          throw storageError("published state changed during copy");
        }
        destinationDescriptor = fs.openSync(destinationPath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | (fs.constants.O_NOFOLLOW ?? 0), 0o600);
        const buffer = Buffer.allocUnsafe(64 * 1024);
        let copied = 0;
        while (true) {
          const count = fs.readSync(sourceDescriptor, buffer, 0, buffer.length, null);
          if (count === 0) break;
          copied += count;
          if (copied > MAX_PROTECTED_AUTOMATION_STATE_BYTES) throw storageError("persistent state exceeds its compiled bound");
          let offset = 0;
          while (offset < count) offset += fs.writeSync(destinationDescriptor, buffer, offset, count - offset);
        }
        if (copied !== opened.size) throw storageError("published state changed during copy");
        fs.fsyncSync(destinationDescriptor);
      } finally {
        if (destinationDescriptor >= 0) fs.closeSync(destinationDescriptor);
        fs.closeSync(sourceDescriptor);
      }
    }
  };
  visit(source, destination);
  usageOf(destination, true);
}

function strictRemove(target: string): void {
  const unlock = (entry: string): void => {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(entry); } catch (failure: any) {
      if (failure?.code === "ENOENT") return;
      throw failure;
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
    fs.chmodSync(entry, 0o700);
    for (const name of fs.readdirSync(entry)) unlock(path.join(entry, name));
  };
  if (!fs.existsSync(target)) return;
  unlock(target);
  fs.rmSync(target, { recursive: true, force: false });
  if (fs.existsSync(target)) throw storageError("private artifact cleanup is incomplete");
}

function safeRemove(target: string): void {
  const unlock = (entry: string): void => {
    let metadata: fs.Stats;
    try { metadata = fs.lstatSync(entry); } catch { return; }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) return;
    try { fs.chmodSync(entry, 0o700); } catch { return; }
    for (const name of fs.readdirSync(entry)) unlock(path.join(entry, name));
  };
  try { unlock(target); fs.rmSync(target, { recursive: true, force: true }); } catch { /* cleanup is reconciled on startup */ }
}

function freezeGeneration(root: string): void {
  const visit = (entry: string): void => {
    const metadata = fs.lstatSync(entry);
    if (metadata.isSymbolicLink()) throw storageError("generation contains a symlink");
    if (metadata.isDirectory()) {
      for (const name of fs.readdirSync(entry)) visit(path.join(entry, name));
      fs.chmodSync(entry, 0o500);
      return;
    }
    if (!metadata.isFile() || metadata.nlink !== 1) throw storageError("generation contains an unsafe file");
    fs.chmodSync(entry, 0o400);
  };
  visit(root);
}

function removeExactOwned(directory: string, marker: OwnerMarker): void {
  if (!fs.existsSync(directory)) return;
  try {
    requireExactJsonFile(path.join(directory, OWNER_NAME), marker);
    safeRemove(directory);
  } catch { /* owner mismatch is never deleted through an attributed cleanup */ }
}

function removeExactOwnedStrict(directory: string, marker: OwnerMarker): void {
  if (!fs.existsSync(directory)) return;
  requireExactJsonFile(path.join(directory, OWNER_NAME), marker);
  strictRemove(directory);
  if (fs.existsSync(directory)) throw storageError("exact private artifact remains after retirement");
}

function identityFor(job: ProtectedAutomationJobRow, run: ProtectedAutomationRunRow): ProtectedAutomationRunStorageIdentity {
  return { projectId: job.project_id, agentProfileId: job.agent_profile_id, jobId: job.id, runId: run.id };
}

export class ProtectedAutomationRuntimeStorage {
  readonly root: string;
  private readonly limits: ProtectedAutomationRuntimeStorageLimits;
  private readonly deferredJobs = new Map<string, Omit<ProtectedAutomationRunStorageIdentity, "runId">>();

  constructor(options: { root?: string; limits?: Partial<ProtectedAutomationRuntimeStorageLimits> } = {}) {
    this.root = options.root ?? path.join(getWayangDataRoot(), "protected-automation", "runtime");
    this.limits = {
      globalBytes: options.limits?.globalBytes ?? MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_GLOBAL,
      pairBytes: options.limits?.pairBytes ?? MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_PER_PAIR,
      jobBytes: options.limits?.jobBytes ?? MAX_PROTECTED_AUTOMATION_RUNTIME_BYTES_PER_JOB,
      stateBytes: options.limits?.stateBytes ?? MAX_PROTECTED_AUTOMATION_STATE_BYTES,
      stateFiles: options.limits?.stateFiles ?? MAX_PROTECTED_AUTOMATION_STATE_FILES,
    };
  }

  private runDirectory(identity: ProtectedAutomationRunStorageIdentity): string {
    return path.join(this.root, "runs", opaque("run-v1", identity.runId));
  }
  private diagnosticsDirectory(identity: ProtectedAutomationRunStorageIdentity): string {
    return path.join(this.root, "diagnostics", opaque("run-v1", identity.runId));
  }
  private jobStateDirectory(identity: Pick<ProtectedAutomationRunStorageIdentity, "jobId">): string {
    return path.join(this.root, "state", opaque("job-v1", identity.jobId));
  }
  private stageDirectory(identity: ProtectedAutomationRunStorageIdentity): string {
    return path.join(this.jobStateDirectory(identity), "stages", opaque("run-v1", identity.runId));
  }
  private generationDirectory(identity: ProtectedAutomationRunStorageIdentity): string {
    return path.join(this.jobStateDirectory(identity), "generations", opaque("run-v1", identity.runId));
  }

  private initialize(): void {
    privateDirectory(this.root);
    for (const name of ["runs", "diagnostics", "state"]) privateDirectory(path.join(this.root, name));
  }

  private ensureJobState(identity: ProtectedAutomationRunStorageIdentity): string {
    const directory = this.jobStateDirectory(identity);
    ensureOwner(directory, exactOwner("job-state", identity));
    privateDirectory(path.join(directory, "stages"));
    privateDirectory(path.join(directory, "generations"));
    return directory;
  }

  private currentGeneration(identity: Pick<ProtectedAutomationRunStorageIdentity, "jobId">): string | null {
    const state = this.jobStateDirectory(identity);
    const current = path.join(state, CURRENT_NAME);
    if (!fs.existsSync(current)) return null;
    const metadata = fs.lstatSync(current);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== 64
      || (metadata.mode & 0o777) !== 0o600) {
      throw storageError("CURRENT is unsafe");
    }
    const value = fs.readFileSync(current, "utf8");
    if (!/^[a-f0-9]{64}$/u.test(value)) throw storageError("CURRENT is malformed");
    const generation = path.join(state, "generations", value);
    const generationMetadata = fs.lstatSync(generation);
    if (!generationMetadata.isDirectory() || generationMetadata.isSymbolicLink()) throw storageError("CURRENT generation is unsafe");
    const marker = readOwner(generation);
    if (marker.kind !== "state-generation" || marker.jobId !== identity.jobId || typeof marker.runId !== "string"
      || path.basename(generation) !== opaque("run-v1", marker.runId)) throw storageError("CURRENT generation owner is invalid");
    return generation;
  }

  prepareRun(job: ProtectedAutomationJobRow, run: ProtectedAutomationRunRow): { runRoot: string; stateRoot: string } {
    this.initialize();
    const identity = identityFor(job, run);
    const runDirectory = this.runDirectory(identity);
    ensureOwner(runDirectory, exactOwner("run-scratch", identity));
    const runRoot = path.join(runDirectory, "scratch");
    privateDirectory(runRoot);

    const state = this.ensureJobState(identity);
    const stage = this.stageDirectory(identity);
    ensureOwner(stage, exactOwner("state-generation", identity));
    const stateRoot = path.join(stage, "data");
    if (!fs.existsSync(stateRoot)) {
      const current = this.currentGeneration(identity);
      if (current) {
        const currentOwner = readOwner(current);
        if (currentOwner.projectId !== identity.projectId || currentOwner.agentProfileId !== identity.agentProfileId
          || currentOwner.jobId !== identity.jobId) throw storageError("CURRENT generation exact owner is invalid");
        copyStateTree(path.join(current, "data"), stateRoot);
      } else privateDirectory(stateRoot);
    }
    usageOf(stateRoot, true);
    this.assertQuotas(identity);
    fsyncDirectory(state);
    return { runRoot, stateRoot };
  }

  persistDiagnostics(identity: ProtectedAutomationRunStorageIdentity, stdout: Buffer, stderr: Buffer): void {
    if (stdout.length > MAX_PROTECTED_AUTOMATION_STDOUT_BYTES || stderr.length > MAX_PROTECTED_AUTOMATION_STDERR_BYTES) {
      throw storageError("diagnostics exceed their compiled bound");
    }
    this.initialize();
    const directory = this.diagnosticsDirectory(identity);
    ensureOwner(directory, exactOwner("run-diagnostics", identity));
    for (const [name, bytes] of [["stdout.log", stdout], ["stderr.log", stderr]] as const) {
      const target = path.join(directory, name);
      try { writeExclusiveDurable(target, bytes, 0o600); }
      catch (error) {
        if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
        const metadata = fs.lstatSync(target);
        if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1
          || !fs.readFileSync(target).equals(bytes)) throw storageError("diagnostics collision or replacement");
      }
    }
    fsyncDirectory(directory);
    this.assertQuotas(identity);
  }

  sealState(identity: ProtectedAutomationRunStorageIdentity, status: PublishableStatus): void {
    const stage = this.stageDirectory(identity);
    requireExactJsonFile(path.join(stage, OWNER_NAME), exactOwner("state-generation", identity));
    const stateData = path.join(stage, "data");
    const usage = usageOf(stateData, true);
    if (usage.files > this.limits.stateFiles || usage.bytes > this.limits.stateBytes) throw storageError("state quota exceeded");
    fsyncTree(stateData);
    const expected = { version: 1, status, runId: identity.runId };
    const ready = path.join(stage, READY_NAME);
    try { writeExclusiveDurable(ready, Buffer.from(JSON.stringify(expected), "utf8")); }
    catch (error) {
      if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST")) throw error;
    }
    requireExactJsonFile(ready, expected);
    fsyncDirectory(stage);
    this.assertQuotas(identity);
  }

  publishState(identity: ProtectedAutomationRunStorageIdentity, status: PublishableStatus): void {
    const state = this.ensureJobState(identity);
    const stage = this.stageDirectory(identity);
    const generation = this.generationDirectory(identity);
    let source = fs.existsSync(stage) ? stage : generation;
    requireExactJsonFile(path.join(source, OWNER_NAME), exactOwner("state-generation", identity));
    requireExactJsonFile(path.join(source, READY_NAME), { version: 1, status, runId: identity.runId });
    usageOf(path.join(source, "data"), true);
    this.assertQuotas(identity);
    if (source === stage) {
      if (fs.existsSync(generation)) throw storageError("state generation already exists");
      fs.renameSync(stage, generation);
      fsyncDirectory(path.join(state, "stages"));
      fsyncDirectory(path.join(state, "generations"));
      source = generation;
    }
    freezeGeneration(source);
    const generationName = path.basename(source);
    const temporary = path.join(state, `.CURRENT.${process.pid}.${Date.now()}`);
    writeExclusiveDurable(temporary, Buffer.from(generationName, "utf8"), 0o600);
    fs.renameSync(temporary, path.join(state, CURRENT_NAME));
    fsyncDirectory(state);
    for (const name of fs.readdirSync(path.join(state, "generations"))) {
      if (name !== generationName) safeRemove(path.join(state, "generations", name));
    }
  }

  discardStagedState(identity: ProtectedAutomationRunStorageIdentity): void {
    removeExactOwned(this.stageDirectory(identity), exactOwner("state-generation", identity));
  }

  cleanupRunScratch(identity: ProtectedAutomationRunStorageIdentity): void {
    removeExactOwned(this.runDirectory(identity), exactOwner("run-scratch", identity));
  }

  retireRun(identity: ProtectedAutomationRunStorageIdentity): void {
    this.cleanupRunScratch(identity);
    removeExactOwned(this.diagnosticsDirectory(identity), exactOwner("run-diagnostics", identity));
    this.discardStagedState(identity);
    const generation = this.generationDirectory(identity);
    const current = (() => { try { return this.currentGeneration(identity); } catch { return null; } })();
    if (current !== generation) removeExactOwned(generation, exactOwner("state-generation", identity));
  }

  retireJob(
    identity: Omit<ProtectedAutomationRunStorageIdentity, "runId">,
    activeRunIds: ReadonlySet<string>,
    knownRunIds: readonly string[] = [],
  ): boolean {
    if (activeRunIds.size > 0) {
      this.deferredJobs.set(identity.jobId, identity);
      return false;
    }
    const jobState = this.jobStateDirectory(identity);
    removeExactOwnedStrict(jobState, {
      version: 1, kind: "job-state", projectId: identity.projectId,
      agentProfileId: identity.agentProfileId, jobId: identity.jobId, runId: null,
    });
    for (const runId of new Set(knownRunIds)) {
      const runIdentity = { ...identity, runId };
      removeExactOwnedStrict(this.runDirectory(runIdentity), exactOwner("run-scratch", runIdentity));
      removeExactOwnedStrict(this.diagnosticsDirectory(runIdentity), exactOwner("run-diagnostics", runIdentity));
    }
    // Normal retention paths may not carry historical run IDs. Remove any
    // additional correctly attributed artifacts, but never swallow a failure
    // after an exact owner match.
    for (const category of ["runs", "diagnostics"] as const) {
      const root = path.join(this.root, category);
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        const directory = path.join(root, name);
        let marker: OwnerMarker;
        try { marker = readOwner(directory); } catch {
          throw storageError("runtime artifact owner is unreadable during retirement");
        }
        const expectedKind = category === "runs" ? "run-scratch" : "run-diagnostics";
        if (marker.kind === expectedKind && typeof marker.runId === "string" && name === opaque("run-v1", marker.runId)
          && marker.jobId === identity.jobId && marker.projectId === identity.projectId
          && marker.agentProfileId === identity.agentProfileId) strictRemove(directory);
      }
    }
    if (fs.existsSync(jobState) || knownRunIds.some((runId) => this.hasRunStorage(runId))) {
      throw storageError("job retirement left residual private artifacts");
    }
    this.deferredJobs.delete(identity.jobId);
    return true;
  }

  flushDeferred(activeRunIdsForJob: (jobId: string) => ReadonlySet<string>): void {
    for (const identity of this.deferredJobs.values()) this.retireJob(identity, activeRunIdsForJob(identity.jobId));
  }

  hasRunStorage(runId: string): boolean {
    const name = opaque("run-v1", runId);
    if (fs.existsSync(path.join(this.root, "runs", name)) || fs.existsSync(path.join(this.root, "diagnostics", name))) return true;
    const stateRoot = path.join(this.root, "state");
    if (!fs.existsSync(stateRoot)) return false;
    for (const jobName of fs.readdirSync(stateRoot)) {
      const jobState = path.join(stateRoot, jobName);
      if (fs.existsSync(path.join(jobState, "stages", name)) || fs.existsSync(path.join(jobState, "generations", name))) return true;
    }
    return false;
  }

  reconcile(
    jobs: readonly ProtectedAutomationJobRow[],
    runs: readonly ProtectedAutomationRunRow[],
    canPublish: (job: ProtectedAutomationJobRow, run: ProtectedAutomationRunRow) => boolean = (job, run) => (
      job.enabled && job.deleted_at === null && job.revision === run.job_revision
      && job.capability_revision === run.capability_revision
    ),
  ): void {
    this.initialize();
    const jobsById = new Map(jobs.map((job) => [job.id, job]));
    const runsById = new Map(runs.map((run) => [run.id, run]));
    for (const category of ["runs", "diagnostics"] as const) {
      const categoryRoot = path.join(this.root, category);
      for (const name of fs.readdirSync(categoryRoot)) {
        const directory = path.join(categoryRoot, name);
        let marker: OwnerMarker | null = null;
        try { marker = readOwner(directory); } catch { /* remove below */ }
        const row = marker && typeof marker.runId === "string" ? runsById.get(marker.runId) : undefined;
        const job = row ? jobsById.get(row.job_id) : undefined;
        const expected = row && job ? exactOwner(category === "runs" ? "run-scratch" : "run-diagnostics", identityFor(job, row)) : null;
        try { if (!expected || !marker || !exactObject(marker, expected)) throw storageError("orphan artifact"); }
        catch { strictRemove(directory); continue; }
        if (category === "runs" || row!.status === "queued" || row!.status === "running") strictRemove(directory);
      }
    }
    const stateRoot = path.join(this.root, "state");
    for (const name of fs.readdirSync(stateRoot)) {
      const state = path.join(stateRoot, name);
      let marker: OwnerMarker | null = null;
      try { marker = readOwner(state); } catch { /* remove below */ }
      const job = marker ? jobsById.get(marker.jobId) : undefined;
      const expectedJobOwner = job ? exactOwner("job-state", {
        projectId: job.project_id, agentProfileId: job.agent_profile_id, jobId: job.id, runId: "unused",
      }) : null;
      if (!marker || !job || !expectedJobOwner || !exactObject(marker, expectedJobOwner)
        || name !== opaque("job-v1", job.id)) { strictRemove(state); continue; }
      for (const entryName of fs.readdirSync(state)) {
        if (entryName.startsWith(".CURRENT.")) strictRemove(path.join(state, entryName));
      }
      const stages = path.join(state, "stages");
      if (fs.existsSync(stages)) for (const stageName of fs.readdirSync(stages)) {
        const stage = path.join(stages, stageName);
        let stageMarker: OwnerMarker | null = null;
        try { stageMarker = readOwner(stage); } catch { /* discard */ }
        const run = stageMarker && typeof stageMarker.runId === "string" ? runsById.get(stageMarker.runId) : undefined;
        const expectedStage = run ? exactOwner("state-generation", identityFor(job, run)) : null;
        if (!stageMarker || !run || run.job_id !== job.id || !expectedStage || !exactObject(stageMarker, expectedStage)
          || stageName !== opaque("run-v1", run.id)) { strictRemove(stage); continue; }
        const identity = identityFor(job, run);
        if (runIntentionallyPublishesState(run) && canPublish(job, run)) {
          try { this.publishState(identity, run.status); } catch { /* sealed stage remains retryable */ }
        } else strictRemove(stage);
      }
      const generations = path.join(state, "generations");
      if (!fs.existsSync(generations)) continue;
      let currentName: string | null = null;
      try { currentName = path.basename(this.currentGeneration({ jobId: job.id }) ?? "") || null; }
      catch { continue; }
      if (!currentName) {
        const candidates = fs.readdirSync(generations).map((generationName) => {
          let generationMarker: OwnerMarker | null = null;
          try { generationMarker = readOwner(path.join(generations, generationName)); }
          catch { /* not publishable */ }
          const run = generationMarker && typeof generationMarker.runId === "string" ? runsById.get(generationMarker.runId) : undefined;
          return { generationName, generationMarker, run };
        }).filter((candidate) => candidate.run && runIntentionallyPublishesState(candidate.run)
          && canPublish(job, candidate.run))
          .sort((left, right) => (right.run!.finished_at ?? 0) - (left.run!.finished_at ?? 0));
        const candidate = candidates[0];
        if (candidate?.run && candidate.generationMarker) {
          const candidateIdentity = identityFor(job, candidate.run);
          if (candidate.generationName === opaque("run-v1", candidate.run.id)
            && exactObject(candidate.generationMarker, exactOwner("state-generation", candidateIdentity))) {
            try { this.publishState(candidateIdentity, candidate.run.status as PublishableStatus); currentName = candidate.generationName; }
            catch { /* retry on next startup */ }
          }
        }
      }
      if (currentName) for (const generationName of fs.readdirSync(generations)) {
        if (generationName !== currentName) strictRemove(path.join(generations, generationName));
      }
    }
  }

  private assertQuotas(identity: ProtectedAutomationRunStorageIdentity): void {
    const global = usageOf(this.root).bytes;
    let pair = 0;
    let job = 0;
    for (const category of ["runs", "diagnostics", "state"] as const) {
      const root = path.join(this.root, category);
      if (!fs.existsSync(root)) continue;
      for (const name of fs.readdirSync(root)) {
        const directory = path.join(root, name);
        let marker: OwnerMarker;
        try { marker = readOwner(directory); }
        catch { throw storageError("runtime artifact has no valid owner marker"); }
        const expectedKind = category === "runs" ? "run-scratch" : category === "diagnostics" ? "run-diagnostics" : "job-state";
        if (marker.kind !== expectedKind
          || (category === "state" ? name !== opaque("job-v1", marker.jobId)
            : typeof marker.runId !== "string" || name !== opaque("run-v1", marker.runId))) {
          throw storageError("runtime artifact owner marker is inconsistent");
        }
        const bytes = usageOf(directory).bytes;
        if (marker.projectId === identity.projectId && marker.agentProfileId === identity.agentProfileId) pair += bytes;
        if (marker.jobId === identity.jobId) job += bytes;
      }
    }
    if (global > this.limits.globalBytes || pair > this.limits.pairBytes || job > this.limits.jobBytes) {
      throw storageError("global, pair, or job quota exceeded");
    }
  }
}

export function retireProtectedAutomationRunStorage(identity: ProtectedAutomationRunStorageIdentity): void {
  try { new ProtectedAutomationRuntimeStorage().retireRun(identity); } catch { /* durable pruning must not be rolled back by cleanup */ }
}
