import { getIndexCoverageSnapshot } from "./indexer.js";
import { getWatcherStatus } from "./watcher.js";
import type { SearchCoverage, SearchResponse } from "./types.js";

type WatcherObservation = Pick<ReturnType<typeof getWatcherStatus>,
  "started" | "backgroundIndexingEnabled" | "policyProjectionAvailable" | "backfillRunning">;

export function describeSearchStatus(watcher: WatcherObservation, coverage?: SearchCoverage): Pick<SearchResponse, "degraded" | "coverage"> {
  const incomplete = coverage && Object.entries(coverage.counts)
    .some(([kind, count]) => kind !== "current" && kind !== "metadata_only" && count > 0);
  const degraded: SearchResponse["degraded"] = watcher.started && !watcher.policyProjectionAvailable
    ? "index_unavailable"
    : !watcher.backgroundIndexingEnabled ? "indexing_paused"
    : watcher.backfillRunning || (coverage?.counts.running ?? 0) > 0 ? "indexing_in_progress"
    : incomplete ? "index_incomplete" : undefined;
  return { degraded, ...(coverage ? { coverage } : {}) };
}

/** Reuse the caller's exact authorization set; never scan bodies for status. */
export function getSearchStatus(allowedIds?: readonly string[]): Pick<SearchResponse, "degraded" | "coverage"> {
  let coverage: SearchCoverage | undefined;
  if (allowedIds) {
    const snapshot = getIndexCoverageSnapshot(new Set(allowedIds));
    coverage = { total: snapshot.total, counts: snapshot.counts, retrying: snapshot.retrying,
      oldest_pending_age_ms: snapshot.oldestPendingAgeMs };
  }
  return describeSearchStatus(getWatcherStatus(), coverage);
}
