import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, init } from "../db.js";
import { createSession, getSessionById, updateSessionError } from "../sessions.js";
import {
  applyWebSocketClientFailure,
  StaleWebSocketRuntimeAttachmentError,
} from "./ws.js";

test("stale attachment rejection is coded and never replaces the durable session error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-ws-runtime-attachment-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  try {
    init();
    const session = createSession(project, "Synthetic runtime attachment");
    updateSessionError(session.id, "existing durable runtime error");
    const frames: Array<Record<string, unknown>> = [];

    applyWebSocketClientFailure({
      sessionId: session.id,
      selectionId: "selection-current",
      message: {
        type: "message",
        client_message_id: "client-current",
        content: "must not dispatch",
      },
      cause: new StaleWebSocketRuntimeAttachmentError(),
      send: (frame) => frames.push(frame),
      persist: (error) => updateSessionError(session.id, error),
    });

    assert.deepEqual(frames, [
      {
        type: "queued_message_ack",
        session_id: session.id,
        client_message_id: "client-current",
        status: "rejected",
        error_code: "selection_changed",
        error: "Session action was not sent because the selection changed during runtime attachment",
      },
      {
        type: "error",
        session_id: session.id,
        selection_id: "selection-current",
        code: "selection_changed",
        error: "Session action was not sent because the selection changed during runtime attachment",
      },
    ]);
    assert.equal(getSessionById(session.id)?.error, "existing durable runtime error");
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("actual runtime attachment failures retain the existing persistence policy", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-ws-runtime-failure-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  try {
    init();
    const session = createSession(project, "Synthetic runtime failure");
    const frames: Array<Record<string, unknown>> = [];

    applyWebSocketClientFailure({
      sessionId: session.id,
      selectionId: "selection-current",
      message: {
        type: "message",
        client_message_id: "client-current",
        content: "must not dispatch",
      },
      cause: new Error("runtime creation failed"),
      send: (frame) => frames.push(frame),
      persist: (error) => updateSessionError(session.id, error),
    });

    assert.equal(getSessionById(session.id)?.error, "runtime creation failed");
    assert.equal(frames[0]?.error_code, undefined);
    assert.equal(frames[1]?.code, undefined);
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
