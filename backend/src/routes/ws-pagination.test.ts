import test from "node:test";
import * as assert from "node:assert/strict";
import {
  parseTranscriptNegotiation,
  serializeInvalidTranscriptPageRequest,
  serializeTranscriptPageError,
  serializeTranscriptPageGateFailure,
  serializeTranscriptProtocolConfirmation,
  transcriptPageRequestCorrelation,
} from "./ws.js";

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

test("correlated transcript page failures preserve the exact edge identity", () => {
  const message = { type: "transcript_page_request", request_id: "page.before-7", direction: "before", cursor: "" };
  assert.deepEqual(transcriptPageRequestCorrelation(message, "selection"), {
    requestId: "page.before-7",
    direction: "before",
    selectionId: "selection",
  });
  assert.deepEqual(serializeInvalidTranscriptPageRequest({
    sessionId: "session",
    selectionId: "selection",
    message,
  }), {
    type: "transcript_page_error",
    session_id: "session",
    selection_id: "selection",
    request_id: "page.before-7",
    direction: "before",
    code: "invalid_transcript_page_request",
    error: "Transcript page request is invalid",
  });
});

test("correlated paging gates terminate the exact in-flight edge", () => {
  assert.deepEqual(serializeTranscriptPageGateFailure({
    sessionId: "session",
    selectionId: "selection",
    message: { type: "transcript_page_request", request_id: "page-2", direction: "after" },
    code: "transcript_page_not_ready",
    error: "Session is not ready for transcript paging",
  }), {
    type: "transcript_page_error",
    session_id: "session",
    selection_id: "selection",
    request_id: "page-2",
    direction: "after",
    code: "transcript_page_not_ready",
    error: "Session is not ready for transcript paging",
  });
});

test("uncorrelatable transcript page failures remain generic", () => {
  const failure = serializeInvalidTranscriptPageRequest({
    sessionId: "session",
    selectionId: "selection",
    message: { type: "transcript_page_request", request_id: "bad id", direction: "sideways" },
  });
  assert.equal(failure.type, "error");
  assert.equal("request_id" in failure, false);
  assert.equal("direction" in failure, false);
});

test("transcript page error code and text are bounded", () => {
  const failure = serializeTranscriptPageError({
    sessionId: "session",
    selectionId: "selection",
    requestId: "page-1",
    direction: "after",
    code: "X".repeat(100),
    error: `failure\u202e${"λ".repeat(1_000)}`,
  });
  assert.equal(failure.code, "transcript_page_failed");
  assert.equal(failure.direction, "after");
  assert.ok(Buffer.byteLength(failure.error, "utf8") <= 512);
  assert.equal(failure.error.includes("\u202e"), false);
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
