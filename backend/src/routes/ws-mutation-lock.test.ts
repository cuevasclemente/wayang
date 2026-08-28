import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { close, init } from "../db.js";
import { createSession, getSessionById, updateSessionError } from "../sessions.js";
import {
  acquireSessionRuntimeMutationLock,
  releaseSessionRuntimeMutationLock,
} from "../session-runtime-mutation-lock.js";
import { serializeMutationLockedRejection } from "./ws.js";

test("second-client sends during PIN wait and post-CAS cleanup receive coded rejection without durable false error", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-ws-mutation-lock-"));
  const project = path.join(root, "project");
  fs.mkdirSync(project, { recursive: true });
  const previous = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  try {
    init();
    const session = createSession(project, "Synthetic mutation lock");
    updateSessionError(session.id, null);
    assert.equal(acquireSessionRuntimeMutationLock(session.id), true);
    try {
      for (const phase of ["pin-wait", "post-cas-reconciliation"]) {
        const frames = serializeMutationLockedRejection(session.id, `selection-${phase}`, {
          type: "message",
          client_message_id: `client-${phase}`,
          content: "must not dispatch",
        });
        assert.equal(frames[0]?.type, "queued_message_snapshot");
        assert.equal(frames[0]?.session_id, session.id);
        assert.equal(frames[0]?.selection_id, `selection-${phase}`);
        assert.equal(frames[0]?.client_message_id, `client-${phase}`);
        assert.equal(frames[0]?.message_status, "rejected");
        assert.equal(frames[0]?.accepted_user_turn, false);
        assert.deepEqual(frames[0]?.messages, []);
        assert.deepEqual((frames[0]?.outcomes as Array<Record<string, unknown>>).at(-1), {
          client_message_id: `client-${phase}`,
          status: "rejected",
          accepted_user_turn: false,
        });
        assert.deepEqual(frames[1], {
          type: "queued_message_ack",
          session_id: session.id,
          client_message_id: `client-${phase}`,
          status: "rejected",
          error_code: "mutation_locked",
          error: "Session transcript mutation is in progress",
        });
        assert.deepEqual(frames[2], {
          type: "error",
          session_id: session.id,
          selection_id: `selection-${phase}`,
          code: "mutation_locked",
          error: "Session transcript mutation is in progress",
        });
        assert.equal(getSessionById(session.id)?.error, null, `${phase} rejection must not persist a false assistant error`);
      }
    } finally {
      releaseSessionRuntimeMutationLock(session.id);
    }
  } finally {
    close();
    if (previous === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previous;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
