# Deferred Project–Agent Capability Activation

**Date:** 2026-08-27  
**Status:** Approved for implementation  
**Owner:** Wren / Wayang maintainer

## Problem

Capability activation previews currently reject every affected Project–Agent pair unless all of its runtimes are idle. The frontend collapses that conflict into “Capability state changed while creating the review,” even when no durable capability state changed. This prevents an owner from reviewing and approving a capability while an unrelated session for the target pair is running.

## Approved behavior

A capability remains associated with the immutable Project ID–Agent Profile ID pair, never with a provider/model or one session.

When the owner PIN-approves an association while affected work is running:

1. The durable pair association becomes active immediately.
2. New runtimes constructed after commit receive the capability.
3. Every runtime published before commit keeps its captured old tool/resource/lease set for its current turn and work already queued before commit.
4. A pre-existing runtime accepts no new top-level work after the activation latch.
5. After current and already-queued work settles, that handle is retired. The next action lazily constructs a coherent fresh runtime from the committed association set.
6. A runtime construction that began before activation cannot publish a mixed pre/post-activation capability set; it is invalidated and must retry.
7. Revocation remains denial-first and immediate. Deferred activation must not weaken or reuse the revocation latch.

The owner selected “finish already queued work under old capabilities, then refresh” and “new runtimes receive the grant immediately.”

## Security and threat-model constraints

The deterministic participating-runtime invariant is:

> No pre-activation runtime handle receives newly activated tools, global resources, host bash mode, browser leases, or Protected-automation bindings. New authority appears only on a coherently reconstructed runtime.

Wayang’s documented cooperative same-user limitations remain: host-execution can inspect same-user state, and network-enabled bash can forge loopback UI requests when passwordless loopback administration is enabled. This change does not claim cryptographic isolation from those actors. It must not expand those existing limitations or create a new direct runtime-tool path.

Activation is a widening transition. A distinct activation generation/latch is required because the revocation latch aborts agents, clears queues, removes tools, suppresses output, and tears down child authority.

## Architecture

### 1. Activation generation and handle state (`backend/src/pi-bridge.ts`)

Add a process-local activation generation per session and capture it at runtime creation. Published handles carry that generation plus a `capabilityRefreshPending` marker.

A synchronous activation latch for exact affected session IDs must:

- increment the activation generation;
- mark older published handles refresh-pending;
- invalidate in-progress construction through existing creation checkpoints;
- preserve current streaming, captured queues, tool objects, browser leases, output subscriptions, and runtime generation;
- schedule retirement only after the handle is fully idle.

It must not set `capabilityAuthorityDenied`, abort, clear queues, or revoke authority used by already-accepted work.

### 2. Coherent creation fence (`backend/src/pi-bridge.ts`)

`createPiSession()` captures both denial and activation generations before its first await. Every existing `assertCreationCurrent()` checkpoint validates both. A pre-activation construction therefore fails before handle publication even if the store commit occurs midway through resource/model/tool assembly.

If an existing handle is refresh-pending:

- while streaming or carrying already-accepted queued work, new attachment/turn attempts fail with a typed refresh-pending conflict without interrupting old work;
- while idle, the stale handle is destroyed and creation continues with the current activation generation.

### 3. New-work ingress fence

Add a top-level ingress check distinct from denial checks. It rejects new model-producing work on a refresh-pending handle while preserving controls needed to finish or stop old work.

Fence at least:

- browser WebSocket message acceptance before queue capture;
- resend;
- scheduled and connector prompt entry;
- interview submission delivery when it would trigger a new turn;
- model-producing slash/reload/compact paths.

Do not block:

- interrupt/abort;
- exact queued-message cancellation;
- interview, sudo, command-guard, or external-action responses belonging to already-accepted work;
- output/event subscription and transcript reads.

Recheck at the final synchronous acceptance boundary after any asynchronous attachment work.

### 4. Idle retirement

The existing `agent_settled` subscriber schedules retirement only when:

- the published handle identity still matches;
- refresh is pending;
- `isStreaming` is false;
- `pendingMessageCount` is zero;
- queued provenance/title settlement has completed.

The activation latch also schedules retirement for handles already idle. Retirement is best effort and lazy reconstruction remains the fallback.

### 5. Approval and commit flow

Capability preview may include idle, streaming, queued, starting, or mutation-locked runtime status for owner information. Runtime status/list drift is not authority state and must not invalidate the PIN review. The existing preview-state digest already excludes affected runtime status.

