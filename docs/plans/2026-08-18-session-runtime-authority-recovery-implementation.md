# Session Runtime Authority Recovery Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Make Wayang reconnects and browser message sends replace denied or revoked live session handles before subscribing or dispatching a turn.

**Architecture:** Add a small WebSocket runtime-resolution seam that treats an existing stale handle differently from a genuinely stopped session. Reuse `piSessionHandleRequiresFreshRuntime()` for classification and the existing `createPiSession()` lifecycle for authoritative destroy/rebuild behavior; never revive the denied handle.

**Tech Stack:** TypeScript, Node test runner with `tsx`, Wayang Pi bridge, WebSocket route lifecycle.

---

### Task 1: Add failing WebSocket runtime-resolution regressions

**Parallelizable:** No. Task 2 depends on the exact helper contract established here, and both tasks modify `backend/src/routes/ws.ts` or its direct test.

**Files (exclusive to this task):**
- Create: `backend/src/routes/ws-runtime-recovery.test.ts`
- Read: `backend/src/pi-bridge.ts:2020-2070`
- Read: `backend/src/routes/ws.ts:440-490,1035-1065`

**Context for teammate:** A capability mutation can leave a denied `PiSessionHandle` in the live `sessions` map while asynchronous cleanup waits for a streaming turn to settle. `createPiSession()` already replaces such a handle, but the WebSocket attach path currently checks only whether a handle exists. The new test seam must exercise the real `piSessionHandleRequiresFreshRuntime()` predicate while injecting only the creation callback; do not construct a real provider-backed Pi runtime.

**Step 1: Write the failing test**

Create `backend/src/routes/ws-runtime-recovery.test.ts` with focused cases for the wished-for API:

```ts
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
  let creates = 0;

  const resolved = await resolveWebSocketRuntimeHandle(healthy, true, async () => {
    creates += 1;
    return healthy;
  });

  assert.equal(creates, 1);
  assert.equal(resolved, healthy);
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
```

If `PiSessionHandle` is not exported as a type from the current module surface, use `Parameters<typeof resolveWebSocketRuntimeHandle>[0]` after Task 2 establishes the signature or export only the existing type; do not add runtime state or test-only production mutation methods.

**Step 2: Run the test to verify RED**

Run:

```bash
cd backend
node --import tsx --test src/routes/ws-runtime-recovery.test.ts
```

Expected: FAIL because `resolveWebSocketRuntimeHandle` is not exported from `routes/ws.ts`.

**Step 3: Commit the red test**

```bash
git add backend/src/routes/ws-runtime-recovery.test.ts
git commit -m "test: reproduce stale WebSocket runtime reuse"
```

---

### Task 2: Resolve stale handles before WebSocket subscription and message dispatch

**Parallelizable:** No. Depends on Task 1 and owns the production file under test.

**Files (exclusive to this task):**
- Modify: `backend/src/routes/ws.ts:1-80,440-490,1035-1065`
- Test: `backend/src/routes/ws-runtime-recovery.test.ts`

**Context for teammate:** Preserve every existing authorization assertion. The resolver decides only whether to invoke the existing creation lifecycle; `createPiSession()` remains responsible for destroying stale authority and rebuilding from current durable Project–Agent state. Returning the replacement handle is essential because the caller must unsubscribe from the old event emitter and subscribe to the new one before `sendMessage()` runs.

**Step 1: Add the minimal resolver**

Import `piSessionHandleRequiresFreshRuntime` from `../pi-bridge.js`, then add this testable route seam near the other exported WebSocket helpers:

```ts
/** @internal Exported for stale-runtime WebSocket regression tests. */
export async function resolveWebSocketRuntimeHandle(
  existing: PiSessionHandle | undefined,
  createIfMissing: boolean,
  create: () => Promise<PiSessionHandle>,
): Promise<PiSessionHandle | undefined> {
  if (!existing) return createIfMissing ? create() : undefined;
  if (!createIfMissing && !piSessionHandleRequiresFreshRuntime(existing)) return existing;
  return create();
}
```

Do not catch creation failures and do not return `existing` after a failed replacement.

**Step 2: Make the WebSocket creation helper return the authoritative handle**

Change the private helper signature and remove its stale-blind early return:

