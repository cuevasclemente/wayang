import test from "node:test";
import * as assert from "node:assert/strict";
import { parseTranscriptNegotiation, serializeTranscriptProtocolConfirmation } from "./ws.js";

test("window-v1 negotiation is explicit and selection-bound", () => {
  assert.deepEqual(parseTranscriptNegotiation(new URLSearchParams(), "selection"), {
    protocol: null,
    intent: "latest",
  });
  assert.deepEqual(parseTranscriptNegotiation(new URLSearchParams({ transcript_protocol: "window-v1" }), null), {
    protocol: null,
    intent: "latest",
  });
  assert.deepEqual(parseTranscriptNegotiation(new URLSearchParams({
    transcript_protocol: "window-v1",
    transcript_intent: "around",
    transcript_anchor_id: "message-7",
  }), "selection"), {
    protocol: "window-v1",
    intent: "around",
    anchorId: "message-7",
  });
});

test("switch_session uses the optional transcript envelope", () => {
  assert.deepEqual(parseTranscriptNegotiation({
    type: "switch_session",
    session_id: "session",
    transcript: { protocol: "window-v1", intent: "around", anchor_id: "message-9" },
  }, "selection"), {
    protocol: "window-v1",
    intent: "around",
    anchorId: "message-9",
  });
});

test("server confirms the exact negotiated projection", () => {
  assert.deepEqual(serializeTranscriptProtocolConfirmation("session", "selection", {
    protocol: "window-v1",
    intent: "around",
    anchorId: "message-9",
  }), {
    type: "transcript_protocol",
    session_id: "session",
    selection_id: "selection",
    protocol: "window-v1",
    intent: "around",
    anchor_id: "message-9",
  });
});

test("invalid or missing around anchors safely negotiate latest", () => {
  assert.deepEqual(parseTranscriptNegotiation({
    transcript: {
      protocol: "window-v1",
      intent: "around",
      anchor_id: "bad\u0000anchor",
    },
  }, "selection"), {
    protocol: "window-v1",
    intent: "latest",
  });
});
