import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { WebSocket } from "ws";
import { close, init } from "../db.js";
import { createOpenInterview, getInterviewForSession } from "../interviews.js";
import { handleInterviewCancel } from "./ws.js";

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
  handleInterviewCancel(wrong.ws, "other-session", { requestId: "cancel-exact" });
  assert.deepEqual(wrong.messages, [{
    type: "interview_cancel_ack",
    requestId: "cancel-exact",
    sessionId: "other-session",
    status: "rejected",
    errorCode: "not_found",
    error: "Interview request was not found or is no longer open",
  }]);
  assert.equal(getInterviewForSession("owner-session", "cancel-exact")?.status, "open");

  const exact = wire();
  handleInterviewCancel(exact.ws, "owner-session", { requestId: "cancel-exact" });
  assert.deepEqual(exact.messages, [{
    type: "interview_cancel_ack",
    requestId: "cancel-exact",
    sessionId: "owner-session",
    status: "cancelled",
    duplicate: false,
  }]);
  assert.equal(getInterviewForSession("owner-session", "cancel-exact")?.status, "cancelled");

  const replay = wire();
  handleInterviewCancel(replay.ws, "owner-session", { requestId: "cancel-exact" });
  assert.deepEqual(replay.messages, [{
    type: "interview_cancel_ack",
    requestId: "cancel-exact",
    sessionId: "owner-session",
    status: "cancelled",
    duplicate: true,
  }]);
  assert.equal(getInterviewForSession("owner-session", "cancel-exact")?.status, "cancelled");
}));
