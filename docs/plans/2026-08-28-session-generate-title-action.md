# Explicit session “Generate title” action

**Date:** 2026-08-28
**Status:** implementation authorized; execution plan
**Base:** Wayang `2720ea2`

## Goal and resolved product behavior

Add a **Generate title** row action beside Stop/Archive/Delete in the Wayang session list.

Resolved choices:

- Use the existing reviewed `openai-codex/gpt-5.6-terra` title provider, not the session’s conversational model.
- Generate from bounded prose in the first one to three completed active-branch exchanges; prefer exact Wayang browser-source markers and admit only the existing safe legacy fallback.
- The explicit click is the disclosure authorization. Confirmation must identify Terra, first-three-turn prose disclosure, and replacement of the current title when present.
- Permit replacing any current title after confirmation, including human/agent-authored or prior automatic titles.
- Accept the action while the session is streaming, compacting, queued, or mutation-locked. Keep one backend-owned process-local request per session and run it once the session is idle.
- The queue survives browser navigation/disconnect but intentionally does not survive a Wayang process restart.
- Show an inline spinner/disabled row action while queued or running. Refresh the title on success and show concise success/error feedback.
- A title changed after confirmation wins. Generation must fail with a conflict rather than overwrite newer intent.

## Security and privacy invariants

- Existing built-in authentication/origin middleware protects every new route; no new WebSocket transport is required.
- The request never uses tools, reasoning, images, attachments, paths, project files, source-session IDs, or later-turn prose.
- Explicit generation does not depend on automatic-title environment flags. The authenticated confirmation is the scope-specific authorization, including Protected Projects.
- Capture the exact physical Pi `SessionNameState` and Wayang title/catalog revision at enqueue. Revalidate both before disclosure and commit.
- Read the active branch only after the session becomes idle. Require one completed safe exchange and cap input through the existing title policy.
- Use `appendSessionInfoIfCurrent(..., { origin: "automatic" })`; a concurrent title/clear wins the Pi CAS.
- Mirror successful canonical Pi state into Wayang only after the physical write. Pi remains canonical if the mirror fails.
- Archive/delete/session disappearance cancels queued work. Runtime restart loses process-local jobs by design.
- One request per session: repeated clicks return the existing job and never dispatch a second provider call.

## Architecture

### 1. Explicit title-generation service

Add a dedicated explicit action around the existing title policy/provider rather than weakening automatic-title eligibility.

Responsibilities:

- open/revalidate the canonical Pi file and active branch;
- capture an enqueue witness: session ID/CWD/path, Wayang catalog mutation version/title, and exact Pi name revision;
- build the bounded first-one-to-three completed exchange projection with safe legacy fallback enabled;
- prepare Terra, synchronously revalidate policy/path/revision immediately before dispatch, normalize output, then revalidate and Pi-CAS commit;
- intentionally allow replacement of the confirmed title but reject any post-confirmation change;
- return typed outcomes: completed, queued/running, unavailable input, conflict, cancelled, provider failure.

### 2. Process-local queue manager

Add a small backend module with a `Map<sessionId, Job>` and no store schema change.

Job states: `queued | running | completed | failed | conflict | cancelled`.

- `POST` creates or returns the existing nonterminal job.
- If idle, start asynchronously; otherwise poll/re-kick on a bounded timer until idle.
- Busy means streaming, compacting, pending messages/compaction queue, runtime starting, mutation lock, or open human-input/messaging gates where title mutation is unsafe.
- Terminal jobs remain queryable for a short bounded TTL so a reconnecting frontend can display the outcome, then evict.
- `unref()` timers; reset/close seams for tests; no restart recovery.
- Route and existing archive/delete paths cancel matching jobs.

### 3. HTTP contract

- `POST /api/sessions/:id/title-generation`
  - body contains the currently displayed title/catalog revision used only for stale-client confirmation binding;
  - returns `202` with bounded job projection for queued/running; may return completed if already terminal;
  - rejects missing transcript/turns, stale confirmation, or ineligible session with typed codes.
- `GET /api/sessions/:id/title-generation`
  - returns current bounded job state or `idle`.
- Optional `DELETE` is deferred unless implementation reveals a clear UX need; archive/delete cancellation is automatic.

No transcript prose, provider output beyond the validated final title, Pi paths, or internal errors are returned.

### 4. Frontend

- Add a Sparkles/Wand-style icon button in `SessionRow` immediately before Archive.
- Clicking stops row selection, confirms disclosure/replacement, calls POST, and marks the row queued/running.
- Poll only nonterminal jobs with bounded backoff; on success refresh sessions and show a concise success notice; on failure show a row-scoped or panel toast/error.
- Disable repeated action while nonterminal. Preserve accessibility labels, title text, focus visibility, and mobile tap target behavior.
- Existing manual double-click rename remains unchanged.

## Milestones

1. **Backend service and queue**
   - explicit extraction/CAS service;
   - process-local idempotent queue;
   - typed status projections and cancellation hooks.
2. **Routes and client contract**
   - authenticated REST endpoints;
   - request validation and stale-confirmation binding;
   - API client types/functions.
3. **Frontend action**
   - row button, confirmation, spinner, polling, refresh, feedback.
4. **Integration and adversarial validation**
   - busy-to-idle, concurrent rename, delete/archive, provider failure, restart reset;
   - route/auth and browser UX regressions;
   - full backend/frontend/build gates and independent privacy/concurrency review.

## Focused tests

- first one/three active-branch exchanges only; tools/reasoning/attachments/later turns excluded;
- no completed exchange => typed failure without provider call;
- queued while streaming/compacting/mutation-locked; one dispatch after idle;
- repeated POST is idempotent;
- queue survives client disconnect but reset seam models service restart loss;
- manual rename/clear after enqueue defeats disclosure and commit;
- human title replacement succeeds only against the exact confirmed revision;
- physical path/header/name-state changes fail closed;
- Protected explicit action works only through authenticated owner route and does not depend on auto-title flags;
- archive/delete cancels; missing session fails terminally;
- frontend button confirmation, spinner, disabled duplicate click, title refresh, and error feedback.

## Rollback

Remove the row action, two REST endpoints, and process-local queue module. No schema migration or persistent queue data requires rollback. Titles already generated remain ordinary canonical Pi `session_info` entries and are not reverted automatically.

## Parallel roles and ownership

- **Backend title/queue role:** title service, queue state machine, routes, backend tests.
- **Frontend UX role:** API client, SessionRow action/feedback, focused frontend/E2E tests.
- **Lead integration role:** contract ownership, branch reconciliation, full gates, journal, deployment.
- **Independent reviewer:** privacy/disclosure, race/CAS, queue lifecycle, accessibility/error UX.

Coordination point: backend lands the exact REST/status schema before frontend integration; frontend may initially work against the documented contract with mocked responses. Each writer uses a separate worktree/branch.
