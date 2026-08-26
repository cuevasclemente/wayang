import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "../config.js";
import { getStore } from "../db.js";
import { isLegacyPrivateSessionQuarantined } from "../sessions.js";
import {
  authorizeProjectAction,
  buildProjectPolicyProjection,
  canonicalizePolicyPath,
  getPolicyGeneration,
  onPolicyChanged,
} from "../policy.js";

export const DREAM_POLICY_PROJECTION_FILE = "project-access-policy.json";

export interface DreamPolicyProjection {
  schema_version: 1;
  generation: number;
  complete: true;
  source_store: {
    size: number;
    mtime_ms: number;
    ctime_ms: number;
    ino: number;
  };
  projects: ReturnType<typeof buildProjectPolicyProjection>["projects"];
  sessions: Array<{
    session_id: string;
    path: string;
    cwd: string;
    dream: boolean;
    agent_profile_id: string | null;
  }>;
}

interface ProjectionFileFingerprint {
  dev: number;
  ino: number;
  size: number;
  mtime_ms: number;
  ctime_ms: number;
  mode: number;
  nlink: number;
  uid: number;
}

export class DreamPolicyProjectionUnavailableError extends Error {
  constructor(cause: unknown) {
    super("Current Dream policy projection could not be durably published", { cause });
    this.name = "DreamPolicyProjectionUnavailableError";
  }
}

let unsubscribe: (() => void) | null = null;
let storeWatcher: fs.FSWatcher | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let lastPublished: {
  destination: string;
  projection: DreamPolicyProjection;
  file: ProjectionFileFingerprint;
} | null = null;

function currentStoreFingerprint(): DreamPolicyProjection["source_store"] {
  const storeStat = fs.statSync(path.join(getConfig().dataDir, "store.json"));
  return {
    size: storeStat.size,
    mtime_ms: storeStat.mtimeMs,
    ctime_ms: storeStat.ctimeMs,
    ino: Number(storeStat.ino) || 0,
  };
}

function storeFingerprintsEqual(
  left: DreamPolicyProjection["source_store"],
  right: DreamPolicyProjection["source_store"],
): boolean {
  return left.size === right.size
    && left.mtime_ms === right.mtime_ms
    && left.ctime_ms === right.ctime_ms
    && left.ino === right.ino;
}

function currentProjectionFileFingerprint(destination: string): ProjectionFileFingerprint {
  const stat = fs.lstatSync(destination);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o077) !== 0) {
    throw new Error("Dream policy projection must remain a private single-link regular file");
  }
  return {
    dev: Number(stat.dev) || 0,
    ino: Number(stat.ino) || 0,
    size: stat.size,
    mtime_ms: stat.mtimeMs,
    ctime_ms: stat.ctimeMs,
    mode: stat.mode,
    nlink: stat.nlink,
    uid: stat.uid,
  };
}

function projectionFileFingerprintsEqual(
  left: ProjectionFileFingerprint,
  right: ProjectionFileFingerprint,
): boolean {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.size === right.size
    && left.mtime_ms === right.mtime_ms
    && left.ctime_ms === right.ctime_ms
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.uid === right.uid;
}

function publishedProjectionFileIsCurrent(
  destination: string,
  fingerprint: ProjectionFileFingerprint,
): boolean {
  try {
    return projectionFileFingerprintsEqual(
      fingerprint,
      currentProjectionFileFingerprint(destination),
    );
  } catch {
    return false;
  }
}

export function getDreamPolicyProjectionPath(): string {
  return path.join(getConfig().dataDir, DREAM_POLICY_PROJECTION_FILE);
}

