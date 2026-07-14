import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SessionCatalog, type CatalogScanCommit } from "./session-catalog.js";
import type { FileFingerprint } from "./session-metadata.js";

function syntheticSession(id: string, cwd: string, extra: object[] = []): string {
  return [
    { type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd },
    { type: "model_change", id: "model-a", parentId: null, timestamp: "2026-01-01T00:00:01.000Z", provider: "offline", modelId: "fixture-a" },
    { type: "message", id: "user-a", parentId: "model-a", timestamp: "2026-01-01T00:00:02.000Z", message: { role: "user", content: "Public synthetic fixture text", timestamp: 1_767_225_602_000 } },
    ...extra,
  ].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}

function createAdapter() {
  const fingerprints = new Map<string, FileFingerprint>();
  const commits: CatalogScanCommit[] = [];
  return {
    fingerprints,
    commits,
    adapter: {
      getKnownFile(filePath: string) {
        return { fingerprint: fingerprints.get(filePath) ?? null, mutationVersion: 0 };
      },
      commit(scan: CatalogScanCommit) {
        commits.push(scan);
        for (const parsed of scan.parsed) fingerprints.set(parsed.metadata.path, parsed.metadata.fingerprint);
        return { imported: scan.parsed.length, updated: 0, archivedLegacy: 0, changed: scan.parsed.length > 0 };
      },
    },
  };
}

test("incremental catalog parses unknown/changed files once and unchanged scans parse zero", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-test-"));
  const project = path.join(root, "--synthetic-project--");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "fixture.jsonl");
  fs.writeFileSync(file, syntheticSession("fixture-id", project));
  const state = createAdapter();
  const catalog = new SessionCatalog(state.adapter, root);

  try {
    const cold = await catalog.scan();
    assert.equal(cold.discovered, 1);
    assert.equal(cold.parsed, 1);
    assert.equal(state.commits[0]?.parsed[0]?.metadata.model, "fixture-a");

    const unchanged = await catalog.scan();
    assert.equal(unchanged.parsed, 0);

    fs.appendFileSync(file, JSON.stringify({
      type: "model_change",
      id: "model-b",
      parentId: "user-a",
      timestamp: "2026-01-01T00:00:03.000Z",
      provider: "offline",
      modelId: "fixture-b",
    }) + "\n");
    const changed = await catalog.scan();
    assert.equal(changed.parsed, 1);
    assert.equal(state.commits.at(-1)?.parsed[0]?.metadata.model, "fixture-b");
  } finally {
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("large metadata parsing stays off the main event loop", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-loop-test-"));
  const project = path.join(root, "--synthetic-project--");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "large.jsonl");
  const publicChunk = "synthetic markdown fixture ".repeat(1_000);
  const entries: object[] = [];
  let parentId = "user-a";
  for (let index = 0; index < 700; index++) {
    const id = `assistant-${index}`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date(1_767_225_603_000 + index).toISOString(),
      message: { role: "assistant", content: publicChunk, provider: "offline", model: "fixture-large" },
    });
    parentId = id;
  }
  fs.writeFileSync(file, syntheticSession("large-fixture-id", project, entries));
  const state = createAdapter();
  const catalog = new SessionCatalog(state.adapter, root);
  let maxTimerDelay = 0;
  let expected = Date.now() + 10;
  const timer = setInterval(() => {
    const now = Date.now();
    maxTimerDelay = Math.max(maxTimerDelay, now - expected);
    expected = now + 10;
  }, 10);

  try {
    const result = await catalog.scan();
    assert.equal(result.parsed, 1);
    assert.ok(result.parseBytes > 10 * 1024 * 1024);
    assert.ok(maxTimerDelay < 250, `main-thread timer delayed ${maxTimerDelay}ms`);
  } finally {
    clearInterval(timer);
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
