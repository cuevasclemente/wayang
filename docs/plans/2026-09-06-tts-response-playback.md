# TTS response text and sequential playback

Status: owner approved implementation, tests, and deployment. Implementation integrated in isolated worktree; validation and deployment-target coordination in progress.
Base: Wayang `6b2f749f9ecac24db8f68a825458405ca1cdd912` (explicit local main snapshot).
Worktree: `/home/clemente/src/wayang-worktrees/tts-response-playback-20260906`.
Branch: `plan/tts-response-playback-20260906`.

## Goal and success criteria

Read only actual assistant response prose, convert Markdown into faithful speakable text, and play generated segments once in order. Start the first segment as soon as available; generate subsequent segments while playback runs. If the next segment is not available, wait silently; when it arrives, resume there, never restart the previous segment. Completion must not automatically replay the concatenated recording.

## Confirmed scope and authorization

Owner questionnaire submitted 2026-09-06:
1. Include **all visible assistant prose**, including progress/commentary, in display-group order. No final-only classifier or channel-projection change is needed. Continue excluding thinking, tools/results, and code blocks.
2. Read **every table row as labeled prose**, preserving column/value associations, including large/wide tables. Remove the current row/column omission policy. Use deterministic normalization, not a model summary.
3. Owner subsequently approved implementation and deployment. Target questionnaire remains open (recommended The-Sceptre only); coordinate restart with audit rollout. No remote push or unrelated Pi/audit activation is implied.

Manual Read aloud remains the trigger, scoped to a completed response bubble, not automatic whole-session narration. No new provider or voice selection.

## Evidence

- `make doctor`: 0 failures, 0 warnings; no secret contents inspected.
- `frontend/src/panels/ChatPanel.tsx`: autoplay effect includes `buffering_next_chunk` and depends on stage. `onEnded` leaves the ended source selected and changes stage to buffering, causing another `play()` on the ended source. This is the source-level explanation for reported repetition; no live audible reproduction yet.
- Current next selection chooses any greater completed index, rather than requiring the next ordered segment. Missing earlier segments could be skipped if event delivery ever presents a gap.
- Generation events can overwrite playback stage; generation completion, buffering, paused playback, and replay need distinct treatment.
- `e2e/tests/workspace-settings-agent-switching.spec.ts` already tests delayed chunk arrival and batched final events, but stubs `play()` without counting invocations. It checks source selection, not unwanted playback restarts.
- `backend/src/tts-text.ts` selects assistant text blocks and groups consecutive assistant/tool entries to match display bubbles. Consequently, visible commentary is currently included. User/tool/thinking block text is filtered.
- Synthetic direct execution of the existing extractor reproduced blank-cell displacement: `Name | Empty | Value` with `Example | | Correct` becomes `Name: Example; Empty: Correct`.
- Synthetic direct execution reproduced code leakage for `~~~` fences and unclosed backtick fences.
- Tables over 6 rows or 4 columns are currently announced and omitted. Splitting rows drops empty cells; escaped pipes are not handled.
- Code stripping happens after table conversion and only recognizes paired triple backticks. Regex Markdown stripping has other fidelity risks; use parser-based traversal if existing dependencies support it cleanly, or bounded structure-aware normalization with focused fixtures. Avoid introducing a large framework.
- `backend/src/routes/tts.ts` applies text cleanup before broker submission, with a versioned text hash in the idempotency key. Direct fallback waits for all generated audio and caps at 20 chunks.
- Read-only broker source inspection: `server-lattice/apps/tts-broker/src/tts_broker/jobs.py` synthesizes each segment in sequence and emits `chunk_completed` immediately after publishing it. Its adaptive split changes only the uncompleted suffix; completed prefix indices remain stable.
- Broker `speech_text.py` also normalizes incoming text. It repeats the same table/code regex approach, so test that Wayang-prepared prose survives this second pass. Do not silently expand changes into report-publisher or shared broker behavior.
- Historical design: Wayang `docs/plans/chatterbox-tts-feature.md`; shared design is in **server-lattice**, `docs/plans/shared-streaming-tts-architecture.md`, not the Wayang docs tree.

## Proposed implementation

### M1 — Regressions before fixes

