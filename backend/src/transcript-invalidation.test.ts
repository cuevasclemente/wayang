import test from "node:test";
import assert from "node:assert/strict";
import { publishTranscriptInvalidation } from "./transcript-invalidation.js";
import { subscribeTranscriptInvalidationForSelection } from "./routes/ws.js";

test("one canonical invalidation reaches every current WebSocket selection for the session", () => {
  const first: Array<Record<string, unknown>> = [];
  const second: Array<Record<string, unknown>> = [];
  let firstRefreshes = 0;
  let secondRefreshes = 0;
  const unsubscribeFirst = subscribeTranscriptInvalidationForSelection({
    sessionId: "shared-session",
    selectionId: "selection-a",
    isCurrent: () => true,
    send: (message) => first.push(message),
    refresh: () => { firstRefreshes++; },
  });
  const unsubscribeSecond = subscribeTranscriptInvalidationForSelection({
    sessionId: "shared-session",
    selectionId: "selection-b",
    isCurrent: () => true,
    send: (message) => second.push(message),
    refresh: () => { secondRefreshes++; },
  });
  try {
    publishTranscriptInvalidation({
      sessionId: "other-session",
      catalogGeneration: 8,
      reason: "canonical_mutation",
    });
    assert.deepEqual(first, []);
    assert.deepEqual(second, []);

    publishTranscriptInvalidation({
      sessionId: "shared-session",
      catalogGeneration: 9,
      reason: "canonical_mutation",
    });
    assert.deepEqual(first, [{
      type: "transcript_invalidated",
      session_id: "shared-session",
      selection_id: "selection-a",
      catalog_generation: 9,
      reason: "canonical_mutation",
      reconnect_required: true,
    }]);
    assert.deepEqual(second, [{
      type: "transcript_invalidated",
      session_id: "shared-session",
      selection_id: "selection-b",
      catalog_generation: 9,
      reason: "canonical_mutation",
      reconnect_required: true,
    }]);
    assert.equal(firstRefreshes, 1);
    assert.equal(secondRefreshes, 1);
  } finally {
    unsubscribeFirst();
    unsubscribeSecond();
  }
});
