import * as fs from "node:fs";
import * as path from "node:path";
import { getStore } from "../db.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import {
  claimBrowserProfileCleanupAttempt,
  claimBrowserProfilePurgeAttempt,
  markBrowserProfileCleanupFailed,
  markBrowserProfilePurged,
  markBrowserProfileRestored,
  markBrowserProfileTrashed,
} from "./profile-catalog.js";
import { resolveBrowserProfileStorageDescriptor } from "./profile-storage-registry.js";
import type { StandardBrowserProfileHostService } from "./standard-service.js";

function fsyncDirectory(directory: string): void {
  const fd = fs.openSync(directory, fs.constants.O_RDONLY | (fs.constants.O_DIRECTORY ?? 0));
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

function safeDirectory(directory: string): void {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error("Browser Profile recovery directory is unsafe");
  }
  fs.chmodSync(directory, 0o700);
}

function pathWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function existingDirectory(candidate: string): fs.Stats | null {
  try {
    const stat = fs.lstatSync(candidate);
    if (!stat.isDirectory() || stat.isSymbolicLink()
      || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
      throw new Error("Browser Profile cleanup payload is unsafe");
    }
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

function reconcileRename(source: string, destination: string, allowBothAbsent = true): void {
  const sourceStat = existingDirectory(source);
  const destinationStat = existingDirectory(destination);
  if (sourceStat && destinationStat) throw new Error("Browser Profile cleanup found both live and recovery payloads");
  if (!sourceStat) {
    if (!destinationStat && !allowBothAbsent) throw new Error("Browser Profile recovery payload is missing");
    if (!destinationStat && allowBothAbsent) safeDirectory(destination);
    return; // already moved or a never-materialized profile now has an empty recovery payload
  }
  safeDirectory(path.dirname(destination));
  try { fs.renameSync(source, destination); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EXDEV") throw new Error("Browser Profile recovery requires one filesystem");
    throw error;
  }
  const moved = existingDirectory(destination);
  if (!moved || moved.dev !== sourceStat.dev || moved.ino !== sourceStat.ino) {
    throw new Error("Browser Profile cleanup could not verify its atomic move");
  }
  fsyncDirectory(path.dirname(source));
  fsyncDirectory(path.dirname(destination));
}

export class BrowserProfileCleanupCoordinator {
  private readonly tails = new Map<string, Promise<void>>();
  private retryTimer: NodeJS.Timeout | null = null;
  private closed = false;

  constructor(
    private readonly dataDir: string,
    private readonly service?: StandardBrowserProfileHostService,
  ) {}

  start(): void {
    if (this.closed || this.retryTimer) return;
    void this.resumePending();
    this.retryTimer = setInterval(() => { void this.resumePending(); }, 60_000);
    this.retryTimer.unref();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.retryTimer) clearInterval(this.retryTimer);
    this.retryTimer = null;
    await Promise.allSettled([...this.tails.values()]);
  }

  private serialize<T>(profileId: string, operation: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new Error("Browser Profile cleanup coordinator is closed"));
    const prior = this.tails.get(profileId) ?? Promise.resolve();
    let release!: () => void;
    const tail = new Promise<void>((resolve) => { release = resolve; });
    this.tails.set(profileId, tail);
    return prior.catch(() => undefined).then(operation).finally(() => {
      release();
      if (this.tails.get(profileId) === tail) this.tails.delete(profileId);
    });
  }

  private recoveryPath(recoveryEntryId: string): string {
    const base = fs.realpathSync.native(path.resolve(this.dataDir));
    const recoveryRoot = path.join(base, "browser-profiles", "v1", "recovery");
    safeDirectory(recoveryRoot);
    const candidate = path.join(recoveryRoot, recoveryEntryId, "profile");
    if (!pathWithin(recoveryRoot, candidate)) throw new Error("Browser Profile recovery escaped its private root");
    return candidate;
  }

  async executeTrash(profileId: string, cleanupId: string): Promise<void> {
    await this.serialize(profileId, async () => {
      await this.service?.invalidateProfile(profileId);
      const attempt = claimBrowserProfileCleanupAttempt(profileId, cleanupId);
      try {
        const profile = getStore().browserProfiles.find((candidate) => candidate.id === profileId);
        if (!profile || profile.state !== "trash_pending" || attempt.recovery_entry_id === null) {
          throw new WorkspaceStoreError("Browser Profile cleanup subject changed", 409);
        }
        const descriptor = resolveBrowserProfileStorageDescriptor(this.dataDir, profile);
        if (descriptor.identityDigest !== attempt.storage_identity_digest) throw new Error("Browser Profile cleanup identity changed");
        reconcileRename(descriptor.root, this.recoveryPath(attempt.recovery_entry_id));
        markBrowserProfileTrashed(profileId, cleanupId);
      } catch (error) {
        try { markBrowserProfileCleanupFailed(profileId, cleanupId); } catch { /* retain original failure */ }
        throw error;
      }
    });
  }

  async restore(profileId: string, expectedRevision: number): Promise<void> {
    await this.serialize(profileId, async () => {
      await this.service?.invalidateProfile(profileId);
      const store = getStore();
      const profile = store.browserProfiles.find((candidate) => candidate.id === profileId);
      const cleanup = [...store.browserCleanups].reverse().find((candidate) => candidate.profile_id === profileId
        && candidate.subject_kind === "profile" && candidate.state === "verified" && candidate.recovery_entry_id !== null);
      if (!profile || !cleanup || profile.state !== "trashed") throw new WorkspaceStoreError("Browser Profile is not restorable", 409);
      const descriptor = resolveBrowserProfileStorageDescriptor(this.dataDir, profile);
      reconcileRename(this.recoveryPath(cleanup.recovery_entry_id!), descriptor.root, false);
      markBrowserProfileRestored(profileId, cleanup.id, expectedRevision);
    });
  }

  async purge(profileId: string, cleanupId: string): Promise<void> {
    await this.serialize(profileId, async () => {
      await this.service?.invalidateProfile(profileId);
      claimBrowserProfilePurgeAttempt(profileId, cleanupId);
      try {
        const profile = getStore().browserProfiles.find((candidate) => candidate.id === profileId);
        const cleanup = getStore().browserCleanups.find((candidate) => candidate.id === cleanupId && candidate.profile_id === profileId);
        if (!profile || profile.state !== "purge_pending" || !cleanup?.recovery_entry_id) {
          throw new WorkspaceStoreError("Browser Profile purge subject changed", 409);
        }
        const recoveryPath = this.recoveryPath(cleanup.recovery_entry_id);
        const recoveryRoot = path.dirname(recoveryPath);
        const payload = existingDirectory(recoveryPath);
        if (payload) fs.rmSync(recoveryPath, { recursive: true, force: false });
        if (existingDirectory(recoveryPath)) throw new Error("Browser Profile purge could not verify removal");
        try { fs.rmdirSync(recoveryRoot); } catch (error) {
          if (!["ENOENT", "ENOTEMPTY"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
        }
        fsyncDirectory(path.dirname(recoveryRoot));
        markBrowserProfilePurged(profileId, cleanupId);
      } catch (error) {
        try { markBrowserProfileCleanupFailed(profileId, cleanupId); } catch { /* retain original failure */ }
        throw error;
      }
    });
  }

  async resumePending(): Promise<void> {
    if (this.closed) return;
    const pending = getStore().browserCleanups.filter((cleanup) => cleanup.subject_kind === "profile"
      && ["pending", "cleanup_failed"].includes(cleanup.state) && cleanup.attempts < 10);
    for (const cleanup of pending) {
      const profile = getStore().browserProfiles.find((candidate) => candidate.id === cleanup.profile_id);
      if (profile?.state === "purge_pending") await this.purge(cleanup.profile_id, cleanup.id).catch(() => undefined);
      else await this.executeTrash(cleanup.profile_id, cleanup.id).catch(() => undefined);
    }
  }
}
