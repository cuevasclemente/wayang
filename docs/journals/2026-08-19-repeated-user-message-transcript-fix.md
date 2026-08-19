# Repeated user-message transcript fix — 2026-08-19

## Symptom

A user reply such as `done` reached Pi and started the next assistant turn, but the live Wayang transcript showed no new user row.

## Root cause

`ChatPanel` treated content similarity as global message identity. When a new user turn repeated any earlier user text, both the optimistic browser echo and Pi's live user echo could be deduplicated against the old persisted occurrence.

The same assumption also affected authoritative history and queued-turn reconciliation: an older same-content history row could consume a newer optimistic or queued occurrence.

## Change

- Durable user events deduplicate only by their stable transcript event ID.
- Content matching is limited to replacing the browser's own optimistic echo or pairing an ID-less live echo with its later persisted history occurrence.
- Authoritative history reconciliation is occurrence-aware:
  - reserve all exact durable IDs first;
  - never content-match a durable current ID that is absent from the authoritative snapshot;
  - use content fallback only for ID-less live rows;
  - consume a pending echo only when a genuinely new matching history occurrence remains.
- Queued-turn reconciliation now considers only genuinely new history occurrences, so an older identical reply cannot falsely accept the queue.

## Regression coverage

`e2e/tests/assistant-stream-timeline.spec.ts` now covers:

1. a repeated short live reply remaining visible as a distinct turn;
2. stale history, same-ID replay, removed same-content rows, and authoritative acceptance of an optimistic reply;
3. repeated queued content remaining queued across old history and being consumed only by a new accepted occurrence.

## Validation

- `npm --prefix frontend run build` — pass.
- `npm --prefix frontend run lint` — pass with the pre-existing `SessionResultSnippet.tsx` fast-refresh warning.
- Focused Playwright suite (`assistant-stream-timeline`, `message-temporal-consistency`, `queued-message-cancellation`) — 18/18 pass.
- Final independent concurrency review — GO, no actionable findings.
- `make check` was attempted; the broad backend test phase exceeded the 20-minute command limit after three unrelated timing/environment tests reported failures. Each reported test passed when rerun independently:
  - action-approval expired replay;
  - direct Bubblewrap feasibility;
  - Milestone 0 protected-automation feasibility gate.

## Files

- `frontend/src/panels/ChatPanel.tsx`
- `e2e/tests/assistant-stream-timeline.spec.ts`
