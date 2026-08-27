import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, init } from "./db.js";
import { getInterviewForSession, submitInterview as submitInterviewWithContext } from "./interviews.js";
import { PiInterviewBridge } from "./interview-bridge.js";
import { WAYANG_WEBSOCKET_SUBMISSION_CONTEXT } from "./interview-provenance.js";

const QUESTIONS = [{
  id: "q1", label: "scope", prompt: "Scope?",
  options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], allowOther: true,
}];

function submitInterview(sessionId: string, requestId: string, answers: unknown) {
  return submitInterviewWithContext(sessionId, requestId, answers, WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
}

async function withStore(fn: () => Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-interview-bridge-test-"));
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    await fn();
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test("bridge persists before notifying and resolves only a matching live waiter", async () => withStore(async () => {
  const bridge = new PiInterviewBridge();
  let requestId = "";
  bridge.onRequest((request) => { requestId = request.requestId; });

  const waiting = bridge.createRequestWithOutcome("session-1", QUESTIONS, {
    toolName: "questionnaire", toolCallId: "call-1", piSessionId: "pi-1", timeoutMs: 1_000,
  });
  assert.ok(requestId);
  assert.equal(getInterviewForSession("session-1", requestId)?.origin_tool_call_id, "call-1");
  const submitted = submitInterview("session-1", requestId, [{ id: "q1", value: "a", label: "ignored", wasCustom: false }]);
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  assert.equal(bridge.resolveSubmitted({ ...submitted.record, submission_id: undefined }), false);
  assert.equal(bridge.resolveSubmitted({ ...submitted.record, submission_id: "forged-submission" }), false);
  assert.equal(bridge.resolveSubmitted({
    ...submitted.record,
    answers: [{ id: "q1", value: "b", label: "B", wasCustom: false, index: 1 }],
  }), true);

  const outcome = await waiting;
  assert.equal(outcome.status, "submitted");
  if (outcome.status === "submitted") {
    assert.equal(outcome.submission.submissionId, submitted.record.submission_id);
    assert.deepEqual(outcome.answers, [{ id: "q1", value: "a", label: "A", wasCustom: false, index: 0 }]);
  }
  assert.equal(getInterviewForSession("session-1", requestId)?.status, "submitted");
  assert.equal(getInterviewForSession("session-1", requestId)?.delivery_mode, undefined);
  assert.equal(bridge.hasToolResultHandoff("session-1", requestId), true);
  bridge.completeToolResultHandoff("session-1", requestId);
  assert.equal(bridge.hasToolResultHandoff("session-1", requestId), false);
}));

test("terminal publication exposes only exact owner identity and durable status", async () => withStore(async () => {
  const bridge = new PiInterviewBridge();
  const events: unknown[] = [];
  const stop = bridge.onTerminal((event) => events.push(event));
  const waiting = bridge.createRequestWithOutcome("session-1", QUESTIONS, { timeoutMs: 1_000 });
  const [request] = bridge.getPendingRequests("session-1");
  const submitted = submitInterview("session-1", request!.requestId, [{ id: "q1", value: "a", wasCustom: false }]);
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  bridge.publishTerminal(submitted.record);
  assert.deepEqual(events, [{
    requestId: request!.requestId,
    sessionId: "session-1",
    status: "submitted",
  }]);
  stop();
  bridge.resolveSubmitted(submitted.record);
  await waiting;
}));

test("session teardown releases an unresolved tool-result handoff for durable recovery", async () => withStore(async () => {
  const bridge = new PiInterviewBridge();
  const waiting = bridge.createRequestWithOutcome("session-1", QUESTIONS, { timeoutMs: 1_000 });
  const [request] = bridge.getPendingRequests("session-1");
  const submitted = submitInterview("session-1", request!.requestId, [{ id: "q1", value: "a", wasCustom: false }]);
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  assert.equal(bridge.resolveSubmitted(submitted.record), true);
  await waiting;
  assert.equal(bridge.hasToolResultHandoff("session-1", request!.requestId), true);
  bridge.cancelSession("session-1");
  assert.equal(bridge.hasToolResultHandoff("session-1", request!.requestId), false);
  assert.equal(getInterviewForSession("session-1", request!.requestId)?.status, "submitted");
}));

test("grace expiry leaves the durable request open and reports pending", async () => withStore(async () => {
  const bridge = new PiInterviewBridge();
  const outcome = await bridge.createRequestWithOutcome("session-1", QUESTIONS, { timeoutMs: 1 });
  assert.equal(outcome.status, "pending");
  assert.equal(getInterviewForSession("session-1", outcome.request.requestId)?.status, "open");
  assert.deepEqual(bridge.getPendingRequests("session-1").map((request) => request.requestId), [outcome.request.requestId]);
}));

test("session teardown only resolves the accelerator and retains durable open records", async () => withStore(async () => {
  const bridge = new PiInterviewBridge();
  const waiting = bridge.createRequestWithOutcome("session-1", QUESTIONS, { timeoutMs: 1_000 });
  const [request] = bridge.getPendingRequests("session-1");
  bridge.cancelSession("session-1");
  const outcome = await waiting;
  assert.equal(outcome.status, "cancelled");
  assert.equal(getInterviewForSession("session-1", request!.requestId)?.status, "open");
}));

test("legacy bridge callers retain array results for an in-grace submission", async () => withStore(async () => {
  const bridge = new PiInterviewBridge();
  const waiting = bridge.createRequest("session-1", QUESTIONS, 1_000);
  const [request] = bridge.getPendingRequests("session-1");
  const submitted = submitInterview("session-1", request!.requestId, [{ id: "q1", value: "b", label: "B", wasCustom: false }]);
  assert.equal(submitted.ok, true);
  if (submitted.ok) bridge.resolveSubmitted(submitted.record);
  assert.equal((await waiting)[0]?.value, "b");
}));
