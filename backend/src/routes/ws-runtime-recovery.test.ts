import test from "node:test";
import assert from "node:assert/strict";
import type { PiSessionHandle } from "../pi-bridge.js";
import {
  isStaleWebSocketRuntimeAttachmentError,
  requireWebSocketRuntimeAttachment,
  resolveWebSocketRuntimeHandle,
} from "./ws.js";

function handle(denied?: true): PiSessionHandle {
  return (denied ? { capabilityAuthorityDenied: true } : {}) as PiSessionHandle;
}

test("passive reconnect rebuilds denied and revoked live runtimes", async () => {
  const denied = handle(true);
  const revoked = {
    protectedBrowserRuntime: {
      preflight: () => ({ allowed: false, reason: "synthetic revoked runtime" }),
    },
  } as unknown as PiSessionHandle;
  const deniedReplacement = handle();
  const revokedReplacement = handle();
  let deniedCreates = 0;
  let revokedCreates = 0;

  const deniedResolved = await resolveWebSocketRuntimeHandle(denied, false, async () => {
    deniedCreates += 1;
    return deniedReplacement;
  });
  const revokedResolved = await resolveWebSocketRuntimeHandle(revoked, false, async () => {
    revokedCreates += 1;
    return revokedReplacement;
  });

  assert.equal(deniedCreates, 1);
  assert.equal(revokedCreates, 1);
  assert.equal(deniedResolved, deniedReplacement);
  assert.equal(revokedResolved, revokedReplacement);
});

test("passive selection preserves healthy or stopped runtime state", async () => {
  const healthy = handle();
  let creates = 0;
  const create = async () => {
    creates += 1;
    return handle();
  };

  assert.equal(await resolveWebSocketRuntimeHandle(healthy, false, create), healthy);
  assert.equal(await resolveWebSocketRuntimeHandle(undefined, false, create), undefined);
  assert.equal(creates, 0);
});

test("pre-message ensure delegates healthy runtime revalidation to creation", async () => {
  const healthy = handle();
  const replacement = handle();
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
  const creationError = new Error("fresh authority unavailable");
  await assert.rejects(
    resolveWebSocketRuntimeHandle(denied, false, async () => {
      throw creationError;
    }),
    (error) => error === creationError,
  );
});

test("runtime attachment retries once when the exact selection remains current", async () => {
  let attempts = 0;
  await assert.doesNotReject(requireWebSocketRuntimeAttachment(
    async () => {
      attempts += 1;
      return attempts === 2;
    },
    () => true,
  ));
  assert.equal(attempts, 2);
});

test("runtime attachment stays fail-closed after a genuine selection change", async () => {
  let attempts = 0;
  let dispatches = 0;

  await assert.rejects(
    requireWebSocketRuntimeAttachment(
      async () => {
        attempts += 1;
        return false;
      },
      () => false,
    ).then(() => {
      dispatches += 1;
    }),
    (error) => {
      assert.equal(isStaleWebSocketRuntimeAttachmentError(error), true);
      assert.equal((error as { code?: unknown }).code, "selection_changed");
      assert.equal(
        (error as Error).message,
        "Session action was not sent because the selection changed during runtime attachment",
      );
      return true;
    },
  );
  assert.equal(attempts, 1);
  assert.equal(dispatches, 0);
});

test("a superseded same-selection retry remains a nonpersistent cancellation", async () => {
  let attempts = 0;
  let cancellation: unknown;
  try {
    await requireWebSocketRuntimeAttachment(
      async () => {
        attempts += 1;
        return false;
      },
      () => true,
    );
  } catch (error) {
    cancellation = error;
  }

  assert.equal(attempts, 2);
  assert.equal(isStaleWebSocketRuntimeAttachmentError(cancellation), true);
});

test("successful and failed runtime creation do not receive a stale-selection retry", async () => {
  await assert.doesNotReject(requireWebSocketRuntimeAttachment(async () => true, () => true));

  const creationError = new Error("runtime creation failed");
  let attempts = 0;
  await assert.rejects(
    requireWebSocketRuntimeAttachment(async () => {
      attempts += 1;
      throw creationError;
    }, () => true),
    (error) => error === creationError,
  );
  assert.equal(attempts, 1);
});
