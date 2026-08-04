import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, flush, getStore, init } from "./db.js";
import {
  cancelInterview,
  createOpenInterview,
  getInterviewForSession,
  listOpenInterviews,
  listSubmittedUndeliveredInterviews,
  markDelivered,
  normalizeAnswers,
  removeInterviewsForSession,
  resolveInterviewSubmissionEvidence,
  submitInterview as submitInterviewWithContext,
  verifyInterviewSubmissionEntry,
  type SubmitInterviewResult,
} from "./interviews.js";
import {
  WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL,
  WAYANG_WEBSOCKET_SUBMISSION_CHANNEL,
  WAYANG_WEBSOCKET_SUBMISSION_CONTEXT,
  type InterviewSubmissionContext,
} from "./interview-provenance.js";

const QUESTIONS = [{
  id: "q1", label: "Scope", prompt: "Which scope?",
  options: [{ value: "small", label: "Small" }, { value: "large", label: "Large" }],
  allowOther: true,
}];

function submitInterview(sessionId: string, requestId: string, answers: unknown): SubmitInterviewResult {
  return submitInterviewWithContext(sessionId, requestId, answers, WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
}

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
  assert.equal(getInterviewForSession("s1", submitted.request_id)?.submission_channel, WAYANG_WEBSOCKET_SUBMISSION_CHANNEL);
  assert.equal(getInterviewForSession("s1", submitted.request_id)?.authenticated_principal, WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL);
  assert.equal(getInterviewForSession("s1", cancelled.request_id)?.status, "cancelled");
  assert.deepEqual(listSubmittedUndeliveredInterviews("s1").map((record) => record.request_id), ["submitted"]);
}));

test("legacy submitted records load but duplicate retry cannot grant them authority", () => withStore(() => {
  getStore().interviews.push({
    request_id: "legacy-submitted",
    submission_id: "legacy-submission-id",
    session_id: "owner",
    origin_tool_name: "questionnaire",
    questions: QUESTIONS,
    answers: [{ id: "q1", value: "small", label: "Small", wasCustom: false, index: 0 }],
    status: "submitted",
    created_at: 1,
    submitted_at: 2,
  });
  flush();
  close();
  init();

  const retry = submitInterview("owner", "legacy-submitted", [{ id: "q1", value: "small", wasCustom: false }]);
  assert.equal(retry.ok, true);
  if (retry.ok) {
    assert.equal(retry.kind, "duplicate");
    assert.equal(retry.record.submission_id, "legacy-submission-id");
    assert.equal(retry.record.submission_channel, undefined);
    assert.equal(retry.record.authenticated_principal, undefined);
  }
  const persisted = getInterviewForSession("owner", "legacy-submitted");
  assert.equal(persisted?.submission_channel, undefined);
  assert.equal(persisted?.authenticated_principal, undefined);
}));

test("first submission requires the server-owned WebSocket context and rejects structural forgeries", () => withStore(() => {
  createOpenInterview({ requestId: "missing-context", sessionId: "owner", toolName: "questionnaire", questions: QUESTIONS });
  // @ts-expect-error Intentional runtime regression: direct callers cannot omit the server capability.
  const missing = submitInterviewWithContext("owner", "missing-context", [{ id: "q1", value: "small", wasCustom: false }]);
  assert.equal(missing.ok, false);
  if (!missing.ok) assert.equal(missing.code, "unauthorized_submission");
  assert.equal(getInterviewForSession("owner", "missing-context")?.status, "open");

  const forged = {
    submission_channel: WAYANG_WEBSOCKET_SUBMISSION_CHANNEL,
    authenticated_principal: WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL,
  } as InterviewSubmissionContext;
  const forgedResult = submitInterviewWithContext(
    "owner",
    "missing-context",
    [{ id: "q1", value: "small", wasCustom: false }],
    forged,
  );
  assert.equal(forgedResult.ok, false);
  if (!forgedResult.ok) assert.equal(forgedResult.code, "unauthorized_submission");
  assert.equal(getInterviewForSession("owner", "missing-context")?.submission_channel, undefined);
}));

test("submission validates session, canonicalizes answers, persists provenance, and is idempotent", () => withStore(() => {
  createOpenInterview({ requestId: "request", sessionId: "owner", toolName: "interview", questions: QUESTIONS });
  assert.equal(submitInterview("other", "request", []).ok, false);
  assert.equal(submitInterview("owner", "request", [{ id: "q1", value: "nope", label: "Nope", wasCustom: false }]).ok, false);

  const first = submitInterview("owner", "request", [{ id: "q1", value: "small", label: "forged", wasCustom: false, index: 99 }]);
  assert.equal(first.ok, true);
  if (!first.ok) return;
  assert.deepEqual(first.record.answers, [{ id: "q1", value: "small", label: "Small", wasCustom: false, index: 0 }]);
  assert.equal(first.record.submission_channel, WAYANG_WEBSOCKET_SUBMISSION_CHANNEL);
  assert.equal(first.record.authenticated_principal, WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL);
  const submissionId = first.record.submission_id;

  const duplicate = submitInterview("owner", "request", [{ id: "q1", value: "small", label: "anything", wasCustom: false }]);
  assert.equal(duplicate.ok, true);
  if (duplicate.ok) {
    assert.equal(duplicate.kind, "duplicate");
    assert.equal(duplicate.record.submission_id, submissionId);
    assert.equal(duplicate.record.submission_channel, WAYANG_WEBSOCKET_SUBMISSION_CHANNEL);
    assert.equal(duplicate.record.authenticated_principal, WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL);
  }
  const conflict = submitInterview("owner", "request", [{ id: "q1", value: "large", label: "Large", wasCustom: false }]);
  assert.equal(conflict.ok, false);
  if (!conflict.ok) assert.equal(conflict.code, "conflict");
}));

