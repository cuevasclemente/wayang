/**
 * search/watcher.ts — Background reindexer.
 *
 * Delayed, gradual backfill plus a bounded round-robin sweep. All body work
 * enters the same single-flight queue; recent hooks wait two minutes and
 * background completions cool down for five seconds. A separate lightweight
 * policy heartbeat and bounded garbage collection continue while paused.
 */

import { getPolicyGeneration, onPolicyChanged } from "../policy.js";
import { listSessions } from "../sessions.js";
import { getSearchDb } from "./db.js";
import { indexSession, purgePolicyDeniedSessions, reindexAll, startSearchQueue, stopSearchQueue, resumeSearchQueueAfterProjection } from "./indexer.js";
import { cleanupSearchChunks, yieldSearchTurn } from "./publication.js";
import {
  DreamPolicyProjectionUnavailableError,
  ensureDreamPolicyProjection,
  startDreamPolicyProjection,
  stopDreamPolicyProjection,
} from "./policy-projection.js";

const WATCH_INTERVAL_MS = 5 * 60_000;
const POLICY_HEARTBEAT_MS = 30_000;
const BOOT_DELAY_MS = 2 * 60_000;
const RECENT_DEBOUNCE_MS = 2 * 60_000;
const MAX_SESSIONS_PER_TICK = 16;
let tickRunning = false;
let sweepOffset = 0;
let lifecycle = 0;
let cleanupTask: Promise<void> | null = null;

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
    resumeSearchQueueAfterProjection();
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
  lifecycle++;
  startSearchQueue();
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
    timer = setInterval(() => {
      runPausedPolicyHeartbeat();
      void runCleanup();
    }, POLICY_HEARTBEAT_MS);
    timer.unref?.();
    return;
  }
  bootTimer = setTimeout(() => {
    bootTimer = null;
    runBackfill().catch(() => {
      lastError = "Search initial backfill failed";
      console.error("[search] initial backfill failed");
    });
  }, BOOT_DELAY_MS);
  bootTimer.unref?.();

  timer = setInterval(() => {
    if (!refreshSearchPolicyProjection()) return;
    void runCleanup();
    if (lastTickAt !== null && Date.now() - lastTickAt < WATCH_INTERVAL_MS) return;
    tick().catch(() => {
      lastError = "Search watcher cycle failed";
    });
  }, POLICY_HEARTBEAT_MS);
  timer.unref?.();
}

export function stopWatcher(): Promise<void> {
  started = false;
  lifecycle++;
  const queueStopped = stopSearchQueue();
  if (timer) clearInterval(timer);
  if (bootTimer) clearTimeout(bootTimer);
  timer = null;
  bootTimer = null;
  unsubscribePolicy?.();
  unsubscribePolicy = null;
  stopDreamPolicyProjection();
  return Promise.all([queueStopped,cleanupTask]).then(() => undefined);
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
  if (backfillRunning || !started) return;
  const expectedLifecycle = lifecycle;
  backfillRunning = true;
  let completed = false;
  try {
    const summary = await reindexAll({ priority: "background" });
    completed = summary.errors === 0 && summary.indexed + summary.skipped === summary.total;
    console.log(
      `[search] backfill done: total=${summary.total} indexed=${summary.indexed} skipped=${summary.skipped} errors=${summary.errors} durationMs=${summary.durationMs}`,
    );
  } finally {
    backfillRunning = false;
    if (lifecycle === expectedLifecycle && started) backfillDone = completed;
  }
}

async function tick(indexOne: typeof indexSession = indexSession): Promise<void> {
  if (tickRunning || backfillRunning) return;
  tickRunning = true;
  const expectedLifecycle = lifecycle;
  try {
    lastTickAt = Date.now();
    getPolicyGeneration();
    // One global prerequisite check; no per-session retry storm on outage.
    ensureDreamPolicyProjection();
    const sessions = listSessions(true);
    const count = Math.min(MAX_SESSIONS_PER_TICK,sessions.length);
    for (let index = 0; index < count; index++) {
      if (expectedLifecycle !== lifecycle) break;
      const row = sessions[(sweepOffset + index) % sessions.length];
      try {
        // Authorization, exact revision checks, cheap metadata updates and
        // durable backoff belong to the queue consumer, not a raw stat sweep.
        await indexOne(row.id,{priority:"background"});
      } catch (error) {
        if (error instanceof DreamPolicyProjectionUnavailableError) throw error;
        lastError = "Search refresh failed";
      }
      await yieldSearchTurn();
    }
    sweepOffset = sessions.length ? (sweepOffset + count) % sessions.length : 0;
  } finally { tickRunning = false; }
}

function runCleanup(): Promise<void> {
  if (cleanupTask) return cleanupTask;
  cleanupTask = Promise.resolve().then(async () => {
    try { await cleanupSearchChunks(getSearchDb(),{maxBatches:4}); }
    catch { lastError = "Search cleanup failed"; }
  }).finally(() => { cleanupTask = null; });
  return cleanupTask;
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
 * discovered/changed. Coalesce it into the recent queue with conservative lag
 * rather than bypassing admission/cooldown from a foreground hook.
 */
export async function indexSessionNow(
  sessionId: string,
  indexOne: typeof indexSession = indexSession,
): Promise<void> {
  if (!isSearchBackgroundIndexingEnabled()) return;
  try {
    // indexSession ensures the complete current decision before a newly linked
    // transcript can be considered by external Dream enumeration.
    await indexOne(sessionId, { priority: "recent", delayMs: RECENT_DEBOUNCE_MS });
  } catch {
    console.error("[search] recent indexing request failed");
  }
}