export function buildDreamPolicyProjection(): DreamPolicyProjection {
  const projectProjection = buildProjectPolicyProjection();
  const sessions = getStore().sessions
    .filter((session) => typeof session.pi_session_file === "string" && session.pi_session_file.length > 0)
    .map((session) => {
      let canonicalPath: string;
      try {
        canonicalPath = canonicalizePolicyPath(session.pi_session_file!, { cwd: "/" });
      } catch {
        canonicalPath = path.resolve(session.pi_session_file!);
      }
      const decision = authorizeProjectAction({
        cwd: session.cwd,
        actor: "dream",
        agentProfileId: session.agent_profile_id ?? null,
      });
      return {
        session_id: session.id,
        path: canonicalPath,
        cwd: session.cwd,
        dream: decision.allowed && !isLegacyPrivateSessionQuarantined(session),
        agent_profile_id: session.agent_profile_id ?? null,
      };
    })
    .sort((a, b) => a.path.localeCompare(b.path) || a.session_id.localeCompare(b.session_id));
  return {
    schema_version: 1,
    generation: projectProjection.generation,
    complete: true,
    source_store: currentStoreFingerprint(),
    projects: projectProjection.projects,
    sessions,
  };
}

/** Atomically publish one complete, metadata-only decision snapshot. */
export function writeDreamPolicyProjection(): DreamPolicyProjection {
  const projection = buildDreamPolicyProjection();
  const destination = getDreamPolicyProjectionPath();
  const directory = path.dirname(destination);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { fs.chmodSync(directory, 0o700); } catch { /* existing parent may be managed externally */ }
  const temporary = `${destination}.${process.pid}.${Date.now()}.tmp`;
  let fd: number | null = null;
  let created = false;
  try {
    fd = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    created = true;
    fs.writeFileSync(fd, `${JSON.stringify(projection, null, 2)}\n`, "utf8");
    fs.fsyncSync(fd);
    fs.fchmodSync(fd, 0o600);
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(temporary, destination);
    fs.chmodSync(destination, 0o600);
    try {
      const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY);
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch { /* directory fsync is not portable to every supported filesystem */ }
    lastPublished = {
      destination,
      projection,
      file: currentProjectionFileFingerprint(destination),
    };
    return projection;
  } finally {
    if (fd !== null) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
    if (created) {
      try { fs.unlinkSync(temporary); } catch { /* renamed or best effort */ }
    }
  }
}

/**
 * Reuse only the exact durable projection published by this process for the
 * current data directory, store inode/fingerprint, and policy generation.
 * Indexing keeps this freshness gate per attempt without rebuilding and
 * fsyncing the complete session projection for every unchanged session.
 */
export function ensureDreamPolicyProjection(): DreamPolicyProjection {
  try {
    const destination = getDreamPolicyProjectionPath();
    const published = lastPublished;
    if (published
      && published.destination === destination
      && published.projection.generation === getPolicyGeneration()
      && storeFingerprintsEqual(published.projection.source_store, currentStoreFingerprint())
      && publishedProjectionFileIsCurrent(destination, published.file)) {
      return published.projection;
    }
    return writeDreamPolicyProjection();
  } catch (error) {
    if (error instanceof DreamPolicyProjectionUnavailableError) throw error;
    throw new DreamPolicyProjectionUnavailableError(error);
  }
}

export function startDreamPolicyProjection(): void {
  if (unsubscribe) return;
  const refresh = (): void => {
    try { writeDreamPolicyProjection(); }
    catch (error) { console.error("[policy-projection] refresh failed:", error); }
  };
  const scheduleRefresh = (): void => {
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      refresh();
    }, 25);
    refreshTimer.unref?.();
  };
  refresh();
  unsubscribe = onPolicyChanged(refresh);
  try {
    const dataDir = getConfig().dataDir;
    storeWatcher = fs.watch(dataDir, { persistent: false }, (_event, fileName) => {
      if (String(fileName ?? "") === "store.json") scheduleRefresh();
    });
    storeWatcher.on("error", () => {
      storeWatcher?.close();
      storeWatcher = null;
    });
  } catch {
    // Explicit policy notifications and the search safety tick remain; a stale
    // projection always fails closed in the runner.
  }
}

export function stopDreamPolicyProjection(): void {
  unsubscribe?.();
  unsubscribe = null;
  storeWatcher?.close();
  storeWatcher = null;
  if (refreshTimer) clearTimeout(refreshTimer);
  refreshTimer = null;
}