```ts
async function getOrCreatePiSession(id: string): Promise<PiSessionHandle> {
  const session = getSessionById(id);
  if (!session) throw new Error("Session not found in DB");
  if (isLegacyPrivateSessionQuarantined(session)) {
    throw new Error("Quarantined legacy sessions cannot start a runtime");
  }

  let handle: PiSessionHandle;
  try {
    handle = await createPiSession(
      id,
      session.cwd,
      session.provider || null,
      session.model || null,
      session.pi_session_file,
    );
  } catch (error) {
    logSessionRuntimeStartFailure({ source: "websocket", sessionId: id, error });
    throw error;
  }
  ensureInteractiveCommandGuardEnabled(id, "websocket-created pi session");
  if (handle.sessionFile && !session.pi_session_file) updatePiSessionFile(id, handle.sessionFile);
  return handle;
}
```

Calling `createPiSession()` for a healthy handle is cheap and returns that same handle after its existing freshness check. A stale handle follows its existing destroy/rebuild path.

**Step 3: Use the resolver before reading history or binding subscriptions**

At the start of `attachLiveSession()`, replace the boolean existence branch with:

```ts
const existingHandle = getPiSession(nextSessionId);
const liveHandle = await resolveWebSocketRuntimeHandle(
  existingHandle,
  createIfMissing,
  () => getOrCreatePiSession(nextSessionId),
);
if (!liveHandle) {
  wsProfile(nextSessionId, "attach_live_skip", `duration=${elapsedMs(attachStart)} reason=not_live`);
  return false;
}
```

Keep the existing subscription replacement block. It will compare `subscribedHandle` with `liveHandle`, unsubscribe from the denied handle, and bind to the replacement before message dispatch.

Update profiling to report the pre-resolution handle state without logging private binding data. Do not add transcript, capability identifier, Project path, or profile data to logs.

**Step 4: Run the focused test to verify GREEN**

Run:

```bash
cd backend
node --import tsx --test src/routes/ws-runtime-recovery.test.ts
```

Expected: 4 tests pass, 0 fail.

**Step 5: Run focused bridge and route regressions**

Run:

```bash
cd backend
node --import tsx --test \
  --test-name-pattern='later prompt rebuilds|WebSocket|runtime WebSocket projection' \
  src/pi-bridge.test.ts \
  src/routes/session-runtime-state.test.ts \
  src/routes/ws-runtime-recovery.test.ts
```

Expected: selected tests pass; unrelated tests are skipped.

**Step 6: Build the backend**

Run:

```bash
npm --prefix backend run build
```

Expected: TypeScript build exits 0.

**Step 7: Commit the implementation**

```bash
git add backend/src/routes/ws.ts backend/src/routes/ws-runtime-recovery.test.ts
git commit -m "fix: rebuild denied session runtimes on reconnect"
```

---

### Task 3: Validate, review, and publish the PR

**Parallelizable:** No. Depends on Task 2 and validates the final branch state.

**Files (exclusive to this task):**
- Review only: `backend/src/routes/ws.ts`
- Review only: `backend/src/routes/ws-runtime-recovery.test.ts`
- Review only: `docs/plans/2026-08-18-session-runtime-authority-recovery-design.md`

**Context for teammate:** The unchanged branch baseline timed out under local Node 25, which Wayang's doctor reports is outside CI coverage. Do not claim the full gate passes unless it is rerun successfully under supported Node 22 or 26. Focus the review on no authority revival, no message retry, stopped-session laziness, and replacement-handle subscription ownership.

**Step 1: Review the final diff**

Run:

```bash
git diff origin/main...HEAD --check
git diff origin/main...HEAD -- backend/src/routes/ws.ts backend/src/routes/ws-runtime-recovery.test.ts
```

Expected: no whitespace errors; diff is limited to stale-runtime resolution, regression tests, and approved plans.

**Step 2: Run fresh focused verification**

Run the exact focused test and backend build commands from Task 2 again. Record command output and exit codes for the PR body.

If a CI-supported Node runtime becomes available, also run:

```bash
make check
```

Otherwise state precisely that the unchanged `origin/main` baseline timed out under Node 25 before implementation and that focused tests plus backend build were used locally.

**Step 3: Request code review**

Use `superpowers:requesting-code-review` against `origin/main...HEAD`. Address only findings within this fix's scope, rerunning the focused tests after any change.

**Step 4: Push the branch**

```bash
git push -u origin fix/session-runtime-authority-recovery
```

Expected: remote branch is created or updated successfully.

**Step 5: Open the pull request**

Use `gh pr create` with:

- Title: `fix: rebuild denied session runtimes on reconnect`
- Base: `main`
- Head: `fix/session-runtime-authority-recovery`
- Body sections: Summary, Root cause, Security properties, Tests, Baseline limitation.

The PR body must say that stale handles are destroyed/rebuilt under current authorization, not revived; no transcript or private binding data should be included.
