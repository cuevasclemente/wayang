# Compaction message queue

**Date:** 2026-08-27  
**Status:** release GO in isolated branch; integration pending

## Request

Allow ordinary chat messages to be submitted while Wayang is compacting a session. Messages should remain visibly queued in FIFO order and dispatch only after compaction is over.

## Diagnosis

Wayang already had an exact browser-message acknowledgement, snapshot, targeted-cancellation, and Pi steering queue path. Two compaction-specific gates prevented the desired behavior:

- `ChatPanel` disabled send whenever `isCompacting` was true.
- Manual `/compact` held the transcript mutation lease for the full asynchronous compaction, so the WebSocket route rejected all concurrent messages as `mutation_locked`.

Automatic threshold/overflow compaction remains inside Pi's active streaming lifecycle, where ordinary messages can use the existing `steer()` queue. Manual compaction runs outside that prompt lifecycle and needs a Wayang-owned deferred queue until Pi can safely accept a prompt.

## Implementation

- The composer remains enabled during compaction and renders submitted messages through the existing queued-message cards.
- Legacy `compaction_end_reconciliation` preserves queued cards rather than clearing them merely because the runtime is no longer streaming.
- Each exact live `PiSessionHandle` can own one bounded manual-compaction FIFO:
  - maximum 32 records;
  - maximum 32 MiB retained payload;
  - ordinary non-slash messages only;
  - existing client message IDs, display metadata, attachments, snapshots, and targeted cancellation;
  - serial dispatch after the exact compaction mutation lease releases;
  - new ordinary messages during drain join the tail and cannot overtake;
  - runtime generation/authority loss drops stale work;
  - queue-clearing Interrupt removes deferred records before aborting.
- Generic mutation locks still reject messages. Interrupt is admitted only for the exact manual-compaction phase, and model/agent changes remain idle-only while the FIFO exists.
- Manual `/compact` now requires an idle runtime with no Pi pending messages. This prevents a deferred record from overlapping an already-active Pi steering queue.
- Asynchronous bounded transcript windows are discarded if runtime streaming state advances while they load, preventing a stale post-compaction idle snapshot from overwriting the newly started queued turn.
- Dispatch failures use bounded errors and exact rejected acknowledgements for currently attached clients.

No durable store schema or migration was added. The queue is live-runtime state, matching the existing Pi steering queue boundary.

## Regression coverage

- Focused backend tests cover:
  - lease release before FIFO dispatch;
  - A/B/C ordering and tail admission;
  - reconnect projection and exact cancellation;
  - slash rejection and count bounds;
  - failed-head continuation and authority-loss stop;
  - client-ID correlation at `message_start`;
  - Interrupt queue clearing.
- A focused Playwright test covers a manual-compaction snapshot with no active stream:
  - enabled composer and Queue button;
  - two ordered queued cards;
  - no premature transcript rows;
  - queue preservation across compaction reconciliation;
  - exact FIFO removal as each queued turn starts.

## Validation

Passed on the final branch rebased onto `main` at `727dbbc`:

- `make doctor` (0 failures; existing local permission/PIN metadata warnings)
- backend TypeScript build
- frontend TypeScript/Vite production build
- frontend lint (0 errors; one pre-existing Fast Refresh warning)
- focused compaction/interrupt backend tests: 3/3
- focused mutation-lock route tests: 4/4
- focused Playwright compaction queue test: 1/1
- full backend suite: 1,048 pass, 6 skip, with one unrelated questionnaire-provenance timing failure; that exact test passed on immediate rerun
- `git diff --check`

Independent review initially found and prompted fixes for interrupt admission, stale asynchronous transcript reconciliation, model/agent switch overlap, the dispatching cancellation transition, and manual compaction while an existing Pi run/queue was active. Final focused review returned GO after the idle-compaction gate. Broader pre-existing queue limitations, such as durable terminal outcome replay across runtime loss, remain outside this live-runtime feature.

## Deployment

A backend restart and browser refresh are required after the feature is integrated and production assets are rebuilt. The restart that occurred during implementation predates this feature and does not deploy it.
