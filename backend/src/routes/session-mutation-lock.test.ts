import test from "node:test";
import assert from "node:assert/strict";
import {
  acquireSessionRuntimeMutationLock,
  releaseSessionRuntimeMutationLock,
} from "../session-runtime-mutation-lock.js";
import { scheduleWayangAutoTitle } from "../session-title-service.js";
import { getPiSessionRuntimeState, onPiSessionRuntimeEvent } from "../pi-bridge.js";
import { isSessionTitleWriteAllowed } from "./sessions.js";
import {
  beginSessionCompactionMutationLease,
  isSessionClientMutationAllowed,
  serializeSessionRuntimeState,
} from "./ws.js";

test("transcript mutation lock blocks REST title, WebSocket compact/name/message, and auto-title writers", () => {
  const sessionId = "synthetic-transcript-writer-lock";
  assert.equal(isSessionTitleWriteAllowed(sessionId), true);
  assert.equal(isSessionClientMutationAllowed(sessionId), true);
  assert.equal(acquireSessionRuntimeMutationLock(sessionId), true);
  try {
    assert.equal(isSessionTitleWriteAllowed(sessionId), false);
    assert.equal(isSessionClientMutationAllowed(sessionId), false);
    assert.equal(scheduleWayangAutoTitle(sessionId), null, "auto-title must stop before row/file/provider access");
    assert.equal(acquireSessionRuntimeMutationLock(sessionId), false, "a second transcript/settings writer cannot race the lock");
  } finally {
    releaseSessionRuntimeMutationLock(sessionId);
  }
  assert.equal(isSessionTitleWriteAllowed(sessionId), true);
  assert.equal(isSessionClientMutationAllowed(sessionId), true);
});

test("lock and unlock publish runtime-state changes with HTTP/WS lock projections", () => {
  const sessionId = "synthetic-runtime-state-lock";
  const changes: string[] = [];
  const unsubscribe = onPiSessionRuntimeEvent((event) => {
    if (event.sessionId === sessionId && event.type === "runtime_state_changed") changes.push(event.type);
  });
  try {
    assert.equal(acquireSessionRuntimeMutationLock(sessionId), true);
    assert.equal(getPiSessionRuntimeState(sessionId).runtime_mutation_locked, true);
    assert.equal(serializeSessionRuntimeState(sessionId, "selection").mutation_locked, true);
    releaseSessionRuntimeMutationLock(sessionId);
    assert.equal(getPiSessionRuntimeState(sessionId).runtime_mutation_locked, false);
    assert.equal(serializeSessionRuntimeState(sessionId, "selection").mutation_locked, false);
    assert.deepEqual(changes, ["runtime_state_changed", "runtime_state_changed"]);
  } finally {
    releaseSessionRuntimeMutationLock(sessionId);
    unsubscribe();
  }
});

test("async compaction holds transcript exclusion until its explicit completion release", () => {
  const sessionId = "synthetic-compaction-lock";
  const release = beginSessionCompactionMutationLease(sessionId);
  assert.ok(release);
  assert.equal(isSessionClientMutationAllowed(sessionId), false);
  assert.equal(isSessionTitleWriteAllowed(sessionId), false);
  assert.equal(acquireSessionRuntimeMutationLock(sessionId), false);
  release();
  release();
  assert.equal(isSessionClientMutationAllowed(sessionId), true, "release is idempotent");
});
