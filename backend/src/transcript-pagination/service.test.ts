import test from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { TranscriptPaginationService } from "./service.js";
import { StructuralTranscriptIndex } from "./structural-index.js";
import { TRANSCRIPT_PAGE_MAX_BYTES, TRANSCRIPT_PAGE_MAX_ROWS } from "./reverse-reader.js";

function makeTranscript(count: number, options: { regularSize?: number; hugeLast?: boolean } = {}): { dir: string; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-window-service-"));
  const file = path.join(dir, "session.jsonl");
  const rows: any[] = [{ type: "session", version: 3, id: "s", cwd: "/synthetic" }];
  let parentId: string | null = null;
  for (let index = 0; index < count; index++) {
    const id = `m-${index}`;
    rows.push({
      type: "message", id, parentId, timestamp: new Date(index).toISOString(),
      message: { role: index % 2 ? "assistant" : "user", content: [{ type: "text", text: index === count - 1 && options.hugeLast !== false
        ? "x".repeat(600_000)
        : options.regularSize ? `${index}:` + "y".repeat(options.regularSize) : `synthetic ${index}` }], timestamp: index },
    });
    parentId = id;
  }
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { dir, file };
}

test("modern latest and before windows remain bounded and request-correlated", async () => {
  const { dir, file } = makeTranscript(205);
  const service = new TranscriptPaginationService(new StructuralTranscriptIndex(path.join(dir, "index.db")));
  try {
    const latest = await service.open({ sessionId: "s", selectionId: "selection-a", sessionFile: file, intent: "latest" });
    assert.equal(latest.type, "transcript_window");
    assert.ok(latest.message_count <= TRANSCRIPT_PAGE_MAX_ROWS);
    assert.ok(latest.payload_bytes <= TRANSCRIPT_PAGE_MAX_BYTES);
    assert.ok(Buffer.byteLength(JSON.stringify(latest)) <= TRANSCRIPT_PAGE_MAX_BYTES);
    assert.equal(latest.messages.at(-1)?.id, "m-204");
    assert.equal((latest.messages.at(-1)?.message as any)?.customType, "wayang-transcript-event-placeholder-v1");
    assert.ok(latest.before_cursor);

    const before = await service.page({
      sessionId: "s", selectionId: "selection-a", sessionFile: file,
      requestId: "page-1", direction: "before", cursor: latest.before_cursor!,
    });
    assert.equal(before.request_id, "page-1");
    assert.equal(before.reason, "prepend");
    assert.equal(before.has_older, false);
    assert.deepEqual(before.messages.map((row) => row.id), ["m-0", "m-1", "m-2", "m-3", "m-4"]);

    service.invalidateSession("s");
    await assert.rejects(() => service.page({
      sessionId: "s", selectionId: "selection-a", sessionFile: file,
      requestId: "stale", direction: "before", cursor: latest.before_cursor!,
    }));
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("a branch-changing append invalidates cold reverse cursors", async () => {
  const { dir, file } = makeTranscript(205, { hugeLast: false });
  const service = new TranscriptPaginationService(new StructuralTranscriptIndex(path.join(dir, "index.db")));
  try {
    const latest = await service.open({ sessionId: "s", selectionId: "selection-branch", sessionFile: file, intent: "latest" });
    assert.ok(latest.before_cursor);
    fs.appendFileSync(file, JSON.stringify({
      type: "message", id: "new-branch", parentId: "m-0",
      message: { role: "assistant", content: [{ type: "text", text: "branch changed" }] },
    }) + "\n");
    await assert.rejects(() => service.page({
      sessionId: "s", selectionId: "selection-branch", sessionFile: file,
      requestId: "stale-branch", direction: "before", cursor: latest.before_cursor!,
    }));
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("byte trimming keeps a gap-free reverse cursor boundary", async () => {
  const { dir, file } = makeTranscript(205, { regularSize: 4_000, hugeLast: false });
  const service = new TranscriptPaginationService(new StructuralTranscriptIndex(path.join(dir, "index.db")));
  try {
    const latest = await service.open({ sessionId: "s", selectionId: "selection-bytes", sessionFile: file, intent: "latest" });
    assert.ok(latest.before_cursor);
    const before = await service.page({
      sessionId: "s", selectionId: "selection-bytes", sessionFile: file,
      requestId: "bytes-before", direction: "before", cursor: latest.before_cursor!,
    });
    const ids = [...before.messages, ...latest.messages].map((row) => row.id);
    assert.deepEqual(ids, Array.from({ length: 205 }, (_, index) => `m-${index}`));
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("around windows resolve exact active anchors and issue forward cursors", async () => {
  const { dir, file } = makeTranscript(300);
  const service = new TranscriptPaginationService(new StructuralTranscriptIndex(path.join(dir, "index.db")));
  try {
    const around = await service.open({
      sessionId: "s", selectionId: "selection-b", sessionFile: file,
      intent: "around", anchorId: "m-10",
    });
    assert.equal(around.anchor?.status, "found");
    assert.equal(around.anchor?.resolved_id, "m-10");
    assert.ok(around.messages.some((row) => row.id === "m-10"));
    assert.ok(around.after_cursor);
    const after = await service.page({
      sessionId: "s", selectionId: "selection-b", sessionFile: file,
      requestId: "after-1", direction: "after", cursor: around.after_cursor!,
    });
    assert.equal(after.request_id, "after-1");
    assert.equal(after.reason, "append");
    assert.ok(after.messages.some((row) => row.id === "m-299"));
    assert.ok(after.payload_bytes <= TRANSCRIPT_PAGE_MAX_BYTES);
  } finally {
    await service.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
