import assert from "node:assert/strict";
import test from "node:test";
import {
  getLatencyMetricsSnapshot,
  recordLatencyMetric,
  resetLatencyMetricsForTests,
} from "./latency-metrics.js";

test("session-open telemetry is aggregate-only and reports distribution statistics", () => {
  resetLatencyMetricsForTests();
  recordLatencyMetric("session_open_usable_ms", 125.25);
  recordLatencyMetric("session_open_usable_ms", 250.75);

  const snapshot = getLatencyMetricsSnapshot() as {
    aggregate_only: boolean;
    metrics: Record<string, { count: number; p50: number | null; p95: number | null; p99: number | null; max: number | null }>;
  };

  assert.equal(snapshot.aggregate_only, true);
  assert.deepEqual(snapshot.metrics.session_open_usable_ms, {
    count: 2,
    p50: 125.3,
    p95: 250.8,
    p99: 250.8,
    max: 250.8,
  });
});

test("latency telemetry rejects unknown metric names and invalid values", () => {
  resetLatencyMetricsForTests();
  recordLatencyMetric("session_open_usable_ms", Number.NaN);
  recordLatencyMetric("session_open_usable_ms", -1);
  recordLatencyMetric("private_session_identifier", 10);

  const snapshot = getLatencyMetricsSnapshot() as {
    metrics: Record<string, { count: number }>;
  };

  assert.equal(snapshot.metrics.session_open_usable_ms?.count, 0);
  assert.equal(snapshot.metrics.private_session_identifier, undefined);
});
