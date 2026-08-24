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

## 2026-08-24 pagination integration

The original fix conflicted with the newer `window-v1` transcript state in `ChatPanel`. A conservative consolidation review found that directly cherry-picking it would let a prepended historical occurrence consume a newer repeated queued or optimistic turn.

The integration now:

- admits every bounded window through the reducer before changing seen IDs, queues, submitted-message correlation, or optimistic rows;
- treats only genuinely unmatched `initial`, `reset`, `append`, or `tail_reconcile` user occurrences as new acceptances;
- never consumes a pending or queued turn from a `prepend` page;
- activates exact session/selection correlation synchronously when `window-v1` is negotiated, before the first window arrives;
- ignores ID-less live user echoes in window mode and waits for a stable durable tail occurrence;
- keeps selection-scoped durable user IDs and synchronizes transcript/owner refs with reducer updates;
- preserves a separate active streaming snapshot before inserting an accepted queued user turn, while avoiding duplication when the live prefix replaces an existing durable tail.

Added browser regressions cover pre-window unscoped replay, a reducer-rejected stale append, prepended repeated content, queued and optimistic repeated turns, durable tail acceptance, and assistant-before-user ordering.

Final validation on the isolated consolidation branch:

- frontend lint: 0 errors, one pre-existing Fast Refresh warning;
- frontend production build: pass;
- focused transcript/queue/pagination matrix: 31/31 pass;
- full Playwright suite: 113/113 pass;
- independent final concurrency review: GO, no actionable findings;
- release backend suite: 1017 passed, 6 skipped, 0 failed;
- `make check` still reaches the unchanged synthetic browser-credential helper baseline failure at 62/63 script tests.
