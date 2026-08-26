import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  MAX_CATALOG_BODY_BYTES,
  SessionCatalog,
  type CatalogScanCommit,
  type SessionCatalogAdapter,
} from "./session-catalog.js";
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
  const adapter: SessionCatalogAdapter = {
      getKnownFile(filePath: string) {
        return { fingerprint: fingerprints.get(filePath) ?? null, mutationVersion: 0 };
      },
      classifyDurableSession(filePath: string, sessionId: string, headerCwd: string) {
        return { filePath, sessionId, projectId: "synthetic-standard-project", cwd: headerCwd, mutationVersion: 0 };
      },
      stageDurableSession() { return null; },
      commit(scan: CatalogScanCommit) {
        commits.push(scan);
        for (const parsed of scan.parsed) fingerprints.set(parsed.metadata.path, parsed.metadata.fingerprint);
        return { imported: scan.parsed.length, updated: 0, archivedLegacy: 0, changed: scan.parsed.length > 0 };
      },
    };
  return { fingerprints, commits, adapter };
}

test("incremental catalog parses classified changed files once and unchanged scans parse zero", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-test-"));
  const project = path.join(root, "--synthetic-project--");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "fixture.jsonl");
  fs.writeFileSync(file, syntheticSession("fixture-id", project));
  const state = createAdapter();
  const catalog = new SessionCatalog(state.adapter, root, {
    authorizeCwd: () => true,
    getPolicyGeneration: () => 1,
    refreshProjection: () => undefined,
  });

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
    assert.equal(catalog.getStatus().started, false);
    assert.equal(catalog.getStatus().watcherCount, 0,
      "one-shot manual scan must not install persistent filesystem watchers");

    const commitsBeforeLaterWrite = state.commits.length;
    fs.appendFileSync(file, "\n");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(state.commits.length, commitsBeforeLaterWrite,
      "later file changes must not reactivate an unstarted catalog");
  } finally {
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("header authorization buffers exactly through newline and no body byte", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-header-boundary-"));
  const project = path.join(root, "--header-boundary-project--");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "boundary.jsonl");
  const header = JSON.stringify({
    type: "session",
    version: 3,
    id: "header-boundary-id",
    timestamp: "2026-01-01T00:00:00.000Z",
    cwd: project,
  });
  const bodyCanary = "BODY_BYTE_MUST_NOT_BE_BUFFERED_BEFORE_AUTHORIZATION";
  fs.writeFileSync(file, `${header}\n${bodyCanary}\n`);
  const state = createAdapter();
  let observed = "";
  let authorizationCalled = false;
  const catalog = new SessionCatalog(state.adapter, root, {
    observePreAuthorizationBytes(bytes) {
      assert.equal(authorizationCalled, false);
      observed = Buffer.from(bytes).toString("utf8");
    },
    authorizeCwd(cwd) {
      authorizationCalled = true;
      assert.equal(cwd, project);
      assert.equal(observed, `${header}\n`);
      assert.equal(observed.includes(bodyCanary), false);
      return false;
    },
    getPolicyGeneration: () => 1,
    refreshProjection: () => undefined,
  });
  try {
    const result = await catalog.scan();
    assert.equal(authorizationCalled, true);
    assert.equal(observed, `${header}\n`);
    assert.equal(result.headerBytes, Buffer.byteLength(`${header}\n`));
    assert.equal(result.parseBytes, 0);
    assert.equal(result.parsed, 0);
    assert.equal(state.commits[0]?.parsed.length, 0);
  } finally {
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("protected catalog authorization reads only a bounded header and never parses body text", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-protected-"));
  const project = path.join(root, "--protected-project--");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "protected.jsonl");
  const canary = "PROTECTED_BODY_CANARY ".repeat(100_000);
  fs.writeFileSync(file, syntheticSession("protected-id", project, [
    { type: "message", id: "private", message: { role: "user", content: canary } },
  ]));
  const state = createAdapter();
  const authorizedCwds: string[] = [];
  const catalog = new SessionCatalog(state.adapter, root, {
    authorizeCwd(cwd) {
      authorizedCwds.push(cwd);
      return false;
    },
    getPolicyGeneration: () => 1,
    refreshProjection: () => undefined,
  });
  try {
    const result = await catalog.scan();
    assert.deepEqual(authorizedCwds, [project]);
    assert.equal(result.discovered, 1);
    assert.equal(result.parsed, 0);
    assert.equal(result.parseBytes, 0);
    assert.ok(result.headerBytes <= 64 * 1024);
    assert.equal(state.commits[0]?.parsed.length, 0);
  } finally {
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog discards first-message and model metadata when policy protects during worker parse", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-policy-race-"));
  const project = path.join(root, "--policy-race-project--");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "race.jsonl");
  fs.writeFileSync(file, syntheticSession("policy-race-id", project, [
    {
      type: "message",
      id: "assistant-race",
      parentId: "user-a",
      timestamp: "2026-01-01T00:00:03.000Z",
      message: { role: "assistant", content: "MODEL_METADATA_CANARY", provider: "offline", model: "protected-race-model" },
    },
  ]));
  const state = createAdapter();
  let allowed = true;
  let generation = 10;
  let tightened = false;
  const catalog = new SessionCatalog(state.adapter, root, {
    authorizeCwd: () => allowed,
    getPolicyGeneration: () => generation,
    refreshProjection: () => undefined,
    onAuthorizedBodyTransferred() {
      if (tightened) return;
      tightened = true;
      allowed = false;
      generation++;
    },
  });
  try {
    const raced = await catalog.scan();
    assert.equal(tightened, true);
    assert.ok(raced.parseBytes > 0, "worker should parse the synthetic body before commit-time rejection");
    assert.equal(raced.parsed, 0);
    assert.equal(state.commits[0]?.parsed.length, 0);
    assert.equal(JSON.stringify(state.commits[0]?.parsed).includes("Public synthetic fixture text"), false);
    assert.equal(JSON.stringify(state.commits[0]?.parsed).includes("protected-race-model"), false);

    // The discarded fingerprint was not committed, so the next scan retries;
    // current protected policy still permits only the bounded header.
    const retry = await catalog.scan();
    assert.equal(retry.parsed, 0);
    assert.equal(retry.parseBytes, 0);
    assert.equal(state.commits[1]?.parsed.length, 0);
  } finally {
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("header-only staging becomes durable before external body admission", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-header-stage-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "external.jsonl"), syntheticSession("external-stage", project));
  const state = createAdapter();
  let staged = false;
  const token = (filePath: string, sessionId: string, cwd: string) => ({
    filePath, sessionId, projectId: "synthetic-standard-project", cwd, mutationVersion: 0,
  });
  state.adapter.classifyDurableSession = (filePath, sessionId, cwd) => (
    staged ? token(filePath, sessionId, cwd) : null
  );
  state.adapter.stageDurableSession = (filePath, header) => {
    staged = true;
    return { classification: token(filePath, header.id, header.cwd), imported: true };
  };
  state.adapter.commit = (scan) => {
    state.commits.push(scan);
    return { imported: 0, updated: scan.parsed.length, archivedLegacy: 0, changed: scan.parsed.length > 0 };
  };
  const catalog = new SessionCatalog(state.adapter, root, {
    authorizeCwd: () => true,
    getPolicyGeneration: () => 1,
    refreshProjection: () => undefined,
    onAuthorizedBodyTransferred() { assert.equal(staged, true); },
  });
  try {
    const result = await catalog.scan();
    assert.equal(result.imported, 1);
    assert.equal(result.parsed, 1);
    assert.equal(state.commits[0]?.parsed.length, 1);
  } finally {
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog rechecks the exact durable classification immediately before metadata commit", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-durable-race-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const file = path.join(project, "race.jsonl");
  fs.writeFileSync(file, syntheticSession("durable-race", project));
  const state = createAdapter();
  let mutationVersion = 1;
  state.adapter.classifyDurableSession = (filePath, sessionId, headerCwd) => ({
    filePath,
    sessionId,
    projectId: "synthetic-standard-project",
    cwd: headerCwd,
    mutationVersion,
  });
  let transferred = false;
  const catalog = new SessionCatalog(state.adapter, root, {
    authorizeCwd: () => true,
    getPolicyGeneration: () => 1,
    refreshProjection: () => undefined,
    onAuthorizedBodyTransferred() {
      transferred = true;
      mutationVersion++;
    },
  });
  try {
    const result = await catalog.scan();
    assert.equal(transferred, true);
    assert.ok(result.parseBytes > 0);
    assert.equal(result.parsed, 0);
    assert.equal(state.commits[0]?.parsed.length, 0);
  } finally {
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("generation bump during an old scan reports the discarded generation and a fresh scan commits metadata", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-generation-race-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  fs.writeFileSync(path.join(project, "race.jsonl"), syntheticSession("generation-race", project));
  const state = createAdapter();
  let bumped = false;
  let catalog!: SessionCatalog;
  catalog = new SessionCatalog(state.adapter, root, {
    authorizeCwd: () => true,
    getPolicyGeneration: () => 1,
    refreshProjection: () => undefined,
    onAuthorizedBodyTransferred() {
      if (bumped) return;
      bumped = true;
      catalog.bumpGeneration();
    },
  });
  try {
    const old = await catalog.scan();
    assert.equal(old.generation, 1, "discarded scan reports the generation it actually observed");
    assert.equal(state.commits.length, 0);
    const fresh = await catalog.scan();
    assert.ok(fresh.generation >= 2);
    assert.equal(fresh.parsed, 1);
    assert.equal(state.commits.length, 1);
    assert.equal(state.commits[0]?.generation, 2);
  } finally {
    await catalog.stop();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("catalog bounds worker admission and rejects oversized bodies before allocation", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-catalog-admission-bound-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  for (let index = 0; index < 12; index++) {
    fs.writeFileSync(path.join(project, `bounded-${index}.jsonl`), syntheticSession(`bounded-${index}`, project, [{
      type: "message",
      id: `bounded-body-${index}`,
      message: { role: "assistant", content: "bounded synthetic payload ".repeat(2_000) },
    }]));
  }
  const oversizedPath = path.join(project, "oversized.jsonl");
  fs.writeFileSync(oversizedPath, syntheticSession("oversized", project));
  fs.truncateSync(oversizedPath, MAX_CATALOG_BODY_BYTES + 1);
  const state = createAdapter();
  let maxInFlight = 0;
  const previousWorkers = process.env.WAYANG_SESSION_CATALOG_WORKERS;
  process.env.WAYANG_SESSION_CATALOG_WORKERS = "2";
  const catalog = new SessionCatalog(state.adapter, root, {
    authorizeCwd: () => true,
    getPolicyGeneration: () => 1,
    refreshProjection: () => undefined,
    observeWorkerTasksInFlight(count) { maxInFlight = Math.max(maxInFlight, count); },
  });
  try {
    const result = await catalog.scan();
    assert.equal(result.discovered, 13);
    assert.equal(result.parsed, 12);
    assert.equal(result.parseFailures, 1);
    assert.ok(maxInFlight <= 2, `worker admission reached ${maxInFlight}`);
    assert.ok(result.parseBytes < MAX_CATALOG_BODY_BYTES);
  } finally {
    await catalog.stop();
    if (previousWorkers === undefined) delete process.env.WAYANG_SESSION_CATALOG_WORKERS;
    else process.env.WAYANG_SESSION_CATALOG_WORKERS = previousWorkers;
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
  for (let index = 0; index < 400; index++) {
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
  const catalog = new SessionCatalog(state.adapter, root, {
    authorizeCwd: () => true,
    getPolicyGeneration: () => 1,
    refreshProjection: () => undefined,
  });
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
