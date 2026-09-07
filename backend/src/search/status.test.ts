import { test } from "node:test";
import assert from "node:assert/strict";
import { describeSearchStatus } from "./status.js";
import type { SearchCoverage } from "./types.js";

const watcher = { started: true, backgroundIndexingEnabled: true, policyProjectionAvailable: true, backfillRunning: false };
const complete: SearchCoverage = { total: 2, counts: { current: 1, metadata_only: 1, queued: 0, running: 0,
  partial: 0, unsupported: 0, failed: 0, stale: 0, legacy: 0, missing: 0 }, retrying: 0, oldest_pending_age_ms: 0 };

test("search status distinguishes maintenance pause, unavailable authority, and known completion", () => {
  assert.equal(describeSearchStatus(watcher, complete).degraded, undefined);
  assert.equal(describeSearchStatus({ ...watcher, backgroundIndexingEnabled: false }, complete).degraded, "indexing_paused");
  assert.equal(describeSearchStatus({ ...watcher, policyProjectionAvailable: false, backgroundIndexingEnabled: false }, complete).degraded, "index_unavailable");
  assert.equal(describeSearchStatus({ ...watcher, backfillRunning: true }, complete).degraded, "indexing_in_progress");
});

test("every incomplete outcome prevents zero-error or idle backfill from implying complete coverage", () => {
  for (const kind of ["queued", "running", "partial", "unsupported", "failed", "stale", "legacy", "missing"] as const) {
    const coverage = { ...complete, counts: { ...complete.counts, current: 0, [kind]: 1 } };
    assert.equal(describeSearchStatus(watcher, coverage).degraded,
      kind === "running" ? "indexing_in_progress" : "index_incomplete", kind);
  }
});