- Strengthen browser fixture with a source-specific play-call ledger and simulated ended/paused media state.
- Prove current baseline repeats segment 1 when entering buffering; assert no extra play across repeated progress updates while waiting.
- Cover immediate first playback, next-ready advance, delayed next arrival, duplicate events/manifests, missing-index gaps, completion batched with final segment, final completion without replay, rejected autoplay, deliberate pause/resume, retry and unmount/session-switch cleanup.
- Add extractor fixtures for allowed message/block types, response scope once decided, code-only/empty/error/aborted responses, table blank cells/empty headings/escaped pipes, row limits, links/headings/lists, tilde/backtick/unclosed fences and tables inside code.

### M2 — Speech preparation

- Enforce selected response policy at backend selection, not merely by hiding the button. Keep server-owned history and stable target IDs; never accept arbitrary client-submitted transcript text.
- Strip non-response structures before speech conversion. Preserve factual values and meaningful inline labels; do not turn missing table values into shifted labels or inferred facts.
- Normalize the approved table scope into row-wise prose with column labels and punctuation suitable for sentence chunking.
- Version the changed pipeline to prevent stale cached text/audio reuse.
- Hide/disable Read aloud on incomplete or nonspeakable output consistently. Preserve existing quarantine and route access checks.

### M3 — Playback repair

- Separate generation progress from playback state in a small testable controller/reducer or focused hook; keep chat rendering outside it.
- Track active source, completed segment cursor, ordered availability, generation terminal state, and user playback intent.
- Only auto-start a newly selected source. Never call play on an ended source when entering buffering or receiving progress.
- Advance exactly to the next segment. Wait when absent; receiving future segments must not skip or interrupt current audio.
- Honor manual pause and browser autoplay rejection; controls remain available. Ensure delayed promise/SSE callbacks cannot change a newer request or unmounted response.
- Retain final audio for explicit full replay/seeking, never automatic replay after streamed completion.
- Remove artificial 150ms request delay if it has no functional requirement.
- Keep the broker's sequential generation and default budget; no speculative concurrency/tuning change. Direct mode remains compatibility whole-file playback unless a separately approved requirement extends streaming to it.

### M4 — Validation and integration handoff

- Focused backend extractor/route tests and frontend controller tests.
- Isolated synthetic Playwright tests using real browser media behavior where practical and a counted play fixture for deterministic timing; no real session transcripts or provider credentials.
- `make check`; focused existing chat/workspace E2E. Baseline-reproduce unrelated failures, do not weaken tests.
- Verify broker normalization compatibility with synthetic prose; if it changes meaning, report a concrete cross-repository dependency before modifying the broker.
- Optional authorized live synthetic smoke after builds: first segment before full job completion, silent wait, exactly-once ordered playback, pause/resume, explicit replay and Range serving. Never use existing real job text/audio for debugging.
- Journal exact validation, commits, and source-versus-live status. Owner authorized deployment; exact target and safe restart coordination remain required. Do not activate unrelated pending Pi/audit changes.

## Team ownership

If fresh-context delegation is available after approval:
- Backend/extraction specialist: `backend/src/tts-text*`, focused route integration and tests. Does not modify playback.
- Playback specialist: small frontend TTS module and its tests, bounded ChatPanel integration. Does not change session grouping or backend contracts.
- Lead/integration reviewer: shared contract, browser regressions, docs, builds, review and merge preparation.

Each writer uses a separate worktree from the approved base; children provide concise future-value wiki handoffs. Current runtime supports team tools. Backend and playback writers supplied bounded changes in separate worktrees; deployment preflight and independent review were read-only. Children had file-only tools, so the lead executed all baseline reproductions, tests, builds, integration, and commits.

## Risks, rollback, and deferrals

- Preserve all visible assistant prose across grouped fragments and legacy histories without guessing prose intent. Completion/nonspeakable checks must not accidentally exclude progress text from a completed group.
- Shared broker double-normalization may undermine precise formatting. Keep compatibility evidence separate from assuming the source is deployed.
- Browser automatic playback is policy-dependent; guarantee correct queueing, not bypass of gesture restrictions.
- No schema migration required for the recommended fix. Roll back reviewed source commits/build assets; no deletion of caches or transcripts required. Preserve prior assets on any later deployment.
- Deferred: LLM summaries, new TTS provider, voice UI, automatic narration, whole-session playback, GPU tuning, report-publisher changes, generalized broker API rewrite, direct-provider streaming retrofit, and a broad chat refactor.
