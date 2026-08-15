import assert from "node:assert/strict";
import test from "node:test";
import { logSessionRuntimeStartFailure, sessionRuntimeStartFailureRecord } from "./session-runtime-logging.js";
import { WorkspaceStoreError } from "./workspace-types.js";

test("runtime startup logging exposes only closed known Wayang startup failures", () => {
  const record = sessionRuntimeStartFailureRecord({
    source: "websocket",
    sessionId: "session-123",
    error: new WorkspaceStoreError("The trusted host bash definition was replaced during runtime creation", 409),
  });
  assert.deepEqual(record, {
    event: "session_runtime_start_failed",
    source: "websocket",
    session_id: "session-123",
    error_type: "known_startup",
    error_code: "trusted_host_bash_definition_replaced",
    status_code: 409,
    message: "The trusted host bash definition was replaced during runtime creation",
  });
});

test("runtime startup logging never rereads a classified error message", () => {
  const canary = "synthetic-stateful-getter-secret";
  const error = new WorkspaceStoreError("placeholder", 409);
  let reads = 0;
  Object.defineProperty(error, "message", {
    configurable: true,
    get() {
      reads += 1;
      return reads === 1
        ? "The trusted host bash definition was replaced during runtime creation"
        : canary;
    },
  });
  const lines: string[] = [];
  const record = logSessionRuntimeStartFailure({ source: "websocket", sessionId: "session-123", error },
    (line) => lines.push(line));
  assert.equal(reads, 1);
  assert.equal(record.error_code, "trusted_host_bash_definition_replaced");
  assert.equal(record.message, "The trusted host bash definition was replaced during runtime creation");
  assert.equal(lines[0]!.includes(canary), false);
});

test("runtime startup logging keeps arbitrary provider, extension, and forged store errors opaque", () => {
  const canaries = ["synthetic-secret-provider-body", "synthetic-forged-store-secret"];
  const errors = [
    new Error(`remote failure: ${canaries[0]}`),
    new WorkspaceStoreError(`forged controlled error: ${canaries[1]}`, Number.NaN),
  ];
  for (const error of errors) {
    const lines: string[] = [];
    const record = logSessionRuntimeStartFailure({
      source: "websocket",
      sessionId: "bad session id\n",
      error,
    }, (line) => lines.push(line));
    assert.equal(record.session_id, "invalid");
    assert.equal(record.error_type, "internal");
    assert.equal(record.error_code, "runtime_start_failed");
    assert.equal(record.status_code, 500);
    for (const canary of canaries) {
      assert.equal(record.message.includes(canary), false);
      assert.equal(lines[0]!.includes(canary), false);
    }
    assert.equal(lines.length, 1);
    assert.doesNotThrow(() => JSON.parse(lines[0]!.slice("[session-runtime] ".length)));
  }
});
