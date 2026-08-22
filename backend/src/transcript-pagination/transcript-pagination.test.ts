import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptCursorError, TranscriptCursorRegistry } from "./cursor-registry.js";
import { readReverseTranscriptPage } from "./reverse-reader.js";
import { StructuralTranscriptIndex } from "./structural-index.js";

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
