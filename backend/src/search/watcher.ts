/**
 * search/watcher.ts — Background reindexer.
 *
 * Strategy:
 *   - On boot, kick off a `reindexAll()` after a short delay so the http
 *     listen is not blocked.
 *   - Every WATCH_INTERVAL_MS, diff `last_active` and `pi_session_file` mtimes
 *     against `session_index_state` and reindex changed sessions.
 *
 * Cheaper and more deterministic than chokidar-watching ~160 jsonl files
 * spread across project subdirectories.
 */

import * as fs from "node:fs";
import { getPolicyGeneration, onPolicyChanged } from "../policy.js";
import { listSessions } from "../sessions.js";
import { getSearchDb } from "./db.js";
import { indexSession, purgePolicyDeniedSessions, reindexAll } from "./indexer.js";
import {
  DreamPolicyProjectionUnavailableError,
  ensureDreamPolicyProjection,
  startDreamPolicyProjection,
  stopDreamPolicyProjection,
} from "./policy-projection.js";

const WATCH_INTERVAL_MS = 30_000;
const BOOT_DELAY_MS = 2_000;

let timer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let lastError: string | null = null;
let lastTickAt: number | null = null;
let backfillDone = false;
let backfillRunning = false;
let unsubscribePolicy: (() => void) | null = null;
let started = false;
let backgroundIndexingEnabled = isSearchBackgroundIndexingEnabled();
let policyProjectionAvailable = false;
const POLICY_PROJECTION_ERROR = "Dream policy projection is unavailable";

export function isSearchBackgroundIndexingEnabled(
  value = process.env.WAYANG_SEARCH_BACKGROUND_INDEXING,
): boolean {
  if (value === undefined || value === "" || value === "1") return true;
  if (value === "0") return false;
  throw new Error("WAYANG_SEARCH_BACKGROUND_INDEXING must be 0 or 1");
}

export function refreshSearchPolicyProjection(
  ensureProjection: () => unknown = ensureDreamPolicyProjection,
  refreshGeneration: () => unknown = getPolicyGeneration,
): boolean {
  try {
    refreshGeneration();
    ensureProjection();
    policyProjectionAvailable = true;
    if (lastError === POLICY_PROJECTION_ERROR) lastError = null;
    return true;
  } catch {
    policyProjectionAvailable = false;
    lastError = POLICY_PROJECTION_ERROR;
    return false;
  }
}

export function runPausedPolicyHeartbeat(
  ensureProjection: () => unknown = ensureDreamPolicyProjection,
  refreshGeneration: () => unknown = getPolicyGeneration,
): void {
  lastTickAt = Date.now();
  if (!refreshSearchPolicyProjection(ensureProjection, refreshGeneration)) {
    console.error("[search] paused policy projection refresh remains unavailable");
  }
}

export function startWatcher(): void {
  if (started) return;
  backgroundIndexingEnabled = isSearchBackgroundIndexingEnabled();
  const purgeForPolicy = (): void => {
    const result = purgePolicyDeniedSessions();
    if (result.errors > 0) lastError = `Policy purge failed for ${result.errors} session(s)`;
  };
  try {
    getPolicyGeneration();
    startDreamPolicyProjection();
    refreshSearchPolicyProjection();
    purgeForPolicy();
    unsubscribePolicy = onPolicyChanged(purgeForPolicy);
    started = true;
  } catch (error) {
    unsubscribePolicy?.();
    unsubscribePolicy = null;
    stopDreamPolicyProjection();
    throw error;
  }
  if (!backgroundIndexingEnabled) {
    console.warn("[search] background indexing paused by WAYANG_SEARCH_BACKGROUND_INDEXING=0");
    timer = setInterval(() => runPausedPolicyHeartbeat(), WATCH_INTERVAL_MS);
    timer.unref?.();
    return;
  }
  bootTimer = setTimeout(() => {
    bootTimer = null;
    runBackfill().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.error("[search] initial backfill failed:", err);
    });
  }, BOOT_DELAY_MS);
  bootTimer.unref?.();

  timer = setInterval(() => {
    tick().catch((err) => {
      lastError = err instanceof Error ? err.message : String(err);
      console.error("[search] watcher tick failed:", err);
    });
  }, WATCH_INTERVAL_MS);
  timer.unref?.();
}

