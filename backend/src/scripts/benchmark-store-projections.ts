#!/usr/bin/env node
/** Offline, bounded synthetic operation-count benchmark. Never opens a live store. */
import fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { performance } from "node:perf_hooks";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-store-cost-benchmark-"));
process.env.HOME = root;
process.env.PI_CODING_AGENT_DIR = path.join(root, "pi");
process.env.WAYANG_DATA_DIR = path.join(root, "data");
const { init, close, flush } = await import("../db.js");
const { createAgentProfile } = await import("../agent-profiles.js");
const { createProject } = await import("../projects.js");
const { readBoundedSessionHeader } = await import("../standard-transcript-authorization.js");
const originalSync = fs.fsyncSync;
const originalRead = fs.readSync;
let syncs = 0;
let reads = 0;
fs.fsyncSync = (fd) => { syncs++; originalSync(fd); };
fs.readSync = ((...args: unknown[]) => { reads++; return Reflect.apply(originalRead, fs, args); }) as typeof fs.readSync;
syncBuiltinESMExports();
try {
  init();
  const profile = createAgentProfile({ name: "Synthetic operation-count profile" });
  const saves: Array<{ standard_pairs: number; fsync_calls: number; elapsed_ms: number }> = [];
  for (let pairs = 1; pairs <= 10; pairs++) {
    const cwd = path.join(root, `project-${pairs}`);
    fs.mkdirSync(cwd);
    createProject({ cwd, default_agent_profile_id: profile.id,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profile.id] } });
    if (![1, 5, 10].includes(pairs)) continue;
    syncs = 0;
    const started = performance.now();
    flush();
    saves.push({ standard_pairs: pairs, fsync_calls: syncs, elapsed_ms: performance.now() - started });
  }
  const headers: Array<{ header_bytes: number; attempts: number; read_syscalls: number; elapsed_ms: number }> = [];
  for (const padding of [256, 4096, 60_000]) {
    const file = path.join(root, "synthetic-header.jsonl");
    const header = JSON.stringify({ type: "session", id: "synthetic-session", cwd: root, padding: "x".repeat(padding) }) + "\n";
    fs.writeFileSync(file, header + '{"type":"message","synthetic":true}\n');
    reads = 0;
    const started = performance.now();
    for (let i = 0; i < 25; i++) readBoundedSessionHeader(file);
    headers.push({ header_bytes: Buffer.byteLength(header), attempts: 25, read_syscalls: reads, elapsed_ms: performance.now() - started });
  }
  console.log(JSON.stringify({ schema_version: 1, synthetic_only: true,
    note: "Single local run: operation counts are primary evidence; wall time is filesystem/load dependent. Header reader intentionally does not read ahead into unauthorized bodies.",
    unchanged_store_flush: saves, bounded_header_reads: headers }, null, 2));
} finally {
  fs.fsyncSync = originalSync;
  fs.readSync = originalRead;
  syncBuiltinESMExports();
  close();
  fs.rmSync(root, { recursive: true, force: true });
}
