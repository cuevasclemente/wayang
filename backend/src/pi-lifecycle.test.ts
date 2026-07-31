import test from "node:test";
import assert from "node:assert/strict";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { serializeEvent } from "./pi-bridge.js";
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
