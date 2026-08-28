import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  PiSessionCapabilityRefreshPendingError,
  abortInteractiveTurn,
  assertPiSessionAcceptsNewWork,
  assertPiSessionCreationGeneration,
  beginNonBrowserTurn,
  beginPiSessionTopLevelWork,
  capturePiSessionCreationGeneration,
  getPiSessionCapabilityActivationGeneration,
  latchPiSessionCapabilityActivation,
  lockRuntimeMutationSession,
  piSessionHandleCanRetireCapabilityRefresh,
  piSessionHandleRequiresFreshRuntime,
  reschedulePiSessionCapabilityRefreshRetirement,
  retirePiSessionCapabilityRefreshIfIdle,
  sendBrowserMessageTurn,
  unlockRuntimeMutationSession,
  type PiSessionHandle,
} from "./pi-bridge.js";

function syntheticHandle(
  id: string,
  options: { streaming?: boolean; pending?: number; compacting?: boolean } = {},
): PiSessionHandle {
  const session = {
    isStreaming: options.streaming ?? false,
    isCompacting: options.compacting ?? false,
    pendingMessageCount: options.pending ?? 0,
    abort: async () => undefined,
    clearQueue: () => ({ steering: [], followUp: [] }),
    sessionManager: {},
  };
  return {
    id,
    session: session as any,
    cwd: "/synthetic/project",
    model: "synthetic-model",
    subscriberCount: 1,
    extensionsResult: {} as any,
    events: new EventEmitter(),
    lastActivityAt: 1,
    agentProfileId: "synthetic-profile",
    runtimeGeneration: "captured-runtime-generation",
    capabilityActivationGeneration: getPiSessionCapabilityActivationGeneration(id),
    acceptedTopLevelWorkCount: 0,
    bashMode: "sandboxed",
    interactiveTurns: new Map(),
    queuedBrowserMessages: new Map(),
  };
}

test("activation latch preserves active and queued runtime surfaces while rejecting new work", async () => {
  const id = "synthetic-deferred-active-queued";
  const handle = syntheticHandle(id, { streaming: true, pending: 2 });
  const tools = { captured: true };
  const browserLease = { captured: true };
  const outputSubscription = () => undefined;
  handle.queuedBrowserMessages.set("captured-message", { captured: true } as any);
  handle.interactiveTurns.set("captured-turn", { captured: true } as any);
  const queuedTurns = handle.queuedBrowserMessages;
  const turnLedger = handle.interactiveTurns;
  (handle as any).capturedTools = tools;
  (handle as any).capturedBrowserLease = browserLease;
  handle.liveStreamingMessageUnsubscribe = outputSubscription;
  const lookup = new Map([[id, handle]]);
  const before = capturePiSessionCreationGeneration(id);

  latchPiSessionCapabilityActivation([id, id], lookup);

  assert.equal(getPiSessionCapabilityActivationGeneration(id), before.activation + 1n);
  assert.equal(handle.capabilityActivationGeneration, before.activation);
  assert.equal(handle.capabilityRefreshPending, true);
  assert.equal(handle.capabilityAuthorityDenied, undefined);
  assert.equal(handle.runtimeGeneration, "captured-runtime-generation");
  assert.equal(handle.session.isStreaming, true);
  assert.equal(handle.session.pendingMessageCount, 2);
  assert.equal(handle.queuedBrowserMessages, queuedTurns);
  assert.equal(handle.queuedBrowserMessages.size, 1);
  assert.equal(handle.interactiveTurns, turnLedger);
  assert.equal(handle.interactiveTurns.size, 1);
  assert.equal((handle as any).capturedTools, tools);
  assert.equal((handle as any).capturedBrowserLease, browserLease);
  assert.equal(handle.liveStreamingMessageUnsubscribe, outputSubscription);

  const isRefreshConflict = (error: unknown) => error instanceof PiSessionCapabilityRefreshPendingError
    && error.code === "capability_refresh_pending"
    && error.statusCode === 409;
  assert.throws(() => assertPiSessionAcceptsNewWork(handle), isRefreshConflict);
  await assert.rejects(sendBrowserMessageTurn(handle, "new work"), isRefreshConflict);
  assert.doesNotThrow(() => beginNonBrowserTurn(handle, "interview_submission"));
});

test("refresh-pending handles still permit interrupt and queue-clearing controls", async () => {
  const id = "synthetic-deferred-controls";
  const handle = syntheticHandle(id);
  let abortCount = 0;
  let clearQueueCount = 0;
  (handle.session as any).abort = async () => { abortCount += 1; };
  (handle.session as any).clearQueue = () => {
    clearQueueCount += 1;
    return { steering: ["accepted queued work"], followUp: [] };
  };
  handle.capabilityRefreshPending = true;

  const cleared = await abortInteractiveTurn(handle, { clearQueue: true });

  assert.equal(abortCount, 1);
  assert.equal(clearQueueCount, 1);
  assert.deepEqual(cleared, { steering: ["accepted queued work"], followUp: [] });
  assert.equal(handle.capabilityAuthorityDenied, undefined);
});

