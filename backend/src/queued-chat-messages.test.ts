import assert from "node:assert/strict";
import test from "node:test";
import {
  cancelCapturedQueuedChatMessage,
  captureQueuedChatMessage,
  isQueuedChatMessagePending,
  queuedChatMessageState,
  snapshotQueuedChatMessages,
} from "./queued-chat-messages.js";

function user(text: string, imageData?: string) {
  return {
    role: "user",
    content: [
      { type: "text", text },
      ...(imageData ? [{ type: "image", mimeType: "image/png", data: imageData }] : []),
    ],
    timestamp: Date.now(),
  };
}

function fixture() {
  const first = user("first queued message", "synthetic-image-a");
  const custom = { role: "custom", customType: "synthetic", content: "preserve me" };
  const duplicate = user("duplicate");
  const target = user("duplicate", "synthetic-image-target");
  const session: any = {
    _steeringMessages: ["first queued message", "duplicate"],
    _emitQueueUpdate() {
      this.queueUpdates.push([...this._steeringMessages]);
    },
    queueUpdates: [] as string[][],
    agent: {
      steeringQueue: {
        messages: [first, custom, duplicate],
      },
    },
  };
  return { session, first, custom, duplicate, target };
}

test("captures and cancels exactly one queued browser message without rebuilding neighbors", () => {
  const f = fixture();
  const before = snapshotQueuedChatMessages(f.session);
  f.session._steeringMessages.push("duplicate");
  f.session.agent.steeringQueue.messages.push(f.target);

  const capture = captureQueuedChatMessage(f.session, before);
  assert.ok(capture);
  assert.equal(capture.message, f.target);
  assert.equal(isQueuedChatMessagePending(capture), true);

  assert.equal(cancelCapturedQueuedChatMessage(capture), true);
  assert.deepEqual(f.session._steeringMessages, ["first queued message", "duplicate"]);
  assert.deepEqual(f.session.agent.steeringQueue.messages, [f.first, f.custom, f.duplicate]);
  assert.equal((f.session.agent.steeringQueue.messages[0].content[1] as any).data, "synthetic-image-a");
  assert.deepEqual(f.session.queueUpdates, [["first queued message", "duplicate"]]);
  assert.equal(isQueuedChatMessagePending(capture), false);
  assert.equal(cancelCapturedQueuedChatMessage(capture), false, "cancellation is one-use");
});

test("refuses non-writable queue internals without partially removing the target", () => {
  const f = fixture();
  const before = snapshotQueuedChatMessages(f.session);
  f.session._steeringMessages.push("duplicate");
  f.session.agent.steeringQueue.messages.push(f.target);
  const capture = captureQueuedChatMessage(f.session, before);
  assert.ok(capture);
  Object.defineProperty(f.session.agent.steeringQueue, "messages", {
    value: f.session.agent.steeringQueue.messages,
    writable: false,
    configurable: true,
  });

  assert.equal(cancelCapturedQueuedChatMessage(capture), false);
  assert.equal(f.session.agent.steeringQueue.messages.includes(f.target), true);
  assert.equal(f.session._steeringMessages.length, 3);
});

test("fails closed when a captured message was already claimed or SDK internals drift", () => {
  const f = fixture();
  const before = snapshotQueuedChatMessages(f.session);
  f.session._steeringMessages.push("duplicate");
  f.session.agent.steeringQueue.messages.push(f.target);
  const capture = captureQueuedChatMessage(f.session, before);
  assert.ok(capture);

  f.session._steeringMessages = ["first queued message"];
  assert.equal(queuedChatMessageState(capture), "incompatible", "a still-pending object with drifted tracking is not mistaken for dequeue");
  assert.equal(cancelCapturedQueuedChatMessage(capture), false);
  assert.equal(f.session.agent.steeringQueue.messages.includes(f.target), true);

  f.session.agent.steeringQueue.messages = f.session.agent.steeringQueue.messages.filter((message: unknown) => message !== f.target);
  assert.equal(queuedChatMessageState(capture), "claimed");
  const incompatible: any = { agent: { steeringQueue: {} } };
  assert.equal(snapshotQueuedChatMessages(incompatible), undefined);
});
