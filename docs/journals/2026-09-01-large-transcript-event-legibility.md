# Large transcript event legibility

**Date:** 2026-09-01

**Status:** integrated on canonical `main` and production-built; service restart not approved, so the fix is not active

**Branch:** `fix/large-event-session-legibility-20260901`

**Base:** `c7ae0950d395c25035e3a82e57b023654df05c14`

**Plan:** `docs/plans/2026-09-01-large-transcript-event-legibility.md`

## Incident

Session `464a9f2a-c0d7-4f48-b0bd-c29ec69b2946` opened in the web UI as one generic `wayang-transcript-event-placeholder-v1` card saying that the event was too large for a bounded window. The bounded cross-session `session_read` path independently failed because its first selected physical line exceeded the 48-KiB return ceiling. The exact canonical target line was not bypass-read or copied. Code-path analysis showed that transcript pagination discarded the complete serialized row whenever embedded content exceeded its byte budget; a synthetic image-bearing user event reproduced the same loss of role and prompt text.

## Root cause

The pagination limits were working as intended, but the fallback operated at the wrong semantic level:

1. `boundedSerialization()` measured the complete serialized event, including embedded image base64.
2. Any event beyond the indexed/message budget became a generic custom placeholder.
3. Indexed rows over the aggregate source-read budget and physical rows beyond the reverse-scan ceiling used the same generic replacement.
4. `session_read` threw if a selected JSONL line itself exceeded the result ceiling.

This kept transport work bounded but made a one-event session unintelligible.

## Implementation

- Added `backend/src/transcript-pagination/oversized-projection.ts`.
  - Parsed events retain role/type, stable IDs, parent IDs, timestamps, readable bounded head/tail text, tool/custom metadata, and mutation status.
  - Image/base64 blocks and oversized nested content become explicit omission notes.
  - Every projection carries machine-readable `transcriptProjection` metadata and the original encoded size.
  - Projection output has its own 64-KiB ceiling and a final role-preserving minimum fallback.
- Cold reverse pagination now uses bounded prefix/suffix semantic sampling for physical rows too large to parse normally.
- Indexed around/forward pagination reads at most 64 KiB from each end of an oversized row, counts those bytes against the existing 384-KiB aggregate source budget, and uses index topology as the authoritative envelope.
- `session_read` now returns an explicit `wayang_session_read_projection_v1` JSON line for oversized selected rows. Complete lines report canonical byte size; scan-limited lines report a lower bound and no continuation. The 48-KiB result, 200-line, and 256-KiB total scan ceilings remain unchanged.
- Added a browser regression proving that a 600,000-character synthetic image payload renders as a normal **You** message with the prompt text and an omission note, never the old generic placeholder.
- Updated pagination and security documentation.

Canonical Pi JSONL, transcript-index schema, privacy policy, authentication, and cursor protocol were not changed.

## Validation

Passed on the isolated task branch:

- focused backend pagination/session-interop suite: **42/42**;
- complete backend suite under documented test-default selectors: **1,137 passed, 0 failed, 8 skipped**;
- `make check`: green;
  - frontend tests **7/7**;
  - frontend lint 0 errors / one pre-existing Fast Refresh warning;
  - script tests **63/63**;
  - backend/frontend production builds passed;
- new focused Playwright regression: **1/1**;
- complete transcript-pagination Playwright file: **8/9**, with the one failure reproduced unchanged on canonical `main` at the pre-existing repeated-queued-user DOM-order assertion (`main` line 516; task branch line 552);
- `git diff --check`: clean.

All fixtures were synthetic. No credential, secret-bearing file, protected transcript, or raw target transcript body was read.

## Integration and activation state

Validated commit `29b7b02` was fast-forwarded onto unchanged canonical `main`, and production backend/frontend builds passed. The requested privileged `wayang.service` restart was not approved, so the existing process remains on its pre-fix in-memory code. No workaround or repeated privilege request was attempted.

After an approved controlled restart:

1. reopen the affected session and verify it renders the original event role and readable text plus an explicit omission note;
2. invoke `session_read` on the same Standard session and verify it returns `wayang_session_read_projection_v1` instead of an error;
3. confirm `/healthz`, normal bounded pagination, and older-page navigation remain healthy.

Rollback is a code revert plus rebuild/restart. No data migration or transcript rewrite is involved.
