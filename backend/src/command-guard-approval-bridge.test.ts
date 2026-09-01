/**
 * Unit tests for the command-guard approval bridge: boolean resolution,
 * session binding, timeout-null semantics, and cancellation. These mirror the
 * identity PIN bridge contract but resolve approve/deny instead of a PIN and
 * never carry secret values.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { PiCommandGuardApprovalBridge } from "./command-guard-bridge.js";

test("requestCommandApproval resolves true when the owning human approves", async () => {
  const bridge = new PiCommandGuardApprovalBridge();
  const requests: Array<{ requestId: string; sessionId: string; command?: string; reason?: string }> = [];
  bridge.onRequest((req) => {
    requests.push({
      requestId: req.requestId,
      sessionId: req.sessionId,
      command: req.command,
      reason: req.reason,
    });
    assert.equal(bridge.resolveForSession("session-1", req.requestId, true), true);
  });
  const pending = bridge.requestCommandApproval("session-1", "Command guard model unavailable", 5_000, {
    command: "printf ok",
    reason: "stopReason=length",
  });
  assert.equal(await pending, true);
  assert.equal(requests.length, 1);
  assert.equal(requests[0]!.sessionId, "session-1");
  assert.equal(requests[0]!.command, "printf ok");
  assert.equal(requests[0]!.reason, "stopReason=length");
});

test("requestCommandApproval resolves false on explicit denial", async () => {
  const bridge = new PiCommandGuardApprovalBridge();
  bridge.onRequest((req) => {
    bridge.resolveForSession("session-1", req.requestId, false);
  });
  const pending = bridge.requestCommandApproval("session-1", "prompt", 5_000);
  assert.equal(await pending, false);
});

test("non-boolean and unknown values deny, never allow", async () => {
  const bridge = new PiCommandGuardApprovalBridge();
  bridge.onRequest((req) => {
    // Missing approved field must deny; arbitrary truthy-looking values must
    // not be interpreted as approval.
    assert.equal(bridge.resolveForSession("session-1", req.requestId, undefined as unknown as boolean), true);
  });
  const pending = bridge.requestCommandApproval("session-1", "prompt", 5_000);
  assert.equal(await pending, false);
});

test("timeout resolves null so the guard fails closed", async () => {
  const bridge = new PiCommandGuardApprovalBridge();
  const pending = bridge.requestCommandApproval("session-1", "prompt", 20);
  assert.equal(await pending, null);
});

test("cross-session and unknown resolutions never consume a waiter", async () => {
  const bridge = new PiCommandGuardApprovalBridge();
  let resolvedRequestId = "";
  bridge.onRequest((req) => {
    resolvedRequestId = req.requestId;
    assert.equal(bridge.resolveForSession("session-2", req.requestId, true), false);
    assert.equal(bridge.resolveForSession("session-1", "unknown-request", true), false);
    assert.equal(bridge.resolve("unrelated-request", true), false);
  });
  const pending = bridge.requestCommandApproval("session-1", "prompt", 5_000);
  assert.equal(bridge.resolveForSession("session-1", resolvedRequestId, true), true);
  assert.equal(await pending, true);
});

test("cancelSession resolves null for the session only", async () => {
  const bridge = new PiCommandGuardApprovalBridge();
  const requests: string[] = [];
  bridge.onRequest((req) => {
    requests.push(req.requestId);
  });
  const pendingA = bridge.requestCommandApproval("session-a", "prompt", 5_000);
  const pendingB = bridge.requestCommandApproval("session-b", "prompt", 5_000);
  bridge.cancelSession("session-a");
  assert.equal(await pendingA, null);
  assert.equal(bridge.resolveForSession("session-b", requests[1]!, true), true);
  assert.equal(await pendingB, true);
});

test("getPendingRequests returns only the requested session's open requests", async () => {
  const bridge = new PiCommandGuardApprovalBridge();
  bridge.onRequest(() => {});
  const pendingA = bridge.requestCommandApproval("session-a", "prompt a", 5_000, { command: "cmd-a" });
  bridge.requestCommandApproval("session-b", "prompt b", 5_000, { command: "cmd-b" });
  const pending = bridge.getPendingRequests("session-a");
  assert.equal(pending.length, 1);
  assert.equal(pending[0]!.sessionId, "session-a");
  assert.equal(pending[0]!.command, "cmd-a");
  bridge.cancelSession("session-b");
  bridge.cancelSession("session-a");
  assert.equal(await pendingA, null);
});