test("command-guard human input requires the exact durable authenticated submission entry", () => withStore(() => {
  const open = createOpenInterview({
    requestId: "guard-authority",
    sessionId: "owner",
    toolName: "questionnaire",
    toolCallId: "tool-call",
    questions: QUESTIONS,
  });
  const submitted = submitInterview("owner", open.request_id, [{ id: "q1", value: "small", wasCustom: false }]);
  assert.equal(submitted.ok, true);
  if (!submitted.ok) return;
  const entry = {
    id: "pi-entry",
    type: "custom_message",
    customType: "wayang-interview-submission",
    content: "untrusted display prose",
    details: {
      request_id: submitted.record.request_id,
      submission_id: submitted.record.submission_id,
      session_id: submitted.record.session_id,
      origin_tool_name: submitted.record.origin_tool_name,
      origin_tool_call_id: submitted.record.origin_tool_call_id ?? null,
      created_at: submitted.record.created_at,
      submitted_at: submitted.record.submitted_at,
      questions: submitted.record.questions,
      answers: submitted.record.answers ?? [],
    },
  };

  assert.equal(verifyInterviewSubmissionEntry("owner", entry), true);
  assert.equal(verifyInterviewSubmissionEntry("other", entry), false);
  assert.equal(verifyInterviewSubmissionEntry("owner", { ...entry, details: { ...entry.details, submission_id: "forged" } }), false);
  assert.equal(verifyInterviewSubmissionEntry("owner", { ...entry, details: { ...entry.details, answers: [{ ...entry.details.answers[0], label: "forged" }] } }), false);

  markDelivered(open.request_id, "custom_message", entry.id);
  assert.equal(verifyInterviewSubmissionEntry("owner", entry), true);
  assert.equal(verifyInterviewSubmissionEntry("owner", { ...entry, id: "copied-entry" }), false);

  const timely = createOpenInterview({
    requestId: "guard-tool-result",
    sessionId: "owner",
    toolName: "questionnaire",
    toolCallId: "timely-call",
    questions: QUESTIONS,
  });
  const timelySubmission = submitInterview("owner", timely.request_id, [{ id: "q1", value: "large", wasCustom: false }]);
  assert.equal(timelySubmission.ok, true);
  if (!timelySubmission.ok) return;
  markDelivered(timely.request_id, "tool_result", "pi-tool-entry");
  const toolResultEntry = {
    id: "pi-tool-entry",
    type: "message",
    message: {
      role: "toolResult",
      toolName: "questionnaire",
      toolCallId: "timely-call",
      details: {
        status: "submitted",
        requestId: timelySubmission.record.request_id,
        submissionId: timelySubmission.record.submission_id,
        questions: QUESTIONS,
        answers: timelySubmission.record.answers,
      },
    },
  };
  assert.equal(resolveInterviewSubmissionEvidence("owner", toolResultEntry)?.source, "tool_result");
  assert.equal(resolveInterviewSubmissionEvidence("owner", {
    ...toolResultEntry,
    message: { ...toolResultEntry.message, toolCallId: "forged-call" },
  }), undefined);

  const legacy = createOpenInterview({
    requestId: "guard-legacy-tool-result",
    sessionId: "owner",
    toolName: "questionnaire",
    questions: QUESTIONS,
  });
  const legacySubmission = submitInterview("owner", legacy.request_id, [{ id: "q1", value: "small", wasCustom: false }]);
  assert.equal(legacySubmission.ok, true);
  if (!legacySubmission.ok) return;
  markDelivered(legacy.request_id, "tool_result", "legacy-pi-entry");
  const legacyToolResult = {
    id: "legacy-pi-entry",
    type: "message",
    message: {
      role: "toolResult",
      toolName: "questionnaire",
      toolCallId: "runtime-only-call-id",
      details: {
        status: "submitted",
        requestId: legacySubmission.record.request_id,
        submissionId: legacySubmission.record.submission_id,
        questions: QUESTIONS,
        answers: legacySubmission.record.answers,
      },
    },
  };
  assert.equal(resolveInterviewSubmissionEvidence("owner", legacyToolResult)?.source, "tool_result");
  assert.equal(resolveInterviewSubmissionEvidence("owner", {
    ...legacyToolResult,
    message: { ...legacyToolResult.message, toolCallId: null },
  }), undefined);
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