Keep the 64-runtime display bound. Runtime-limit failure must remain distinct from state conflict.

Commit ordering is synchronous and contains no `await` between the activation latch and durable store mutation:

1. Revalidate Project, Agent Profile, privacy/allowlist, association revision, and approval digest.
2. Resolve the exact current affected session IDs.
3. Latch activation generations/refresh markers.
4. Commit the association and approval event synchronously.
5. Resolve the committed event and return success.

Latching before persistence prevents an in-progress construction from observing a mixed state. If persistence unexpectedly fails, an unnecessary runtime refresh is safe and no association authority is created.

Revocation keeps its existing ordering: durable tombstone, then synchronous denial latch, then best-effort cleanup.

### 6. Standard-resource witness continuity

Audit and test the legacy-Wren compatibility witness. A newly preferred durable `standard-resources` association must not make an already-accepted legacy-Wren turn lose its captured resource/tool authority mid-turn. Existing handles validate their captured source against denial/ineligibility, while a fresh runtime resolves the newly active durable witness.

## Implementation roles

1. **Runtime lifecycle owner** — `pi-bridge.ts` and focused runtime/queue tests. Own activation generations, refresh markers, ingress fences, creation invalidation, and idle retirement.
2. **Approval integration owner** — capability integration/approval renderer/types/tests. Own preview semantics, runtime-list drift behavior, latch-before-commit ordering, and denial separation.
3. **UI/docs owner** — frontend/E2E and security/settings documentation. Own accurate review behavior and documented deferred-refresh semantics.
4. **Lead integrator** — merge role commits, resolve contracts, run broad gates, obtain independent security/concurrency review, integrate to `main` only after a clean reviewed result.

Each writer uses a separate branch/worktree. The lead branch remains the integration point.

## Regression matrix

### Runtime lifecycle

- Activation latch leaves current stream, already-captured queue, tools, runtime generation, browser lease, and subscriber output intact.
- A new message/resend/scheduled/connector turn is rejected on the stale handle.
- Interrupt and exact queued-message cancellation remain available.
- Final settlement with an empty queue retires the old handle; intermediate settlement with pending work does not.
- The next action creates a fresh handle and receives the new capability.
- Activation during runtime creation invalidates it before any handle publication; retry resolves one coherent post-commit set.
- Idle handles refresh without requiring a manual stop.
- Restart loses only process-local stale handles; durable association remains authoritative for all newly created runtimes.

### Approval integration

- Preview succeeds for idle, streaming, queued, starting, and mutation-locked affected runtimes.
- Runtime status/list drift between preview and commit does not conflict.
- Project/profile/privacy/allowlist/association revision drift still conflicts.
- Activation latch occurs before durable commit with no await.
- Commit failure after latch creates no authority but safely leaves refresh requested.
- PIN attempt remains single-use and owner/Origin-bound.
- Revocation behavior is unchanged.

### Capability classes

Test all five compiled IDs:

- `wayang.standard-resources.v1`
- `wayang.standard-browser.v1`
- `wayang.host-execution.v1`
- `wayang.protected-browser.v1`
- `wayang.protected-automation.v1`

Verify old handles gain no new tools/bindings and fresh handles do. Include legacy-Wren Standard-resource continuity and revoke/regrant revision behavior.

### UI/API

- Review creation succeeds while target pair has a busy runtime and renders affected statuses.
- PIN commit succeeds and reports that existing work will finish before refresh.
- No stale-state error is shown solely because a runtime is active.
- Runtime-count saturation has an accurate distinct response.

## Validation gates

1. Focused approval, integration, runtime-impact, Pi lifecycle, browser, host-execution, and Protected-automation tests.
2. Backend and frontend production builds.
3. Full workspace-capability Playwright suite with synthetic data/PIN only.
4. Full backend test suite and root `make check` if focused gates pass.
5. Independent security/concurrency review of the integrated diff.
6. Production build and service restart only after explicit deployment coordination; then smoke one busy-pair approval and verify the next turn runs on a fresh runtime.

## Rollback

Before deployment, rollback is a normal branch reset/revert. After deployment, revert the code and restart Wayang; durable capability associations remain valid under the prior idle-only runtime lifecycle. If a grant should not remain active, revoke it through the existing exact-revision Settings flow before or after rollback. Never edit the private store directly.

## Deferred scope

- Migrating already-queued messages into a new runtime.
- Delaying durable association activation until every old runtime is idle.
- Strong isolation from same-UID processes, host execution, or loopback-forged UI traffic.
- Changing revocation semantics.
