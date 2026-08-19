import test from "node:test";
import assert from "node:assert/strict";
import type { PiSessionHandle } from "../pi-bridge.js";
import { resolveWebSocketRuntimeHandle } from "./ws.js";

function handle(denied = false): PiSessionHandle {
  return { capabilityAuthorityDenied: denied } as PiSessionHandle;
}

test("passive reconnect rebuilds a denied live runtime", async () => {
  const denied = handle(true);
  const replacement = handle(false);
  let creates = 0;

  const resolved = await resolveWebSocketRuntimeHandle(denied, false, async () => {
    creates += 1;
    return replacement;
  });

  assert.equal(creates, 1);
  assert.equal(resolved, replacement);
});

test("passive selection preserves healthy or stopped runtime state", async () => {
  const healthy = handle(false);
  let creates = 0;
  const create = async () => {
    creates += 1;
    return handle(false);
  };

  assert.equal(await resolveWebSocketRuntimeHandle(healthy, false, create), healthy);
  assert.equal(await resolveWebSocketRuntimeHandle(undefined, false, create), undefined);
  assert.equal(creates, 0);
});

test("pre-message ensure delegates healthy runtime revalidation to creation", async () => {
  const healthy = handle(false);
  const replacement = handle(false);
  let creates = 0;

  const resolved = await resolveWebSocketRuntimeHandle(healthy, true, async () => {
    creates += 1;
    return replacement;
  });

  assert.equal(creates, 1);
  assert.equal(resolved, replacement);
});

test("failed stale-runtime replacement never falls back to the denied handle", async () => {
  const denied = handle(true);
  await assert.rejects(
    resolveWebSocketRuntimeHandle(denied, false, async () => {
      throw new Error("fresh authority unavailable");
    }),
    /fresh authority unavailable/,
  );
});
