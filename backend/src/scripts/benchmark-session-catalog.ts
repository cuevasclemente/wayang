#!/usr/bin/env node
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { performance } from "node:perf_hooks";
import { SessionCatalog, type CatalogScanCommit } from "../session-catalog.js";
import type { FileFingerprint, SessionFileMetadata } from "../session-metadata.js";

const sessionCount = Number.parseInt(process.env.WAYANG_BENCH_SESSION_COUNT || "900", 10);
const totalBytesTarget = Number.parseInt(process.env.WAYANG_BENCH_TOTAL_BYTES || String(Math.floor(1.2 * 1024 * 1024 * 1024)), 10);
const reportPath = process.env.WAYANG_BENCH_REPORT || path.join(os.tmpdir(), `wayang-session-catalog-benchmark-${process.pid}.json`);
if (!reportPath.startsWith(`${os.tmpdir()}${path.sep}`)) throw new Error("Benchmark reports must remain under the system temporary directory");

function stats(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * q) - 1))] ?? null;
  return { count: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: sorted.at(-1) ?? null };
}

function syntheticFile(id: string, cwd: string, targetBytes: number): string {
  const header = JSON.stringify({ type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd });
  const model = JSON.stringify({ type: "model_change", id: `${id}-model`, parentId: null, timestamp: "2026-01-01T00:00:01.000Z", provider: "offline", modelId: "benchmark-fixture" });
  const message = JSON.stringify({ type: "message", id: `${id}-user`, parentId: `${id}-model`, timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "Public synthetic benchmark text", timestamp: 1_767_225_602_000 } });
  const base = `${header}\n${model}\n${message}\n`;
  const overhead = 220;
  const paddingLength = Math.max(0, targetBytes - Buffer.byteLength(base) - overhead);
  const padding = "public-synthetic-catalog-payload ".repeat(Math.ceil(paddingLength / 33)).slice(0, paddingLength);
  return base + JSON.stringify({ type: "custom_message", id: `${id}-padding`, parentId: `${id}-user`, timestamp: "2026-01-01T00:00:03.000Z", customType: "benchmark-padding", content: padding, display: true }) + "\n";
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-benchmark-"));
const projectDir = path.join(root, "--public-synthetic-project--");
const cwd = path.join(root, "project");
fs.mkdirSync(projectDir, { recursive: true, mode: 0o700 });
fs.mkdirSync(cwd, { recursive: true, mode: 0o700 });
const bytesPerSession = Math.ceil(totalBytesTarget / sessionCount);
let generatedBytes = 0;
for (let index = 0; index < sessionCount; index++) {
  const id = `public-benchmark-${String(index).padStart(6, "0")}`;
  const content = syntheticFile(id, cwd, bytesPerSession);
  fs.writeFileSync(path.join(projectDir, `${id}.jsonl`), content, { mode: 0o600 });
  generatedBytes += Buffer.byteLength(content);
}

const fingerprints = new Map<string, FileFingerprint>();
const rows = new Map<string, SessionFileMetadata>();
const adapter = {
  getKnownFile(filePath: string) {
    return { fingerprint: fingerprints.get(filePath) ?? null, mutationVersion: 0 };
  },
  commit(scan: CatalogScanCommit) {
    for (const parsed of scan.parsed) {
      fingerprints.set(parsed.metadata.path, parsed.metadata.fingerprint);
      rows.set(parsed.metadata.path, parsed.metadata);
    }
    return { imported: scan.parsed.length, updated: 0, archivedLegacy: 0, changed: scan.parsed.length > 0 };
  },
};
const catalog = new SessionCatalog(adapter, root);
const canaryDelays: number[] = [];
const healthDurations: number[] = [];
const healthServer = http.createServer((_request, response) => {
  response.setHeader("Content-Type", "application/json");
  response.end('{"status":"ok"}');
});
await new Promise<void>((resolve, reject) => {
  healthServer.once("error", reject);
  healthServer.listen(0, "127.0.0.1", () => resolve());
});
const healthAddress = healthServer.address();
if (!healthAddress || typeof healthAddress === "string") throw new Error("Failed to allocate isolated health benchmark port");
const healthUrl = `http://127.0.0.1:${healthAddress.port}/healthz`;
let expectedCanary = performance.now() + 10;
const canary = setInterval(() => {
  const now = performance.now();
  canaryDelays.push(Math.max(0, now - expectedCanary));
  expectedCanary = now + 10;
}, 10);

try {
  let coldFinished = false;
  const coldPromise = catalog.scan().finally(() => { coldFinished = true; });
  while (!coldFinished) {
    const started = performance.now();
    const response = await fetch(healthUrl);
    await response.arrayBuffer();
    healthDurations.push(performance.now() - started);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  const cold = await coldPromise;
  const unchangedDurations: number[] = [];
  for (let index = 0; index < 30; index++) unchangedDurations.push((await catalog.scan()).durationMs);
  const changedPath = path.join(projectDir, "public-benchmark-000000.jsonl");
  fs.appendFileSync(changedPath, JSON.stringify({ type: "session_info", id: "benchmark-title", parentId: "public-benchmark-000000-padding", timestamp: "2026-01-01T00:00:04.000Z", name: "Public benchmark changed" }) + "\n");
  const changed = await catalog.scan();

  const listDurations: number[] = [];
  const listRows = [...rows.values()].map((row) => ({ id: row.id, cwd: row.cwd, created_at: row.createdAt, last_active: row.lastInteractionAt, provider: row.provider, model: row.model }));
  for (let index = 0; index < 200; index++) {
    const started = performance.now();
    JSON.stringify(listRows);
    listDurations.push(performance.now() - started);
  }

  clearInterval(canary);
  const report = {
    schema_version: 1,
    aggregate_only: true,
    fixture: { session_count: sessionCount, generated_bytes: generatedBytes, target_bytes: totalBytesTarget },
    cold_scan: { duration_ms: cold.durationMs, parsed: cold.parsed, parse_bytes: cold.parseBytes, failures: cold.parseFailures },
    unchanged_scan_ms: stats(unchangedDurations),
    changed_scan: { duration_ms: changed.durationMs, parsed: changed.parsed, failures: changed.parseFailures },
    main_thread_canary_delay_ms: stats(canaryDelays),
    health_request_ms_during_cold_scan: stats(healthDurations),
    cached_list_serialize_ms: stats(listDurations),
  };
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  console.log(reportPath);
  console.log(JSON.stringify(report));
} finally {
  clearInterval(canary);
  await new Promise<void>((resolve) => healthServer.close(() => resolve()));
  await catalog.stop();
  fs.rmSync(root, { recursive: true, force: true });
}
