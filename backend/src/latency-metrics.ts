import { monitorEventLoopDelay, performance } from "node:perf_hooks";

const ALLOWED_METRICS = new Set([
  "catalog_scan_ms",
  "catalog_enumerate_ms",
  "catalog_worker_ms",
  "catalog_parse_count",
  "catalog_parse_bytes",
  "sessions_list_finish_ms",
  "history_snapshot_ms",
  "history_snapshot_bytes",
  "history_stringify_ms",
  "session_open_usable_ms",
  "lazy_session_create_ms",
  "lazy_extensions_ms",
  "lazy_settings_model_ms",
  "lazy_transcript_open_ms",
  "lazy_agent_create_ms",
  "lazy_extension_bind_ms",
]);
const MAX_SAMPLES = 2_048;
const samples = new Map<string, number[]>();
const loopDelay = monitorEventLoopDelay({ resolution: 10 });
let started = false;
let startedAt = Date.now();
let previousUtilization = performance.eventLoopUtilization();

export function startLatencyMetrics(): void {
  if (started) return;
  started = true;
  startedAt = Date.now();
  previousUtilization = performance.eventLoopUtilization();
  loopDelay.enable();
}

export function stopLatencyMetrics(): void {
  if (!started) return;
  started = false;
  loopDelay.disable();
}

export function recordLatencyMetric(name: string, value: number): void {
  if (!ALLOWED_METRICS.has(name) || !Number.isFinite(value) || value < 0) return;
  const bucket = samples.get(name) ?? [];
  bucket.push(value);
  if (bucket.length > MAX_SAMPLES) bucket.splice(0, bucket.length - MAX_SAMPLES);
  samples.set(name, bucket);
}

function percentile(sorted: number[], quantile: number): number | null {
  if (sorted.length === 0) return null;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * quantile) - 1))]!;
}

function rounded(value: number | null): number | null {
  return value === null || !Number.isFinite(value) ? null : Math.round(value * 10) / 10;
}

export function getLatencyMetricsSnapshot(): Record<string, unknown> {
  const metrics: Record<string, unknown> = {};
  for (const name of [...ALLOWED_METRICS].sort()) {
    const values = [...(samples.get(name) ?? [])].sort((a, b) => a - b);
    metrics[name] = {
      count: values.length,
      p50: rounded(percentile(values, 0.5)),
      p95: rounded(percentile(values, 0.95)),
      p99: rounded(percentile(values, 0.99)),
      max: rounded(values.length > 0 ? values[values.length - 1]! : null),
    };
  }
  const utilization = performance.eventLoopUtilization(previousUtilization);
  previousUtilization = performance.eventLoopUtilization();
  return {
    schema_version: 1,
    aggregate_only: true,
    started_at: startedAt,
    uptime_ms: Date.now() - startedAt,
    metrics,
    event_loop: {
      delay_p50_ms: rounded(loopDelay.percentile(50) / 1e6),
      delay_p95_ms: rounded(loopDelay.percentile(95) / 1e6),
      delay_p99_ms: rounded(loopDelay.percentile(99) / 1e6),
      delay_max_ms: rounded(loopDelay.max / 1e6),
      utilization: rounded(utilization.utilization),
    },
  };
}

export function resetLatencyMetricsForTests(): void {
  samples.clear();
  loopDelay.reset();
  previousUtilization = performance.eventLoopUtilization();
}
