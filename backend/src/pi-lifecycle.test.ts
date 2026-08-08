import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { serializeEvent, serializeHistoryEntries } from "./pi-bridge.js";
import { shouldReconcileLiveSessionState } from "./routes/ws.js";

test("serializes the settled lifecycle event used for final context accounting", () => {
  assert.deepEqual(
    serializeEvent({ type: "agent_settled" } as AgentSessionEvent),
    { type: "agent_settled" },
  );
});

test("serializes compaction lifecycle metadata and errors without transcript content", () => {
  assert.deepEqual(
    serializeEvent({ type: "compaction_start", reason: "threshold" } as AgentSessionEvent),
    { type: "compaction_start", reason: "threshold" },
  );

  assert.deepEqual(
    serializeEvent({
      type: "compaction_end",
      reason: "threshold",
      result: undefined,
      aborted: false,
      willRetry: false,
      errorMessage: "Auto-compaction failed: synthetic provider failure",
    } as AgentSessionEvent),
    {
      type: "compaction_end",
      reason: "threshold",
      succeeded: false,
      aborted: false,
      will_retry: false,
      error: "Auto-compaction failed: synthetic provider failure",
    },
  );
});

test("omits a recovered provider overflow from rendered history while retaining the compaction", () => {
  const overflowMessage = {
    role: "assistant",
    content: [],
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    stopReason: "error",
    errorMessage: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
    timestamp: Date.now(),
  };
  const history = serializeHistoryEntries([
    { type: "message", id: "user", parentId: null, message: { role: "user", content: "synthetic" } },
    { type: "message", id: "overflow", parentId: "user", message: overflowMessage },
    {
      type: "compaction",
      id: "compaction",
      parentId: "overflow",
      summary: "synthetic compacted context",
      timestamp: new Date().toISOString(),
    },
  ]);

  assert.deepEqual(history.map((entry) => entry.type), ["user", "custom"]);
  assert.equal((history[1].message as any)?.customType, "compaction-summary");
});

test("retains terminal assistant errors that were not followed by recovery compaction", () => {
  const history = serializeHistoryEntries([{
    type: "message",
    id: "terminal-error",
    parentId: null,
    message: {
      role: "assistant",
      content: [],
      stopReason: "error",
      errorMessage: "Synthetic terminal provider error",
    },
  }]);

  assert.equal(history.length, 1);
  assert.equal((history[0].message as any)?.errorMessage, "Synthetic terminal provider error");
});

test("refreshes live history and context only at authoritative lifecycle boundaries", () => {
  assert.equal(shouldReconcileLiveSessionState({ type: "agent_end" }), false);
  assert.equal(shouldReconcileLiveSessionState({ type: "agent_settled" }), true);
  assert.equal(shouldReconcileLiveSessionState({ type: "compaction_end", succeeded: true }), true);
  assert.equal(shouldReconcileLiveSessionState({ type: "compaction_end", succeeded: false }), false);
});

test("serializes successful compaction estimates and agent retry intent", () => {
  assert.deepEqual(
    serializeEvent({
      type: "compaction_end",
      reason: "overflow",
      result: {
        summary: "synthetic summary that must not cross the websocket lifecycle event",
        firstKeptEntryId: "kept-entry",
        tokensBefore: 120_000,
        estimatedTokensAfter: 24_000,
      },
      aborted: false,
      willRetry: true,
    } as AgentSessionEvent),
    {
      type: "compaction_end",
      reason: "overflow",
      succeeded: true,
      aborted: false,
      will_retry: true,
      tokens_before: 120_000,
      estimated_tokens_after: 24_000,
    },
  );

  const serializedAgentEnd = serializeEvent({
    type: "agent_end",
    messages: [],
    willRetry: true,
  } as AgentSessionEvent);
  assert.equal(serializedAgentEnd?.will_retry, true);
});
