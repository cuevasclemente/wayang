import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, init } from "./db.js";
import {
  cancelInterview,
  createOpenInterview,
  getInterviewForSession,
  listOpenInterviews,
  listSubmittedUndeliveredInterviews,
  markDelivered,
  normalizeAnswers,
  removeInterviewsForSession,
  submitInterview,
} from "./interviews.js";

const QUESTIONS = [{
  id: "q1", label: "Scope", prompt: "Which scope?",
  options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }],
  allowOther: true,
}];

function withStore(fn: () => void): void {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-interviews-test-"));
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

test("interviews persist open, submitted, cancelled, and delivered state", () => withStore(() => {
  const open = createOpenInterview({ requestId: "open", sessionId: "s1", toolName: "interview", questions: QUESTIONS });
  const delivered = createOpenInterview({ requestId: "delivered", sessionId: "s1", toolName: "questionnaire", questions: QUESTIONS });
  const submitted = createOpenInterview({ requestId: "submitted", sessionId: "s1", toolName: "questionnaire", questions: QUESTIONS });
  const cancelled = createOpenInterview({ requestId: "cancelled", sessionId: "s1", toolName: "interview", questions: QUESTIONS });
  assert.equal(submitInterview("s1", delivered.request_id, [{ id: "q1", value: "small", label: "ignored", wasCustom: false }]).ok, true);
  assert.equal(submitInterview("s1", submitted.request_id, [{ id: "q1", value: "large", label: "ignored", wasCustom: false }]).ok, true);
  markDelivered(delivered.request_id, "custom_message", "pi-entry");
  assert.equal(cancelInterview("s1", cancelled.request_id)?.status, "cancelled");

  close();
  init();
  assert.equal(getInterviewForSession("s1", open.request_id)?.status, "open");
  assert.equal(getInterviewForSession("s1", delivered.request_id)?.status, "delivered");
  assert.equal(getInterviewForSession("s1", delivered.request_id)?.delivery_entry_id, "pi-entry");
  assert.equal(getInterviewForSession("s1", submitted.request_id)?.status, "submitted");
  assert.equal(getInterviewForSession("s1", cancelled.request_id)?.status, "cancelled");
  assert.deepEqual(listSubmittedUndeliveredInterviews("s1").map((record) => record.request_id), ["submitted"]);
}));

test("submission validates session, canonicalizes answers, and is idempotent", () => withStore(() => {
  createOpenInterview({ requestId: "request", sessionId: "owner", toolName: "interview", questions: QUESTIONS });
  assert.equal(submitInterview("other", "request", []).ok, false);
  assert.equal(submitInterview("owner", "request", [{ id: "q1", value: "nope", label: "Nope", wasCustom: false }]).ok, false);

  const first = submitInterview("owner", "request", [{ id: "q1", value: "small", label: "forged", wasCustom: false, index: 99 }]);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.record.answers, [{ id: "q1", value: "small", label: "Small", wasCustom: false, index: 0 }]);

  const duplicate = submitInterview("owner", "request", [{ id: "q1", value: "small", label: "anything", wasCustom: false }]);
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) assert.equal(duplicate.kind, "duplicate");
  const conflict = submitInterview("owner", "request", [{ id: "q1", value: "large", label: "Large", wasCustom: false }]);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "conflict");
}));

test("custom answers are accepted for normalized and historical questions regardless of allowOther", () => withStore(() => {
  const normalized = createOpenInterview({
    requestId: "custom",
    sessionId: "s",
    toolName: "questionnaire",
    questions: [{ ...QUESTIONS[0], allowOther: false }],
  });
  assert.equal(normalized.questions[0]?.allowOther, true);
  const accepted = submitInterview("s", "custom", [{ id: "q1", value: "A custom choice", label: "forged", wasCustom: true }]);
  assert.equal(accepted.ok, true);
  if (accepted.ok) assert.deepEqual(accepted.record.answers, [{ id: "q1", value: "A custom choice", label: "A custom choice", wasCustom: true }]);

  const historicalQuestions = [{ ...QUESTIONS[0], allowOther: false }];
  assert.deepEqual(
    normalizeAnswers(historicalQuestions, [{ id: "q1", value: "Legacy custom choice", wasCustom: true }]),
    [{ id: "q1", value: "Legacy custom choice", label: "Legacy custom choice", wasCustom: true }],
  );
}));

test("shuffled answers are stored in question order and duplicate, missing, and unknown IDs are rejected", () => withStore(() => {
  const questions = [
    { id: "first", label: "First", prompt: "First?", options: [{ value: "one", label: "One" }], allowOther: false },
    { id: "second", label: "Second", prompt: "Second?", options: [{ value: "two", label: "Two" }], allowOther: false },
  ];
  createOpenInterview({ requestId: "shuffled", sessionId: "s", toolName: "interview", questions });

  const accepted = submitInterview("s", "shuffled", [
    { id: "second", value: "custom second", wasCustom: true },
    { id: "first", value: "one", wasCustom: false },
  ]);
  assert.equal(accepted.ok, true);
  if (accepted.ok) {
    assert.deepEqual(accepted.record.answers?.map((answer) => answer.id), ["first", "second"]);
    assert.deepEqual(getInterviewForSession("s", "shuffled")?.answers?.map((answer) => answer.id), ["first", "second"]);
  }

  createOpenInterview({ requestId: "ids", sessionId: "s", toolName: "interview", questions });
  for (const answers of [
    [{ id: "first", value: "one", wasCustom: false }, { id: "first", value: "one", wasCustom: false }],
    [{ id: "first", value: "one", wasCustom: false }, { id: "unknown", value: "x", wasCustom: true }],
    [{ id: "first", value: "one", wasCustom: false }],
  ]) {
    const result = submitInterview("s", "ids", answers);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.code, "invalid_answers");
  }
}));

test("free-text-only questions remain valid when allowOther is enabled", () => withStore(() => {
  createOpenInterview({
    requestId: "free-text",
    sessionId: "s",
    toolName: "interview",
    questions: [{ id: "why", label: "Why", prompt: "Tell us why", options: [], allowOther: true }],
  });
  const accepted = submitInterview("s", "free-text", [{ id: "why", value: "Because it matters", label: "ignored", wasCustom: true }]);
  assert.equal(accepted.ok, true);
}));

test("open records are session-scoped and removed only on permanent deletion", () => withStore(() => {
  createOpenInterview({ requestId: "a", sessionId: "a", toolName: "interview", questions: QUESTIONS });
  createOpenInterview({ requestId: "b", sessionId: "b", toolName: "interview", questions: QUESTIONS });
  assert.deepEqual(listOpenInterviews("a").map((record) => record.request_id), ["a"]);
  assert.equal(removeInterviewsForSession("a"), 1);
  assert.equal(getInterviewForSession("a", "a"), undefined);
  assert.ok(getInterviewForSession("b", "b"));
}));
