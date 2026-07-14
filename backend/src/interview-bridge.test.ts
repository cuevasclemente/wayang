import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, init } from "./db.js";
import { getInterviewForSession, submitInterview } from "./interviews.js";
import { PiInterviewBridge } from "./interview-bridge.js";

const QUESTIONS = [{
  id: "q1", label: "scope", prompt: "Scope?",
  options: [{ value: "a", label: "A" }, { value: "b", label: "B" }], allowOther: true,
}];

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
  assert.equal(bridge.resolveSubmitted(submitted.record), true);

  const outcome = await waiting;
  assert.equal(outcome.status, "submitted");
  if (outcome.status === "submitted") assert.deepEqual(outcome.answers, [{ id: "q1", value: "a", label: "A", wasCustom: false, index: 0 }]);
  assert.equal(getInterviewForSession("session-1", requestId)?.delivery_mode, "tool_result");
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
