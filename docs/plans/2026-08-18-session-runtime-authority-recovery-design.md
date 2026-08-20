# Session runtime authority recovery design

**Date:** 2026-08-18
**Status:** Approved

## Problem

Workspace capability changes correctly deny a live Pi session handle and require fresh runtime authority. The WebSocket recovery path currently treats any entry in the live-session map as healthy. It therefore returns the denied handle without invoking `createPiSession()`, even though `createPiSession()` already knows how to destroy denied or revoked handles and construct a fresh runtime.

The next browser message then reaches the fail-closed authority assertion and is rejected with:

> Session runtime authority was denied; reconnect to create a fresh runtime

A reconnect can attach to the same denied handle for the same reason, leaving the UI connected to the WebSocket but unable to start another agent turn.

## Goals

- Rebuild a denied or revoked live handle on reconnect or before the next browser message.
- Preserve fail-closed capability checks and current durable Project–Agent authorization.
- Rebind WebSocket event delivery to the replacement handle before dispatching a message.
- Keep stopped sessions lazy: ordinary selection must not start a runtime that did not already exist.
- Reject the turn without partial acceptance when fresh authority cannot be created.

## Non-goals

- Do not clear the denial flag or revive an old handle.
- Do not weaken capability preflight, project authorization, or runtime-generation checks.
- Do not eagerly interrupt every active turn at the moment a capability setting changes.
- Do not add frontend state, a durable-data migration, or automatic message retry after partial acceptance.

## Considered approaches

### 1. Freshness-aware WebSocket attach and ensure — selected

Classify denied or revoked handles as stale at the WebSocket boundary. A reconnect rebuilds an existing stale handle. Before a message, the ensure path asks `createPiSession()` to revalidate the current handle; healthy handles are reused and stale handles are destroyed and rebuilt. The WebSocket then subscribes to the returned live handle before the turn is sent.

This uses the existing authoritative lifecycle and keeps transport subscription ownership aligned with the runtime that will emit the response.

### 2. Destroy every denied handle immediately

This would make existing missing-runtime behavior recreate the handle. It is rejected because denial can occur while a turn is settling. Immediate destruction adds avoidable lifecycle races and interruption, while the existing denial latch already blocks future privileged work synchronously.

### 3. Retry inside `sendMessage()`

This is rejected because the WebSocket may remain subscribed to the destroyed handle and miss replacement-runtime events. Retrying after a prompt might have been partially accepted could also duplicate a user turn.

## Design

The WebSocket live-attach path will distinguish three states:

1. **No live handle, passive selection/reconnect:** load persisted history and leave the runtime stopped.
2. **Healthy live handle:** reuse it and retain the existing subscription when possible.
3. **Denied or revoked live handle:** route it through the normal session creation entry point, which destroys it and creates a fresh handle under current durable authorization.

The message path uses the same ensure operation before dispatch. It then resolves the current handle again and rebinds subscriptions if replacement occurred. No prompt is sent until fresh runtime creation and subscription succeed.

`assertCapabilityAuthorityAvailable()` remains unchanged. Runtime creation continues to recheck the durable session, Project, Agent Profile, capability association, runtime generation, and protected-tool preflight. Failure returns the existing correlated WebSocket rejection without accepting the turn.

A denial that races after the final ensure can still reject the message. That is the correct fail-closed outcome; the user can retry, and the next ensure will rebuild from the newer generation.

## Testing

Add focused regression coverage that proves:

- passive reconnect replaces an existing denied/revoked handle;
- passive selection does not start a genuinely stopped session;
- pre-message ensure reuses a healthy handle or replaces a stale one;
- the replacement handle is the one returned for WebSocket subscription and message dispatch;
- creation failure does not return the denied handle or accept a turn.

Run the focused WebSocket/runtime tests and backend build/typecheck. Run the broader project gate when a CI-supported Node runtime is available; record any unchanged baseline limitation separately from the fix.

## Rollback

Revert the backend commit. No data migration or frontend rollback is required. Existing fail-closed denial behavior remains the fallback.
