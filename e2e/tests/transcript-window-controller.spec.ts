import { expect, test } from "@playwright/test";
import {
  MAX_TRANSCRIPT_WINDOW_CONTENT_BYTES,
  classifyTranscriptPageErrorCode,
  transcriptWindowValidationError,
} from "../../frontend/src/transcript/windowController";

function entry(id: string, text = id) {
  return { type: "user", id, parentId: null, message: { role: "user", content: text } };
}

function window(overrides: Record<string, unknown> = {}) {
  const messages = [entry("m-1")];
  return {
    type: "transcript_window",
    session_id: "session-a",
    selection_id: "selection-a",
    reason: "initial",
    transcript_epoch: "epoch-a",
    branch_tip_id: "m-1",
    messages,
    before_cursor: null,
    after_cursor: null,
    has_older: false,
    has_newer: false,
    message_count: messages.length,
    payload_bytes: Buffer.byteLength(JSON.stringify(messages)),
    ...overrides,
  };
}

test("window validator accepts bounded persisted rows and a separate ID-less streaming overlay", () => {
  const streaming = {
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "partial live response" }] },
  };
  expect(transcriptWindowValidationError(window({
    streaming_message: streaming,
    streaming_at_snapshot: true,
  }))).toBeNull();
});

test("window validator enforces IDs, count, byte, cursor, request, and anchor invariants", () => {
  expect(transcriptWindowValidationError(window({ messages: [entry("same"), entry("same")], message_count: 2 })))
    .toBe("duplicate_message_id");
  expect(transcriptWindowValidationError(window({ messages: [{ type: "user" }], message_count: 1 })))
    .toBe("missing_message_id");
  expect(transcriptWindowValidationError(window({ message_count: 2 }))).toBe("message_count_mismatch");
  expect(transcriptWindowValidationError(window({
    messages: [entry("huge", "x".repeat(MAX_TRANSCRIPT_WINDOW_CONTENT_BYTES))],
    message_count: 1,
  }))).toBe("content_limit_exceeded");
  expect(transcriptWindowValidationError(window({ has_older: true }))).toBe("before_cursor_edge_mismatch");
  expect(transcriptWindowValidationError(window({ reason: "prepend" }))).toBe("request_reason_mismatch");
  expect(transcriptWindowValidationError(window({
    anchor: { requested_id: "m-2", resolved_id: "m-2", status: "found" },
  }))).toBe("resolved_anchor_not_in_window");
});

test("window validator permits page-local opposite edges without redundant cursors", () => {
  expect(transcriptWindowValidationError(window({
    reason: "prepend",
    request_id: "page-before",
    has_older: true,
    before_cursor: "older",
    has_newer: true,
  }))).toBeNull();
  expect(transcriptWindowValidationError(window({
    reason: "append",
    request_id: "page-after",
    has_older: true,
    has_newer: true,
    after_cursor: "newer",
  }))).toBeNull();
});

test("terminal page identity errors reopen while operational failures remain retryable", () => {
  for (const code of ["expired_cursor", "unknown_cursor", "epoch_mismatch", "selection_mismatch", "transcript_revision_changed"]) {
    expect(classifyTranscriptPageErrorCode(code), code).toBe("terminal");
  }
  for (const code of ["transcript_page_failed", "temporary_io_error", undefined]) {
    expect(classifyTranscriptPageErrorCode(code), String(code)).toBe("transient");
  }
});
