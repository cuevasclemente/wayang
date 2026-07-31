import * as fs from "node:fs";
import * as path from "node:path";
import { getConfig } from "../config.js";
import { getStore } from "../db.js";
import { isLegacyPrivateSessionQuarantined } from "../sessions.js";
import {
  authorizeProjectAction,
  buildProjectPolicyProjection,
  canonicalizePolicyPath,
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

let unsubscribe: (() => void) | null = null;
let storeWatcher: fs.FSWatcher | null = null;
let refreshTimer: NodeJS.Timeout | null = null;

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
  const storeStat = fs.statSync(path.join(getConfig().dataDir, "store.json"));
  return {
    schema_version: 1,
    generation: projectProjection.generation,
    complete: true,
    source_store: {
      size: storeStat.size,
      mtime_ms: storeStat.mtimeMs,
      ctime_ms: storeStat.ctimeMs,
      ino: Number(storeStat.ino) || 0,
    },
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
