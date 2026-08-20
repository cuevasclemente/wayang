# WebSocket runtime attachment cancellation

**Date:** 2026-08-20
**Branch:** `fix/ws-runtime-attachment-cancellation`
**Base:** `b4368462c501`

## Problem

A browser send could race an asynchronous Pi runtime attachment or internal session rebind. The backend correctly refused to dispatch after the WebSocket selection became stale, but represented that normal cancellation as a generic startup failure:

`Failed to start pi session: Session selection changed before runtime attachment completed`

The generic catch persisted the message as the session's durable error. The rejection path could also lose the optimistically cleared browser draft and prepare private attachment files before attachment succeeded.

## Implementation

- Retained the fail-closed selection/runtime attachment guard.
- Added one bounded attachment retry when the exact session and selection remain current after an internal setup refresh.
- Added a typed, machine-coded `selection_changed` cancellation for genuine staleness.
- Centralized WebSocket client-failure wire/persistence policy so stale cancellation returns a correlated rejection without replacing durable session errors; real runtime creation failures still persist.
- Deferred backend attachment preparation until runtime attachment succeeds, preventing orphaned private upload artifacts from stale sends.
- Kept submitted browser payloads session-scoped until terminal acknowledgement.
- Preserved text drafts until accepted/queued acknowledgement and restored rejected attachments to the source session.
- Bound asynchronous file conversion to the session that initiated it.
- Correlated queue snapshot hydration by both client message ID and session ID.
- Preserved interrupted queued attachments across session switches.
- Removed rejected queue entries after restoring their payload.
- Kept the composer and attachment draft intact when the WebSocket enters `CLOSING` between the UI readiness check and actual send.

## Validation

- Focused backend attachment/runtime tests: 13 passed.
- Backend TypeScript build: passed.
- Frontend production build: passed.
- Frontend lint: 0 errors; one pre-existing Fast Refresh warning in `SessionResultSnippet.tsx`.
- Focused Playwright queue/session/attachment suite: 8 passed in the final full run.
- Independent review iterations found and drove fixes for cross-session attachment conversion, queue hydration correlation, interrupted attachment persistence, rejected queue zombies, and closing-socket send loss. Terminal review: GO, no blocking findings.

A broad backend run passed 930 tests with 5 skipped and 0 failures before the final frontend/data-preservation additions. A later resource-contended broad run produced unrelated timeout/sandbox failures; isolated reruns passed production activation and sandbox tests, while the interview-provenance timeout reproduced unchanged on base `main`. Focused changed-path backend tests remained green.

## Deployment

No deployment or service restart is part of this commit. The running service continues using the previous build until the branch is merged, built, and restarted through the normal deployment process.
