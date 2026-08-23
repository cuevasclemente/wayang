import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptCursorError, TranscriptCursorRegistry } from "./cursor-registry.js";
import {
  readReverseTranscriptPage,
  readTranscriptFileRevision,
  TranscriptPhysicalRowUnsupportedError,
  TRANSCRIPT_REVERSE_MAX_SCAN_BYTES,
} from "./reverse-reader.js";
import {
  StructuralTranscriptIndex,
  TRANSCRIPT_INDEX_MAX_READ_BYTES,
  TRANSCRIPT_INDEX_MAX_TOPOLOGY_ENTRIES,
} from "./structural-index.js";

function fixture(lines: unknown[], separator = "\n", finalNewline = true): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-transcript-page-"));
  const file = path.join(dir, "session.jsonl");
  fs.writeFileSync(file, lines.map((line) => JSON.stringify(line)).join(separator) + (finalNewline ? separator : ""));
  return { dir, file };
}

function header() {
  return { type: "session", version: 3, id: "session-1", cwd: "/synthetic" };
}

function message(id: string, parentId: string | null, text: string) {
  return { type: "message", id, parentId, timestamp: new Date(0).toISOString(), message: { role: "user", content: [{ type: "text", text }], timestamp: 0 } };
}

test("reverse reader follows only the active branch across siblings", () => {
  const { dir, file } = fixture([
    header(),
    message("root", null, "root"),
    message("left", "root", "left branch"),
    message("right", "root", "right branch ✓"),
  ], "\r\n", false);
  try {
    const page = readReverseTranscriptPage(file);
    assert.equal(page.branchTipId, "right");
    assert.deepEqual(page.entries.map((entry) => entry.id), ["root", "right"]);
    assert.equal(page.hasOlder, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reverse reader refuses symlink transcript paths", () => {
  const { dir, file } = fixture([header(), message("one", null, "safe target")]);
  const link = path.join(dir, "linked.jsonl");
  fs.symlinkSync(file, link);
  try {
    assert.throws(() => readReverseTranscriptPage(link));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reverse reader tolerates a malformed physical tail", () => {
  const { dir, file } = fixture([header(), message("one", null, "unicode λ")]);
  try {
    fs.appendFileSync(file, "{malformed-tail");
    const page = readReverseTranscriptPage(file);
    assert.equal(page.branchTipId, "one");
    assert.deepEqual(page.entries.map((entry) => entry.id), ["one"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reverse reader returns exact bounded before continuations", () => {
  const entries: Array<ReturnType<typeof header> | ReturnType<typeof message>> = [header()];
  let parent: string | null = null;
  for (let index = 0; index < 205; index++) {
    const id = `m-${index}`;
    entries.push(message(id, parent, `message ${index}`));
    parent = id;
  }
  const { dir, file } = fixture(entries);
  try {
    const latest = readReverseTranscriptPage(file, { maxRows: 200 });
    assert.equal(latest.entries.length, 200);
    assert.equal(latest.entries[0].id, "m-5");
    assert.ok(latest.continuation);
    const before = readReverseTranscriptPage(file, { continuation: latest.continuation!, maxRows: 200 });
    assert.deepEqual(before.entries.map((entry) => entry.id), ["m-0", "m-1", "m-2", "m-3", "m-4"]);
    assert.equal(before.hasOlder, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reverse reader returns a stable placeholder for a newest row beyond the scan ceiling", () => {
  const huge = message("huge-tip", "root", "z".repeat(TRANSCRIPT_REVERSE_MAX_SCAN_BYTES + 1024 * 1024));
  const { dir, file } = fixture([header(), message("root", null, "root"), huge]);
  try {
    const latest = readReverseTranscriptPage(file);
    assert.equal(latest.branchTipId, "huge-tip");
    assert.equal(latest.entries.length, 1);
    assert.equal(latest.entries[0].id, "huge-tip");
    assert.equal(latest.entries[0].customType, "wayang-transcript-event-placeholder-v1");
    assert.ok(latest.continuation);
    const before = readReverseTranscriptPage(file, { continuation: latest.continuation! });
    assert.deepEqual(before.entries.map((entry) => entry.id), ["root"]);
    assert.equal(before.hasOlder, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reverse reader pages an oversized interior ancestor by stable envelope", () => {
  const entries: Array<ReturnType<typeof header> | ReturnType<typeof message>> = [
    header(),
    message("root", null, "root"),
    message("huge-interior", "root", "q".repeat(TRANSCRIPT_REVERSE_MAX_SCAN_BYTES + 1024 * 1024)),
  ];
  let parent = "huge-interior";
  for (let index = 0; index < 200; index++) {
    const id = `tail-${index}`;
    entries.push(message(id, parent, `tail ${index}`));
    parent = id;
  }
  const { dir, file } = fixture(entries);
  try {
    const latest = readReverseTranscriptPage(file);
    assert.equal(latest.entries.length, 200);
    assert.ok(latest.continuation);
    const interior = readReverseTranscriptPage(file, { continuation: latest.continuation! });
    assert.equal(interior.entries[0]?.id, "huge-interior");
    assert.equal(interior.entries[0]?.customType, "wayang-transcript-event-placeholder-v1");
    assert.ok(interior.continuation);
    const earliest = readReverseTranscriptPage(file, { continuation: interior.continuation! });
    assert.deepEqual(earliest.entries.map((entry) => entry.id), ["root"]);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("reverse boundary scan ceiling fails with a typed bounded error", () => {
  const { dir, file } = fixture([header(), message("too-wide", null, "x".repeat(4_096))]);
  try {
    assert.throws(
      () => readReverseTranscriptPage(file, { maxScanBytes: 512, maxBoundaryScanBytes: 1_024 }),
      (error) => error instanceof TranscriptPhysicalRowUnsupportedError
        && error.code === "transcript_physical_row_unsupported",
    );
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test("opaque cursors reject selection, epoch, direction, expiry, and eviction mismatches", () => {
  let now = 10;
  const registry = new TranscriptCursorRegistry<{ offset: number }>({ maxEntries: 1, ttlMs: 5, now: () => now });
  const binding = { sessionId: "s", selectionId: "sel", transcriptEpoch: "epoch", direction: "before" as const };
  const first = registry.issue(binding, { offset: 1 });
  assert.throws(() => registry.resolve(first, { ...binding, selectionId: "other" }),
    (error) => error instanceof TranscriptCursorError && error.code === "selection_mismatch");
  assert.throws(() => registry.resolve(first, { ...binding, transcriptEpoch: "new" }),
    (error) => error instanceof TranscriptCursorError && error.code === "epoch_mismatch");
  assert.throws(() => registry.resolve(first, { ...binding, direction: "after" }),
    (error) => error instanceof TranscriptCursorError && error.code === "direction_mismatch");
  const second = registry.issue(binding, { offset: 2 });
  assert.throws(() => registry.resolve(first, binding),
    (error) => error instanceof TranscriptCursorError && error.code === "unknown_cursor");
  now = 20;
  assert.throws(() => registry.resolve(second, binding),
    (error) => error instanceof TranscriptCursorError && error.code === "expired_cursor");
});

test("structural worker streams multi-chunk Unicode CRLF with malformed lines and no final newline", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-transcript-worker-stream-"));
  const file = path.join(dir, "session.jsonl");
  const rows = [
    JSON.stringify(header()),
    JSON.stringify(message("unicode-root", null, "λ".repeat(40_000))),
    "{malformed",
    JSON.stringify(message("unicode-middle", "unicode-root", "雪".repeat(40_000))),
    JSON.stringify(message("unicode-tip", "unicode-middle", "終".repeat(40_000))),
  ];
  fs.writeFileSync(file, rows.join("\r\n"));
  const index = new StructuralTranscriptIndex(path.join(dir, "transcript-index.db"));
  try {
    const selection = await index.around("unicode-session", file, "unicode-middle", 20);
    assert.equal(selection.revision.complete, true);
    assert.equal(selection.revision.size, fs.statSync(file).size);
    assert.equal(selection.revision.headerDigest, readTranscriptFileRevision(file).headerDigest,
      "worker revision digest must retain the physical CR before LF");
    assert.deepEqual(selection.rows.map((row) => row.eventId), ["unicode-root", "unicode-middle", "unicode-tip"]);
    const bytes = fs.readFileSync(file);
    for (const row of selection.rows) {
      const physical = bytes.subarray(row.sourceOffset, row.sourceOffset + row.sourceLength).toString("utf8").trim();
      assert.equal(JSON.parse(physical).id, row.eventId);
    }
  } finally {
    await index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("structural indexed reads enforce one aggregate source-byte budget", async () => {
  const entries: Array<ReturnType<typeof header> | ReturnType<typeof message>> = [header()];
  let parentId: string | null = null;
  for (let index = 0; index < 120; index++) {
    const id = `bounded-${index}`;
    entries.push(message(id, parentId, `${index}:` + "r".repeat(8 * 1024)));
    parentId = id;
  }
  const { dir, file } = fixture(entries);
  const index = new StructuralTranscriptIndex(path.join(dir, "transcript-index.db"));
  try {
    const selection = await index.around("bounded-session", file, "bounded-60", 120);
    const read = index.readBoundedEntries(selection.revision, selection.rows, {
      preference: "around",
      anchorEventId: "bounded-60",
    });
    assert.ok(read.rows.some((row) => row.eventId === "bounded-60"));
    assert.ok(read.rows.length < selection.rows.length, "aggregate budget must reduce the indexed source set");
    assert.ok(read.sourceBytesRead <= TRANSCRIPT_INDEX_MAX_READ_BYTES);
    assert.equal(index.getReadInstrumentation().lastSourceBytesRead, read.sourceBytesRead);
    const ordinals = read.rows.map((row) => row.visibleOrdinal);
    assert.ok(ordinals.every((ordinal, position) => position === 0 || ordinal === ordinals[position - 1] + 1));
  } finally {
    await index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("structural workers enforce concurrency two and bounded queue", async () => {
  const fixtures = [0, 1, 2].map((index) => fixture([
    { ...header(), id: `session-${index}` },
    message(`root-${index}`, null, `root ${index}`),
  ]));
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-structural-concurrency-"));
  const index = new StructuralTranscriptIndex(path.join(dbDir, "index.db"), {
    workerDelayMsForTests: 250,
    workerTimeoutMs: 2_000,
  });
  try {
    const pending = fixtures.map(({ file }, number) => index.ensure(`worker-${number}`, file));
    await new Promise((resolve) => setTimeout(resolve, 40));
    const running = index.getWorkerInstrumentation();
    assert.equal(running.active, 2);
    assert.equal(running.peakActive, 2);
    assert.equal(running.queued, 1);
    await Promise.all(pending);
    assert.equal(index.getWorkerInstrumentation().workersStarted, 3);
  } finally {
    await index.close();
    fixtures.forEach(({ dir }) => fs.rmSync(dir, { recursive: true, force: true }));
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("structural worker timeout and close cancel active builds", async () => {
  const timeoutFixture = fixture([header(), message("timeout", null, "timeout")]);
  const timeoutIndex = new StructuralTranscriptIndex(path.join(timeoutFixture.dir, "timeout.db"), {
    workerDelayMsForTests: 500,
    workerTimeoutMs: 100,
  });
  try {
    await assert.rejects(timeoutIndex.ensure("timeout", timeoutFixture.file));
    assert.equal(timeoutIndex.getWorkerInstrumentation().timeouts, 1);
  } finally {
    await timeoutIndex.close();
    fs.rmSync(timeoutFixture.dir, { recursive: true, force: true });
  }

  const closeFixture = fixture([header(), message("close", null, "close")]);
  const closeIndex = new StructuralTranscriptIndex(path.join(closeFixture.dir, "close.db"), {
    workerDelayMsForTests: 1_000,
    workerTimeoutMs: 2_000,
  });
  const pending = closeIndex.ensure("close", closeFixture.file);
  await new Promise((resolve) => setTimeout(resolve, 40));
  await closeIndex.close();
  await assert.rejects(pending);
  fs.rmSync(closeFixture.dir, { recursive: true, force: true });
});

test("staged structural publication yields and recovers after mid-publish invalidation", async () => {
  const entries: Array<ReturnType<typeof header> | ReturnType<typeof message>> = [header()];
  let parent: string | null = null;
  for (let number = 0; number < 2_500; number++) {
    const id = `batch-${number}`;
    entries.push(message(id, parent, `batch ${number}`));
    parent = id;
  }
  const { dir, file } = fixture(entries);
  let invalidateOnce = true;
  let batchCount = 0;
  let canaryRan = false;
  setImmediate(() => { canaryRan = true; });
  let index!: StructuralTranscriptIndex;
  index = new StructuralTranscriptIndex(path.join(dir, "index.db"), {
    afterPublishBatchForTests(sessionId) {
      batchCount++;
      if (invalidateOnce) {
        invalidateOnce = false;
        index.purge(sessionId);
      }
    },
  });
  try {
    await assert.rejects(index.ensure("batched", file), /invalidated/u);
    const recovered = await index.ensure("batched", file);
    assert.equal(recovered.complete, true);
    assert.equal(recovered.branchTipId, "batch-2499");
    assert.ok(batchCount >= 4);
    assert.equal(canaryRan, true);
  } finally {
    await index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("structural topology result limit publishes typed incomplete revision", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-topology-limit-"));
  const file = path.join(dir, "session.jsonl");
  const lines = [JSON.stringify(header())];
  let parent: string | null = null;
  for (let number = 0; number < TRANSCRIPT_INDEX_MAX_TOPOLOGY_ENTRIES; number++) {
    const id = `limit-${number}`;
    lines.push(JSON.stringify(message(id, parent, "x")));
    parent = id;
  }
  fs.writeFileSync(file, lines.join("\n") + "\n");
  const index = new StructuralTranscriptIndex(path.join(dir, "index.db"));
  try {
    const revision = await index.ensure("limited", file);
    assert.equal(revision.complete, false);
    assert.equal(revision.error, "topology_entry_limit");
    await assert.rejects(index.around("limited", file, "limit-1", 20), /incomplete/u);
  } finally {
    await index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("structural builds are isolated by session, canonical path, and revision", async () => {
  const firstFixture = fixture([header(), message("first", null, "first path")]);
  const secondFixture = fixture([header(), message("second", null, "second path")]);
  const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-transcript-index-race-"));
  let releaseFirst!: () => void;
  let firstPaused!: () => void;
  const firstPauseReached = new Promise<void>((resolve) => { firstPaused = resolve; });
  const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
  const canonicalFirst = path.resolve(firstFixture.file);
  let firstPublishAttempts = 0;
  const index = new StructuralTranscriptIndex(path.join(dbDir, "transcript-index.db"), {
    async beforePublishForTests(_sessionId, filePath) {
      if (filePath !== canonicalFirst) return;
      firstPublishAttempts++;
      firstPaused();
      await firstGate;
    },
  });
  try {
    const staleBuild = index.ensure("shared-session", firstFixture.file);
    await firstPauseReached;
    const coalescedStaleBuild = index.ensure("shared-session", firstFixture.file);
    const current = await index.ensure("shared-session", secondFixture.file);
    assert.equal(current.filePath, path.resolve(secondFixture.file));
    releaseFirst();
    await assert.rejects(staleBuild, /invalidated/u);
    await assert.rejects(coalescedStaleBuild, /invalidated/u);
    assert.equal(firstPublishAttempts, 1, "identical session/path/revision builds must coalesce");
    const selected = await index.around("shared-session", secondFixture.file, "second", 20);
    assert.equal(selected.anchor?.status, "found");
    assert.equal(selected.revision.filePath, path.resolve(secondFixture.file));
  } finally {
    releaseFirst();
    await index.close();
    fs.rmSync(firstFixture.dir, { recursive: true, force: true });
    fs.rmSync(secondFixture.dir, { recursive: true, force: true });
    fs.rmSync(dbDir, { recursive: true, force: true });
  }
});

test("large append bypasses synchronous append refresh and yields to worker build", async () => {
  const { dir, file } = fixture([header(), message("root", null, "root")]);
  let appendRefreshes = 0;
  let workerPublications = 0;
  const index = new StructuralTranscriptIndex(path.join(dir, "transcript-index.db"), {
    onAppendRefreshForTests() { appendRefreshes++; },
    beforePublishForTests() { workerPublications++; },
  });
  try {
    await index.ensure("large-append", file);
    workerPublications = 0;
    fs.appendFileSync(file, JSON.stringify(message("large", "root", "a".repeat(1024 * 1024 + 64 * 1024))) + "\n");
    let eventLoopTurnObserved = false;
    const refresh = index.ensure("large-append", file);
    await new Promise<void>((resolve) => setImmediate(() => {
      eventLoopTurnObserved = true;
      resolve();
    }));
    const revision = await refresh;
    assert.equal(eventLoopTurnObserved, true);
    assert.equal(appendRefreshes, 0);
    assert.equal(workerPublications, 1);
    assert.equal(revision.branchTipId, "large");
  } finally {
    await index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("structural index resolves active, off-branch, and appended anchors without storing content", async () => {
  const { dir, file } = fixture([
    header(),
    message("root", null, "private synthetic root"),
    message("off", "root", "off branch"),
    message("tip", "root", "active tip"),
  ]);
  const index = new StructuralTranscriptIndex(path.join(dir, "transcript-index.db"));
  try {
    const active = await index.around("session-1", file, "root", 20);
    assert.equal(active.anchor?.status, "found");
    assert.deepEqual(active.rows.map((row) => row.eventId), ["root", "tip"]);
    const off = await index.around("session-1", file, "off", 20);
    assert.equal(off.anchor?.status, "off_branch");
    const missing = await index.around("session-1", file, "missing", 20);
    assert.equal(missing.anchor?.status, "missing");

    fs.appendFileSync(file, JSON.stringify(message("next", "tip", "descendant append")) + "\n");
    const appended = await index.around("session-1", file, "next", 20);
    assert.equal(appended.anchor?.status, "found");
    assert.equal(appended.revision.transcriptEpoch, active.revision.transcriptEpoch, "descendant append preserves epoch");

    fs.appendFileSync(file, JSON.stringify(message("new-branch", "root", "ancestor branch append")) + "\n");
    const branched = await index.around("session-1", file, "new-branch", 20);
    assert.equal(branched.anchor?.status, "found");
    assert.notEqual(branched.revision.transcriptEpoch, active.revision.transcriptEpoch, "active branch change creates a new epoch");
    const dbBytes = fs.readFileSync(path.join(dir, "transcript-index.db"));
    assert.equal(dbBytes.includes(Buffer.from("private synthetic root")), false, "structural DB remains content-free");

    const replacement = path.join(dir, "replacement.jsonl");
    fs.writeFileSync(replacement, [header(), message("replacement", null, "replacement bytes")]
      .map((row) => JSON.stringify(row)).join("\n") + "\n");
    fs.renameSync(replacement, file);
    const rewritten = await index.around("session-1", file, "replacement", 20);
    assert.equal(rewritten.anchor?.status, "found");
    assert.notEqual(rewritten.revision.transcriptEpoch, branched.revision.transcriptEpoch, "inode replacement creates a new epoch");

    index.purge("session-1");
    const rebuilt = await index.around("session-1", file, "replacement", 20);
    assert.notEqual(rebuilt.revision.transcriptEpoch, rewritten.revision.transcriptEpoch, "delete/policy purge invalidates the structural epoch");
  } finally {
    await index.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
