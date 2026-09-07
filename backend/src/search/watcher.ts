/** Bounded metadata/header discovery is independent of slow, queued extraction. */
import { getPolicyGeneration, onPolicyChanged } from "../policy.js";
import { listSessions } from "../sessions.js";
import { getSearchDb } from "./db.js";
import { indexSession, purgePolicyDeniedSessions, searchSessionNeedsIndex, getSearchQueueStatus,
  startSearchQueue, stopSearchQueue, resumeSearchQueueAfterProjection } from "./indexer.js";
import { cleanupSearchChunks, yieldSearchTurn } from "./publication.js";
import { DreamPolicyProjectionUnavailableError, ensureDreamPolicyProjection,
  startDreamPolicyProjection, stopDreamPolicyProjection } from "./policy-projection.js";

export const SEARCH_DISCOVERY_INTERVAL_MS = 5_000;
export const SEARCH_DISCOVERY_BATCH_SIZE = 16;
const POLICY_HEARTBEAT_MS = 30_000;
const BOOT_DELAY_MS = 2 * 60_000;
const RECENT_DEBOUNCE_MS = 2 * 60_000;
const MAX_DISCOVERY_ADMISSIONS = 64;
let timer: NodeJS.Timeout | null = null;
let discoveryTimer: NodeJS.Timeout | null = null;
let bootTimer: NodeJS.Timeout | null = null;
let tickTask: Promise<void> | null = null;
let cleanupTask: Promise<void> | null = null;
const admissions = new Map<string, Promise<void>>();
let sweepIds: string[] = [];
let sweepOffset = 0;
let sweepNeedsWork = false;
let lifecycle = 0;
let lastError: string | null = null;
let lastTickAt: number | null = null;
let backfillDone = false;
let unsubscribePolicy: (() => void) | null = null;
let started = false;
let backgroundIndexingEnabled = isSearchBackgroundIndexingEnabled();
let policyProjectionAvailable = false;
const POLICY_PROJECTION_ERROR = "Dream policy projection is unavailable";

export function isSearchBackgroundIndexingEnabled(value = process.env.WAYANG_SEARCH_BACKGROUND_INDEXING): boolean {
  if (value === undefined || value === "" || value === "1") return true;
  if (value === "0") return false;
  throw new Error("WAYANG_SEARCH_BACKGROUND_INDEXING must be 0 or 1");
}
export function refreshSearchPolicyProjection(ensureProjection: () => unknown = ensureDreamPolicyProjection,
  refreshGeneration: () => unknown = getPolicyGeneration): boolean {
  try {
    refreshGeneration(); ensureProjection(); policyProjectionAvailable = true;
    resumeSearchQueueAfterProjection();
    if (lastError === POLICY_PROJECTION_ERROR) lastError = null;
    return true;
  } catch { policyProjectionAvailable = false; lastError = POLICY_PROJECTION_ERROR; return false; }
}
export function runPausedPolicyHeartbeat(ensureProjection: () => unknown = ensureDreamPolicyProjection,
  refreshGeneration: () => unknown = getPolicyGeneration): void {
  lastTickAt = Date.now();
  if (!refreshSearchPolicyProjection(ensureProjection,refreshGeneration)) {
    console.error("[search] paused policy projection refresh remains unavailable");
  }
}
export function startWatcher(): void {
  if (started) return;
  backgroundIndexingEnabled = isSearchBackgroundIndexingEnabled();
  lifecycle++;
  sweepIds = []; sweepOffset = 0; sweepNeedsWork = false; backfillDone = false;
  startSearchQueue();
  const purgeForPolicy = (): void => {
    const result = purgePolicyDeniedSessions();
    if (result.errors > 0) lastError = `Policy purge failed for ${result.errors} session(s)`;
  };
  try {
    getPolicyGeneration(); startDreamPolicyProjection(); refreshSearchPolicyProjection(); purgeForPolicy();
    unsubscribePolicy = onPolicyChanged(purgeForPolicy);
    started = true;
  } catch (error) {
    unsubscribePolicy?.(); unsubscribePolicy = null; stopDreamPolicyProjection();
    void stopSearchQueue();
    throw error;
  }
  timer = setInterval(() => {
    if (!started) return;
    if (!backgroundIndexingEnabled) runPausedPolicyHeartbeat();
    else refreshSearchPolicyProjection();
    void runCleanup();
  },POLICY_HEARTBEAT_MS);
  timer.unref?.();
  if (!backgroundIndexingEnabled) {
    console.warn("[search] background indexing paused by WAYANG_SEARCH_BACKGROUND_INDEXING=0");
    return;
  }
  // Boot uses the same discovery cursor, not a second serial corpus producer.
  bootTimer = setTimeout(() => {
    bootTimer = null;
    const run = () => {
      if (!started) return;
      void tick().catch(() => { lastError = "Search discovery failed"; });
    };
    run();
    if (started) {
      discoveryTimer = setInterval(run,SEARCH_DISCOVERY_INTERVAL_MS);
      discoveryTimer.unref?.();
    }
  },BOOT_DELAY_MS);
  bootTimer.unref?.();
}
export function stopWatcher(): Promise<void> {
  started = false; lifecycle++;
  const queueStopped = stopSearchQueue();
  if (timer) clearInterval(timer);
  if (discoveryTimer) clearInterval(discoveryTimer);
  if (bootTimer) clearTimeout(bootTimer);
  timer = null; discoveryTimer = null; bootTimer = null;
  unsubscribePolicy?.(); unsubscribePolicy = null; stopDreamPolicyProjection();
  return Promise.all([queueStopped,tickTask,cleanupTask,...admissions.values()]).then(() => undefined);
}
export function getWatcherStatus() {
  return {lastError,lastTickAt,backfillDone,
    backfillRunning:!backfillDone && Boolean(tickTask || admissions.size),started,
    backgroundIndexingEnabled:started ? backgroundIndexingEnabled : isSearchBackgroundIndexingEnabled(),policyProjectionAvailable};
}

