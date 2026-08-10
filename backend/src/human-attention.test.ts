import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, getStore, init } from "./db.js";
import {
  cancelInterview,
  createOpenInterview,
  markDelivered,
  submitInterview,
} from "./interviews.js";
import { WAYANG_WEBSOCKET_SUBMISSION_CONTEXT } from "./interview-provenance.js";
import {
  listHumanAttentionForSession,
  MAX_HUMAN_ATTENTION_ID_BYTES,
  MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION,
} from "./human-attention.js";
import {
  archiveSession,
  createSession,
  deleteSession,
  getSessionById,
  onSessionCatalogGeneration,
  stopSessionCatalog,
} from "./sessions.js";
import { serializeSession } from "./routes/sessions.js";

const QUESTIONS = [{
  id: "q1",
  label: "Synthetic choice",
  prompt: "Choose a synthetic option",
  options: [{ value: "yes", label: "Yes" }],
  allowOther: true,
}];

async function withStore(fn: (projectDir: string) => void | Promise<void>): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-human-attention-test-"));
  const projectDir = path.join(dir, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dir;
  try {
    init();
    await fn(projectDir);
  } finally {
    await stopSessionCatalog();
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function answer() {
  return [{ id: "q1", value: "yes", wasCustom: false }];
}

test("pending interviews produce the minimal typed session projection", async () => withStore((projectDir) => {
  const session = createSession(projectDir, "Attention projection");
  const pending = createOpenInterview({
    requestId: "pending-question",
    sessionId: session.id,
    toolName: "questionnaire",
    toolCallId: "sensitive-tool-call-must-not-project",
    piSessionFile: "/synthetic/private/transcript.jsonl",
    questions: QUESTIONS,
  });

  const expected = [{
    sessionId: session.id,
    kind: "question" as const,
    sourceId: pending.request_id,
    createdAt: pending.created_at,
    status: "pending" as const,
    requiresWayang: true as const,
  }];
  assert.deepEqual(listHumanAttentionForSession(session.id), expected);
  assert.deepEqual(serializeSession(session).humanAttention, expected);
  assert.deepEqual(Object.keys(expected[0]!).sort(), [
    "createdAt", "kind", "requiresWayang", "sessionId", "sourceId", "status",
  ]);
  assert.equal(JSON.stringify(expected).includes("Synthetic choice"), false);
  assert.equal(JSON.stringify(expected).includes("tool-call"), false);
  assert.equal(JSON.stringify(expected).includes("transcript"), false);
}));

test("submitted, delivered, and cancelled interviews do not remain active", async () => withStore((projectDir) => {
  const session = createSession(projectDir, "Attention lifecycle");
  const submitted = createOpenInterview({ requestId: "submitted", sessionId: session.id, toolName: "interview", questions: QUESTIONS });
  const submittedResult = submitInterview(session.id, submitted.request_id, answer(), WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
  assert.equal(submittedResult.ok, true);
  assert.deepEqual(listHumanAttentionForSession(session.id), []);
  assert.equal(markDelivered(submitted.request_id, "custom_message", "synthetic-entry")?.status, "delivered");
  assert.deepEqual(listHumanAttentionForSession(session.id), []);

  const cancelled = createOpenInterview({ requestId: "cancelled", sessionId: session.id, toolName: "questionnaire", questions: QUESTIONS });
  assert.equal(listHumanAttentionForSession(session.id).length, 1);
  assert.equal(cancelInterview(session.id, cancelled.request_id)?.status, "cancelled");
  assert.deepEqual(listHumanAttentionForSession(session.id), []);
}));

test("attention is isolated by exact owning session", async () => withStore((projectDir) => {
  const owner = createSession(projectDir, "Owner");
  const other = createSession(projectDir, "Other");
  createOpenInterview({ requestId: "owner-only", sessionId: owner.id, toolName: "interview", questions: QUESTIONS });

  assert.deepEqual(listHumanAttentionForSession(owner.id).map((item) => item.sourceId), ["owner-only"]);
  assert.deepEqual(listHumanAttentionForSession(other.id), []);
  assert.deepEqual(serializeSession(other).humanAttention, []);
}));

test("projection and interview admission are bounded without truncating identifiers", async () => withStore(() => {
  const sessionId = "bounded-session";
  for (let index = 0; index < MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION + 5; index++) {
    getStore().interviews.push({
      request_id: `request-${String(index).padStart(3, "0")}`,
      session_id: sessionId,
      origin_tool_name: "questionnaire",
      questions: QUESTIONS,
      status: "open",
      created_at: index,
    });
  }

  const projected = listHumanAttentionForSession(sessionId);
  assert.equal(projected.length, MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION);
  assert.equal(projected[0]?.sourceId, "request-000");
  assert.equal(projected.at(-1)?.sourceId, `request-${String(MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION - 1).padStart(3, "0")}`);
  assert.throws(
    () => createOpenInterview({ sessionId, toolName: "interview", questions: QUESTIONS }),
    /Too many pending interview requests/,
  );

  const overlong = "x".repeat(MAX_HUMAN_ATTENTION_ID_BYTES + 1);
  assert.throws(
    () => createOpenInterview({ requestId: overlong, sessionId: "another-session", toolName: "interview", questions: QUESTIONS }),
    /request ID is invalid or too long/,
  );
  getStore().interviews.push({
    request_id: overlong,
    session_id: "legacy-session",
    origin_tool_name: "interview",
    questions: QUESTIONS,
    status: "open",
    created_at: 1,
  });
  assert.deepEqual(listHumanAttentionForSession("legacy-session"), []);
}));

test("durable pending attention replays after backend reinitialization", async () => withStore((projectDir) => {
  const session = createSession(projectDir, "Reconnect replay");
  createOpenInterview({ requestId: "durable-pending", sessionId: session.id, toolName: "questionnaire", questions: QUESTIONS });
  close();
  init();

  const restored = getSessionById(session.id);
  assert.ok(restored);
  assert.deepEqual(serializeSession(restored!).humanAttention.map((item) => item.sourceId), ["durable-pending"]);
}));

test("attention lifecycle changes publish through the existing session catalog event", async () => withStore((projectDir) => {
  const session = createSession(projectDir, "Catalog refresh");
  const generations: number[] = [];
  const unsubscribe = onSessionCatalogGeneration((generation) => generations.push(generation));
  try {
    const pending = createOpenInterview({ requestId: "catalog-pending", sessionId: session.id, toolName: "interview", questions: QUESTIONS });
    assert.deepEqual(generations, [2]);
    const result = submitInterview(session.id, pending.request_id, answer(), WAYANG_WEBSOCKET_SUBMISSION_CONTEXT);
    assert.equal(result.ok, true);
    assert.deepEqual(generations, [2, 3]);
  } finally {
    unsubscribe();
  }
}));

test("archive retains durable attention while permanent deletion removes it", async () => withStore((projectDir) => {
  const session = createSession(projectDir, "Cleanup semantics");
  createOpenInterview({ requestId: "cleanup-pending", sessionId: session.id, toolName: "interview", questions: QUESTIONS });
  archiveSession(session.id);
  assert.deepEqual(serializeSession(getSessionById(session.id)!).humanAttention.map((item) => item.sourceId), ["cleanup-pending"]);

  assert.equal(deleteSession(session.id)?.session.id, session.id);
  assert.deepEqual(listHumanAttentionForSession(session.id), []);
}));
