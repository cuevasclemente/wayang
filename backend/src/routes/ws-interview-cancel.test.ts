import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { close, failNextCommitStoreMutationPersistenceForTests, init } from "../db.js";
import { createOpenInterview, getInterviewForSession } from "../interviews.js";
import { WAYANG_WEBSOCKET_SUBMISSION_CONTEXT } from "../interview-provenance.js";
import { handleInterviewCancel, handleInterviewResponse } from "./ws.js";

const QUESTIONS = [{
  id: "q1",
  label: "Synthetic",
  prompt: "Choose",
  options: [{ value: "yes", label: "Yes" }],
  allowOther: true,
}];

function withStore(fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-ws-interview-cancel-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    fn();
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function wire(): { ws: WebSocket; messages: unknown[] } {
  const messages: unknown[] = [];
  return {
    ws: {
      readyState: WebSocket.OPEN,
      send(value: string) { messages.push(JSON.parse(value)); },
    } as unknown as WebSocket,
    messages,
  };
}

test("interview cancellation acknowledges only the exact open session/request", () => withStore(() => {
  createOpenInterview({
    requestId: "cancel-exact",
    sessionId: "owner-session",
    toolName: "questionnaire",
    questions: QUESTIONS,
  });

  const wrong = wire();
  handleInterviewCancel(wrong.ws, "other-session", "selection-owner", { session_id: "other-session", selection_id: "selection-owner", requestId: "cancel-exact" });
  assert.deepEqual(wrong.messages, [{
    type: "interview_cancel_ack",
    session_id: "other-session",
    selection_id: "selection-owner",
    requestId: "cancel-exact",
    sessionId: "other-session",
    status: "rejected",
    errorCode: "not_found",
    error: "Interview request was not found or is no longer open",
  }]);
  assert.equal(getInterviewForSession("owner-session", "cancel-exact")?.status, "open");

  const exact = wire();
  handleInterviewCancel(exact.ws, "owner-session", "selection-owner", { session_id: "owner-session", selection_id: "selection-owner", requestId: "cancel-exact" });
  assert.deepEqual(exact.messages, [{
    type: "interview_cancel_ack",
    session_id: "owner-session",
    selection_id: "selection-owner",
    requestId: "cancel-exact",
    sessionId: "owner-session",
    status: "cancelled",
    duplicate: false,
  }]);
  assert.equal(getInterviewForSession("owner-session", "cancel-exact")?.status, "cancelled");

  const replay = wire();
  handleInterviewCancel(replay.ws, "owner-session", "selection-owner", { session_id: "owner-session", selection_id: "selection-owner", requestId: "cancel-exact" });
  assert.deepEqual(replay.messages, [{
    type: "interview_cancel_ack",
    session_id: "owner-session",
    selection_id: "selection-owner",
    requestId: "cancel-exact",
    sessionId: "owner-session",
    status: "cancelled",
    duplicate: true,
  }]);
  assert.equal(getInterviewForSession("owner-session", "cancel-exact")?.status, "cancelled");
}));

test("stale same-session selections cannot submit or cancel questionnaires", () => withStore(() => {
  createOpenInterview({
    requestId: "stale-response",
    sessionId: "owner-session",
    toolName: "questionnaire",
    questions: QUESTIONS,
  });
  createOpenInterview({
    requestId: "stale-cancel",
    sessionId: "owner-session",
    toolName: "questionnaire",
    questions: QUESTIONS,
  });

  const response = wire();
  handleInterviewResponse(response.ws, "owner-session", "new-selection", {
    session_id: "owner-session",
    selection_id: "old-selection",
    requestId: "stale-response",
    answers: [{ id: "q1", value: "yes", label: "Yes", wasCustom: false }],
  }, WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
  assert.equal((response.messages[0] as any)?.errorCode, "selection_mismatch");
  assert.equal((response.messages[0] as any)?.selection_id, "new-selection");
  assert.equal(getInterviewForSession("owner-session", "stale-response")?.status, "open");

  const cancellation = wire();
  handleInterviewCancel(cancellation.ws, "owner-session", "new-selection", {
    session_id: "owner-session",
    selection_id: "old-selection",
    requestId: "stale-cancel",
  });
  assert.equal((cancellation.messages[0] as any)?.errorCode, "selection_mismatch");
  assert.equal((cancellation.messages[0] as any)?.selection_id, "new-selection");
  assert.equal(getInterviewForSession("owner-session", "stale-cancel")?.status, "open");
}));

test("interview response rejects persistence failure without resolving the gate", () => withStore(() => {
  createOpenInterview({
    requestId: "response-persistence-failure",
    sessionId: "owner-session",
    toolName: "questionnaire",
    questions: QUESTIONS,
  });
  failNextCommitStoreMutationPersistenceForTests(new Error("private synthetic path detail"));

  const response = wire();
  assert.doesNotThrow(() => handleInterviewResponse(response.ws, "owner-session", "selection-owner", {
    session_id: "owner-session",
    selection_id: "selection-owner",
    requestId: "response-persistence-failure",
    answers: [{ id: "q1", value: "yes", label: "Yes", wasCustom: false }],
  }, WAYANG_WEBSOCKET_SUBMISSION_CONTEXT));
  assert.deepEqual(response.messages, [{
    type: "interview_response_ack",
    session_id: "owner-session",
    selection_id: "selection-owner",
    requestId: "response-persistence-failure",
    sessionId: "owner-session",
    status: "rejected",
    errorCode: "persistence_failed",
    error: "Response could not be persisted. Retry when ready.",
  }]);
  assert.equal(getInterviewForSession("owner-session", "response-persistence-failure")?.status, "open");
}));

test("interview cancellation rejects persistence failure without resolving the gate", () => withStore(() => {
  createOpenInterview({
    requestId: "cancel-persistence-failure",
    sessionId: "owner-session",
    toolName: "questionnaire",
    questions: QUESTIONS,
  });
  failNextCommitStoreMutationPersistenceForTests(new Error("private synthetic path detail"));

  const response = wire();
  assert.doesNotThrow(() => handleInterviewCancel(response.ws, "owner-session", "selection-owner", {
    session_id: "owner-session",
    selection_id: "selection-owner",
    requestId: "cancel-persistence-failure",
  }));
  assert.deepEqual(response.messages, [{
    type: "interview_cancel_ack",
    session_id: "owner-session",
    selection_id: "selection-owner",
    requestId: "cancel-persistence-failure",
    sessionId: "owner-session",
    status: "rejected",
    errorCode: "persistence_failed",
    error: "Cancellation could not be persisted. Retry when ready.",
  }]);
  assert.equal(getInterviewForSession("owner-session", "cancel-persistence-failure")?.status, "open");
}));