export function stopWatcher(): void {
  started = false;
  if (timer) clearInterval(timer);
  if (bootTimer) clearTimeout(bootTimer);
  timer = null;
  bootTimer = null;
  unsubscribePolicy?.();
  unsubscribePolicy = null;
  stopDreamPolicyProjection();
}

export function getWatcherStatus(): {
  lastError: string | null;
  lastTickAt: number | null;
  backfillDone: boolean;
  backfillRunning: boolean;
  started: boolean;
  backgroundIndexingEnabled: boolean;
  policyProjectionAvailable: boolean;
} {
  return {
    lastError,
    lastTickAt,
    backfillDone,
    backfillRunning,
    started,
    backgroundIndexingEnabled: started ? backgroundIndexingEnabled : isSearchBackgroundIndexingEnabled(),
    policyProjectionAvailable,
  };
}

async function runBackfill(): Promise<void> {
  if (backfillRunning) return;
  backfillRunning = true;
  try {
    const summary = await reindexAll();
    console.log(
      `[search] backfill done: total=${summary.total} indexed=${summary.indexed} skipped=${summary.skipped} errors=${summary.errors} durationMs=${summary.durationMs}`,
    );
  } finally {
    backfillRunning = false;
    backfillDone = true;
  }
}

async function tick(indexOne: typeof indexSession = indexSession): Promise<void> {
  lastTickAt = Date.now();
  // Detect policy-bearing repository writes even if their caller omitted the
  // eager notification hook; onPolicyChanged performs the purge.
  getPolicyGeneration();
  const db = getSearchDb();
  const sessions = listSessions(true);
  const states = new Map<
    string,
    { pi_session_file: string | null; file_mtime_ms: number | null; file_size: number | null }
  >();
  for (const r of db
    .prepare(
      "SELECT session_id, pi_session_file, file_mtime_ms, file_size FROM session_index_state",
    )
    .all() as Array<{
    session_id: string;
    pi_session_file: string | null;
    file_mtime_ms: number | null;
    file_size: number | null;
  }>) {
    states.set(r.session_id, {
      pi_session_file: r.pi_session_file,
      file_mtime_ms: r.file_mtime_ms,
      file_size: r.file_size,
    });
  }

  for (const s of sessions) {
    const st = states.get(s.id);
    let needsReindex = false;
    if (!st) {
      needsReindex = true;
    } else if ((st.pi_session_file ?? null) !== (s.pi_session_file ?? null)) {
      needsReindex = true;
    } else if (s.pi_session_file) {
      try {
        const stat = fs.statSync(s.pi_session_file);
        if (stat.mtimeMs !== st.file_mtime_ms || stat.size !== st.file_size) {
          needsReindex = true;
        }
      } catch {
        // File removed; still update state.
        needsReindex = true;
      }
    }
    if (needsReindex) {
      try {
        await indexOne(s.id);
      } catch (err) {
        if (err instanceof DreamPolicyProjectionUnavailableError) throw err;
        console.error(`[search] tick indexSession(${s.id}) failed:`, err);
      }
    }
  }
}

/** @internal Deterministic watcher-cycle seam for synthetic tests. */
export async function runWatcherTickForTests(
  indexOne: typeof indexSession = indexSession,
): Promise<void> {
  if (!isSearchBackgroundIndexingEnabled()) {
    getPolicyGeneration();
    return;
  }
  await tick(indexOne);
}

/**
 * Public hook: call when a specific session has just had its pi_session_file
 * discovered/changed, so it can be indexed immediately rather than waiting
 * for the next tick.
 */
export async function indexSessionNow(
  sessionId: string,
  indexOne: typeof indexSession = indexSession,
): Promise<void> {
  if (!isSearchBackgroundIndexingEnabled()) return;
  try {
    // indexSession ensures the complete current decision before a newly linked
    // transcript can be considered by external Dream enumeration.
    await indexOne(sessionId);
  } catch (err) {
    console.error(`[search] immediate indexSession(${sessionId}) failed:`, err);
  }
}