test("top-level work lease blocks retirement until idempotent release", async () => {
  const id = "synthetic-deferred-work-lease";
  const handle = syntheticHandle(id);
  const lookup = new Map([[id, handle]]);
  const release = beginPiSessionTopLevelWork(handle);

  assert.equal(handle.acceptedTopLevelWorkCount, 1);
  latchPiSessionCapabilityActivation([id], lookup);
  assert.equal(handle.capabilityRefreshPending, true);
  assert.equal(piSessionHandleCanRetireCapabilityRefresh(handle), false);

  release();
  release();
  assert.equal(handle.acceptedTopLevelWorkCount, 0);
  assert.equal(piSessionHandleCanRetireCapabilityRefresh(handle), true);
  const retired: string[] = [];
  assert.equal(await retirePiSessionCapabilityRefreshIfIdle(handle, {
    lookup,
    retire: async (runtimeId) => { retired.push(runtimeId); },
  }), true);
  assert.deepEqual(retired, [id]);
});

test("accepted continuation bypasses refresh only and remains denial-checked", () => {
  const handle = syntheticHandle("synthetic-deferred-accepted-continuation");
  handle.capabilityRefreshPending = true;

  assert.throws(() => beginPiSessionTopLevelWork(handle), PiSessionCapabilityRefreshPendingError);
  const release = beginPiSessionTopLevelWork(handle, { acceptedContinuation: true });
  assert.equal(handle.acceptedTopLevelWorkCount, 1);
  release();
  release();
  assert.equal(handle.acceptedTopLevelWorkCount, 0);

  handle.capabilityAuthorityDenied = true;
  assert.throws(
    () => beginPiSessionTopLevelWork(handle, { acceptedContinuation: true }),
    /authority was denied/,
  );
});

test("activation invalidates pre-latch creation snapshots and fresh snapshots are current", () => {
  const id = "synthetic-deferred-creation-fence";
  const startingSnapshot = capturePiSessionCreationGeneration(id);

  latchPiSessionCapabilityActivation([id], new Map());

  assert.throws(
    () => assertPiSessionCreationGeneration(id, startingSnapshot),
    /invalidated by capability activation/,
  );
  const freshSnapshot = capturePiSessionCreationGeneration(id);
  assert.equal(freshSnapshot.activation, startingSnapshot.activation + 1n);
  assert.doesNotThrow(() => assertPiSessionCreationGeneration(id, freshSnapshot));
});

test("refresh retirement waits for streaming, SDK queues, and provenance settlement", async () => {
  const id = "synthetic-deferred-retirement";
  const handle = syntheticHandle(id, { streaming: true, pending: 1 });
  handle.capabilityRefreshPending = true;
  handle.interactiveTurns.set("accepted-turn", {} as any);
  handle.queuedBrowserMessages.set("accepted-message", {} as any);
  const lookup = new Map([[id, handle]]);
  const retired: string[] = [];
  const retire = async (runtimeId: string) => { retired.push(runtimeId); };

  assert.equal(piSessionHandleCanRetireCapabilityRefresh(handle), false);
  assert.equal(await retirePiSessionCapabilityRefreshIfIdle(handle, { lookup, retire }), false);
  assert.deepEqual(retired, []);

  (handle.session as any).isStreaming = false;
  (handle.session as any).pendingMessageCount = 0;
  assert.equal(await retirePiSessionCapabilityRefreshIfIdle(handle, { lookup, retire }), false);

  handle.interactiveTurns.clear();
  handle.queuedBrowserMessages.clear();
  assert.equal(lockRuntimeMutationSession(id), true);
  assert.equal(piSessionHandleCanRetireCapabilityRefresh(handle), false);
  assert.equal(await retirePiSessionCapabilityRefreshIfIdle(handle, { lookup, retire }), false);
  unlockRuntimeMutationSession(id);
  assert.equal(piSessionHandleCanRetireCapabilityRefresh(handle), true);
  assert.equal(reschedulePiSessionCapabilityRefreshRetirement(id, lookup), true);
  assert.equal(reschedulePiSessionCapabilityRefreshRetirement("missing", lookup), false);
  assert.equal(await retirePiSessionCapabilityRefreshIfIdle(handle, { lookup, retire }), true);
  assert.deepEqual(retired, [id]);
});

test("idle activation is immediately refreshable and a fresh handle captures the new epoch", async () => {
  const id = "synthetic-deferred-idle-fresh";
  const stale = syntheticHandle(id);
  const lookup = new Map([[id, stale]]);

  latchPiSessionCapabilityActivation([id], lookup);

  assert.equal(stale.capabilityRefreshPending, true);
  assert.equal(piSessionHandleRequiresFreshRuntime(stale), true);
  const retired: string[] = [];
  assert.equal(await retirePiSessionCapabilityRefreshIfIdle(stale, {
    lookup,
    retire: async (runtimeId) => { retired.push(runtimeId); },
  }), true);
  assert.deepEqual(retired, [id]);

  const fresh = syntheticHandle(id);
  assert.equal(fresh.capabilityActivationGeneration, getPiSessionCapabilityActivationGeneration(id));
  assert.equal(fresh.capabilityRefreshPending, undefined);
  assert.equal(piSessionHandleRequiresFreshRuntime(fresh), false);
  assert.doesNotThrow(() => assertPiSessionAcceptsNewWork(fresh));
});