interface DiscoveryTestPorts {
  sessionIds?: () => string[];
  needsIndex?: (sessionId: string) => boolean;
  resetSweep?: boolean;
}
function tick(indexOne: typeof indexSession = indexSession, ports: DiscoveryTestPorts = {}): Promise<void> {
  if (tickTask) return tickTask;
  if (getSearchQueueStatus().stopped) return Promise.resolve();
  const work = discoverBatch(indexOne,ports,lifecycle);
  tickTask = work;
  void work.then(() => {if(tickTask===work)tickTask=null;},() => {if(tickTask===work)tickTask=null;});
  return work;
}
async function discoverBatch(indexOne: typeof indexSession, ports: DiscoveryTestPorts, expectedLifecycle: number): Promise<void> {
  lastTickAt = Date.now();
  getPolicyGeneration();
  // One batch-global prerequisite. No per-session projection retry storm.
  ensureDreamPolicyProjection();
  if (ports.resetSweep) { sweepIds=[]; sweepOffset=0; }
  if (!sweepIds.length) {
    // Freeze only catalog IDs for one sweep so recency reordering cannot starve
    // older sessions. No corpus-wide authorization walk or transcript scan.
    sweepIds = (ports.sessionIds ?? (() => listSessions(true).map(row=>row.id)))();
    sweepOffset = 0; sweepNeedsWork = false;
  }
  const end = Math.min(sweepOffset+SEARCH_DISCOVERY_BATCH_SIZE,sweepIds.length);
  while (sweepOffset < end) {
    if (expectedLifecycle !== lifecycle || getSearchQueueStatus().stopped) return;
    const id = sweepIds[sweepOffset++];
    const needed = (ports.needsIndex ?? searchSessionNeedsIndex)(id);
    sweepNeedsWork ||= needed;
    if (needed && !admissions.has(id) && admissions.size < MAX_DISCOVERY_ADMISSIONS) {
      // Deliberately do NOT await extraction here. Dirty overflow is revisited
      // on later sweeps; queue capacity, priority and cooldown remain authoritative.
      try {
        const work = indexOne(id,{priority:"background"});
        const settled = work.then((result) => {if(result.error)lastError="Search indexing incomplete";},(error) => {
          lastError = error instanceof DreamPolicyProjectionUnavailableError ? POLICY_PROJECTION_ERROR : "Search refresh failed";
        });
        admissions.set(id,settled);
        void settled.then(() => {if(admissions.get(id)===settled)admissions.delete(id);});
      } catch { lastError="Search admission failed"; }
    }
    await yieldSearchTurn();
  }
  if (sweepOffset >= sweepIds.length) {
    // This flag is discovery bookkeeping, never a substitute for durable
    // current/partial/failed coverage counts exposed by the status owner.
    backfillDone = !sweepNeedsWork && admissions.size===0;
    sweepIds=[]; sweepOffset=0;
  }
}
function runCleanup(): Promise<void> {
  if (cleanupTask) return cleanupTask;
  const expectedLifecycle = lifecycle;
  cleanupTask = Promise.resolve().then(async () => {
    if (!started || expectedLifecycle !== lifecycle) return;
    try { await cleanupSearchChunks(getSearchDb(),{maxBatches:4,
      shouldContinue:()=>started && expectedLifecycle===lifecycle}); }
    catch { lastError="Search cleanup failed"; }
  }).finally(() => {cleanupTask=null;});
  return cleanupTask;
}
/** @internal Deterministic discovery-cycle seam; uses only synthetic fixture ports. */
export async function runWatcherTickForTests(indexOne: typeof indexSession = indexSession, ports: DiscoveryTestPorts = {}): Promise<void> {
  if (!isSearchBackgroundIndexingEnabled()) {getPolicyGeneration();return;}
  await tick(indexOne,ports);
}
export async function indexSessionNow(sessionId: string, indexOne: typeof indexSession = indexSession): Promise<void> {
  if (!isSearchBackgroundIndexingEnabled() || getSearchQueueStatus().stopped) return;
  try {await indexOne(sessionId,{priority:"recent",delayMs:RECENT_DEBOUNCE_MS});}
  catch {console.error("[search] recent indexing request failed");}
