import test from "node:test";
import assert from "node:assert/strict";
import { serializeHistoryEntries } from "./pi-bridge.js";
import {
  DELETED_EVENT_TOMBSTONE,
  INVALIDATED_DERIVED_EVENT_TOMBSTONE,
} from "./transcript-mutation-markers.js";

test("edited canonical entries surface trusted mutation status in serialized history", () => {
  const rows = serializeHistoryEntries([{
    type: "message",
    id: "edited-message",
    parentId: null,
    timestamp: "2026-08-18T00:00:00.000Z",
    wayangMutation: { version: 1, kind: "edited", at: "2026-08-18T00:01:00.000Z" },
    message: { role: "user", content: [{ type: "text", text: "replacement" }] },
  }, {
    type: "message",
    id: "untrusted-marker",
    parentId: "edited-message",
    timestamp: "2026-08-18T00:02:00.000Z",
    wayangMutation: { version: 999, kind: "edited", at: "not-a-time" },
    message: { role: "assistant", content: [{ type: "text", text: "ordinary" }] },
  }]);

  assert.equal(rows[0]?.id, "edited-message");
  assert.equal(rows[0]?.mutation_status, "edited");
  assert.equal(rows[1]?.id, "untrusted-marker");
  assert.equal(Object.hasOwn(rows[1]!, "mutation_status"), false);
});

test("deleted targets serialize as visible content-free same-topology placeholders while derived invalidations stay hidden", () => {
  const rows = serializeHistoryEntries([{
    type: "custom",
    id: "deleted-target",
    parentId: "parent-event",
    timestamp: "2026-08-18T00:00:00.000Z",
    customType: DELETED_EVENT_TOMBSTONE,
    data: { version: 1 },
  }, {
    type: "custom",
    id: "invalidated-summary",
    parentId: "deleted-target",
    timestamp: "2026-08-18T00:01:00.000Z",
    customType: INVALIDATED_DERIVED_EVENT_TOMBSTONE,
    data: { version: 1 },
  }]);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0], {
    type: "custom",
    id: "deleted-target",
    parentId: "parent-event",
    mutation_status: "deleted",
    message: {
      role: "custom",
      customType: DELETED_EVENT_TOMBSTONE,
      timestamp: "2026-08-18T00:00:00.000Z",
      display: true,
    },
  });
  assert.equal(Object.hasOwn(rows[0]!.message as object, "content"), false);
  assert.equal(JSON.stringify(rows).includes("invalidated-summary"), false);
});
