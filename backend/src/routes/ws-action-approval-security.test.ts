import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import {
  PiActionApprovalBridge,
  type ExternalActionRequestInput,
} from "../action-approval-bridge.js";
import type { SettingsPinAttemptPort } from "../workspace-capability-approval/types.js";
import {
  handleExternalActionResponse,
  isExternalActionApprovalClientEligible,
  sendExternalActionTerminalState,
  serializeExternalActionTerminal,
} from "./ws.js";

function input(): ExternalActionRequestInput {
  return {
    connector: "synthetic",
    workspace: "workspace-a",
    toolName: "mutate",
    target: "target-a",
    summary: "Perform a synthetic external mutation",
    argumentsHash: createHash("sha256").update("synthetic arguments").digest("hex"),
  };
}

function recordingSocket(messages: unknown[]): WebSocket {
  return {
    readyState: WebSocket.OPEN,
    send(serialized: string) { messages.push(JSON.parse(serialized)); },
  } as unknown as WebSocket;
}

test("an invented current selection without a PIN cannot approve an external action", async () => {
  const attemptedPins: string[] = [];
  const pinAttempts: SettingsPinAttemptPort = {
    async reserve() { return { status: "reserved" }; },
    async verifyAndConsume(attempt) {
      attemptedPins.push(attempt.pin);
      return { status: "wrong_pin" };
    },
    async cancelAndConsume() {},
  };
  const bridge = new PiActionApprovalBridge(pinAttempts);
  bridge.attachClient("session-a", "client-a");
  const decision = bridge.requestApproval("session-a", input());
  const [request] = bridge.getPendingRequests("session-a");
  const messages: unknown[] = [];
  const socket = recordingSocket(messages);
  bridge.onTerminal((event) => {
    sendExternalActionTerminalState(
      socket,
      event,
      "client-invented-selection",
      () => bridge.getPendingRequests(event.sessionId),
    );
  });

  await handleExternalActionResponse(
    socket,
    "session-a",
    "client-invented-selection",
    {
      type: "external_action_response",
      requestId: request.requestId,
      sessionId: request.sessionId,
      selection_id: "client-invented-selection",
      argumentsHash: request.argumentsHash,
      approved: true,
    },
    bridge,
  );

  assert.deepEqual(attemptedPins, [""]);
  assert.equal((await decision).status, "denied");
  assert.deepEqual(messages, [
    {
      type: "external_action_terminal",
      requestId: request.requestId,
      sessionId: request.sessionId,
      selection_id: "client-invented-selection",
      status: "denied",
    },
    {
      type: "external_action_snapshot",
      sessionId: request.sessionId,
      selection_id: "client-invented-selection",
      requests: [],
      syncComplete: true,
    },
    {
      type: "external_action_response_ack",
      requestId: request.requestId,
      sessionId: request.sessionId,
      selection_id: "client-invented-selection",
      status: "denied",
      errorCode: "wrong_pin",
    },
  ]);
});

test("selection mismatch is rejected before the PIN authority", async () => {
  let attempts = 0;
  const pinAttempts: SettingsPinAttemptPort = {
    async reserve() { attempts += 1; return { status: "reserved" }; },
    async verifyAndConsume() { return { status: "verified" }; },
    async cancelAndConsume() {},
  };
  const bridge = new PiActionApprovalBridge(pinAttempts);
  bridge.attachClient("session-selection", "client-a");
  const decision = bridge.requestApproval("session-selection", input());
  const [request] = bridge.getPendingRequests("session-selection");
  const messages: unknown[] = [];

  await handleExternalActionResponse(
    recordingSocket(messages),
    request.sessionId,
    "current-selection",
    {
      requestId: request.requestId,
      sessionId: request.sessionId,
      selection_id: "stale-selection",
      argumentsHash: request.argumentsHash,
      approved: true,
      pin: "12345678",
    },
    bridge,
  );

  assert.equal(attempts, 0);
  assert.deepEqual(messages, [{
    type: "external_action_response_ack",
    requestId: request.requestId,
    sessionId: request.sessionId,
    selection_id: "stale-selection",
    status: "rejected",
    errorCode: "request_identity_mismatch",
  }]);
  await bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, false);
  assert.equal((await decision).status, "denied");
});

test("direct denial remains PIN-free over the WebSocket response path", async () => {
  let attempts = 0;
  const pinAttempts: SettingsPinAttemptPort = {
    async reserve() { attempts += 1; return { status: "reserved" }; },
    async verifyAndConsume() { attempts += 1; return { status: "verified" }; },
    async cancelAndConsume() {},
  };
  const bridge = new PiActionApprovalBridge(pinAttempts);
  bridge.attachClient("session-deny", "client-a");
  const decision = bridge.requestApproval("session-deny", input());
  const [request] = bridge.getPendingRequests("session-deny");
  const messages: unknown[] = [];

  await handleExternalActionResponse(
    recordingSocket(messages),
    request.sessionId,
    "selection-a",
    {
      requestId: request.requestId,
      sessionId: request.sessionId,
      selection_id: "selection-a",
      argumentsHash: request.argumentsHash,
      approved: false,
    },
    bridge,
  );

  assert.equal(attempts, 0);
  assert.equal((await decision).status, "denied");
  assert.equal((messages[0] as { status: string }).status, "denied");
});

test("quarantined sessions and empty selections are never approval clients", () => {
  assert.equal(isExternalActionApprovalClientEligible("selection-a", false), true);
  assert.equal(isExternalActionApprovalClientEligible("selection-a", true), false);
  assert.equal(isExternalActionApprovalClientEligible("", false), false);
  assert.equal(isExternalActionApprovalClientEligible(null, false), false);
});

test("terminal wire status is explicit and precedes the authoritative snapshot", () => {
  const event = {
    requestId: "request-a",
    sessionId: "session-a",
    status: "timeout" as const,
  };
  assert.deepEqual(
    serializeExternalActionTerminal(event, "selection-a"),
    {
      type: "external_action_terminal",
      requestId: "request-a",
      sessionId: "session-a",
      selection_id: "selection-a",
      status: "timeout",
    },
  );

  const messages: unknown[] = [];
  sendExternalActionTerminalState(
    recordingSocket(messages),
    event,
    "selection-a",
    () => [],
  );
  assert.deepEqual(messages, [
    {
      type: "external_action_terminal",
      requestId: "request-a",
      sessionId: "session-a",
      selection_id: "selection-a",
      status: "timeout",
    },
    {
      type: "external_action_snapshot",
      sessionId: "session-a",
      selection_id: "selection-a",
      requests: [],
      syncComplete: true,
    },
  ]);
});
