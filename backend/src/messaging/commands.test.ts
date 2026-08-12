import assert from "node:assert/strict";
import test from "node:test";
import { MAX_MESSAGING_INPUT_BYTES, parseMessagingInput } from "./commands.js";

test("parses portable messaging commands without sending them to the agent", () => {
  assert.deepEqual(parseMessagingInput("!new"), { kind: "command", command: { name: "new" } });
  assert.deepEqual(parseMessagingInput("  !SESSIONS  "), { kind: "command", command: { name: "sessions" } });
  assert.deepEqual(parseMessagingInput("!use 123e4567-e89b-12d3-a456-426614174000"), {
    kind: "command",
    command: { name: "use", sessionHandle: "123e4567-e89b-12d3-a456-426614174000" },
  });
  assert.deepEqual(parseMessagingInput("!status"), { kind: "command", command: { name: "status" } });
  assert.deepEqual(parseMessagingInput("!help"), { kind: "command", command: { name: "help" } });
});

test("uses an explicit double-bang escape and otherwise preserves prompt text", () => {
  assert.deepEqual(parseMessagingInput("ordinary prompt\nwith context"), {
    kind: "prompt",
    text: "ordinary prompt\nwith context",
  });
  assert.deepEqual(parseMessagingInput("  !!new details  "), {
    kind: "prompt",
    text: "  !new details  ",
  });
});

test("fails unknown or malformed commands closed", () => {
  const unknown = parseMessagingInput("!delete everything");
  assert.equal(unknown.kind, "invalid");
  if (unknown.kind === "invalid") assert.equal(unknown.code, "unknown_command");

  for (const input of ["!new title", "!sessions now", "!status verbose", "!help me", "!use", "!use two handles", "!use unsafe/handle"]) {
    const result = parseMessagingInput(input);
    assert.equal(result.kind, "invalid", input);
    if (result.kind === "invalid") assert.equal(result.code, "invalid_arguments", input);
  }
});

test("rejects non-text, empty, and oversized input deterministically", () => {
  assert.deepEqual(parseMessagingInput({ body: "!new" }), {
    kind: "invalid",
    code: "invalid_input",
    message: "Message must be text.",
  });
  assert.deepEqual(parseMessagingInput(" \n\t "), {
    kind: "invalid",
    code: "empty",
    message: "Message is empty.",
  });
  const boundary = parseMessagingInput("x".repeat(MAX_MESSAGING_INPUT_BYTES));
  assert.equal(boundary.kind, "prompt");
  const oversized = parseMessagingInput("x".repeat(MAX_MESSAGING_INPUT_BYTES + 1));
  assert.equal(oversized.kind, "invalid");
  if (oversized.kind === "invalid") assert.equal(oversized.code, "too_large");

  for (const unsafe of [
    "\u200b!new", "\u200b !new", "\u034f!new", "\u2061!new", "\u202e!new", "hello\u0000world", "\ud800!new",
  ]) {
    const result = parseMessagingInput(unsafe);
    assert.equal(result.kind, "invalid", JSON.stringify(unsafe));
    if (result.kind === "invalid") assert.equal(result.code, "invalid_input");
  }
  assert.equal(parseMessagingInput("👩‍💻 ordinary emoji prompt").kind, "prompt", "ordinary ZWJ emoji remains valid");

  const spoofed = parseMessagingInput("!unsafe-command");
  assert.equal(spoofed.kind, "invalid");
  if (spoofed.kind === "invalid") {
    assert.equal(spoofed.code, "unknown_command");
    assert.equal(spoofed.message.includes("unsafe"), false, "unknown command tokens are not reflected");
  }
});
