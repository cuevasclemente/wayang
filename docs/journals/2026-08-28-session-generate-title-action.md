# Explicit Generate title action — 2026-08-28

## Decision

Clemente chose a session-row **Generate title** action beside Archive/Delete using the reviewed Terra title provider. Requests may be queued while a session is busy, survive browser navigation/disconnect, but are intentionally lost on a Wayang restart. Any current title may be replaced after confirmation. The row shows an inline spinner and concise success/error feedback.

## Implementation

- Added an explicit first-one-to-three completed-exchange title service using the existing bounded title policy and `openai-codex/gpt-5.6-terra` provider.
- Preserved the configured Standard/Protected title-disclosure flags as deterministic scope authorization in addition to the UI confirmation.
- Added a process-local, one-job-per-session queue with queued/running/terminal projections, bounded polling and terminal retention, restart-reset behavior, and cancellation on manual rename/archive/delete.
- Captures the confirmed Wayang title/source and physical Pi name revision, then revalidates title, path/header, active-branch projection, configured policy, session idle state, and exact Pi CAS before disclosure and commit.
- A concurrent Wayang or external Pi rename wins. Provider output is normalized before canonical `session_info` append and Wayang mirror update.
- Added authenticated POST/GET title-generation routes and included bounded job status in session-list projections so progress survives navigation.
- Added a Sparkles row action with Terra/first-three-turn confirmation, queued/running spinner, polling, title refresh, and dismissible success/error notice.
- Updated `docs/configuration.md` and added a Playwright UI-contract regression.

## Validation

- Focused backend title queue: 9/9 passed.
- Existing session runtime projection: 4/4 passed.
- Frontend tests: 4/4 passed.
- Focused Playwright Generate title flow: 1/1 passed.
- Post-merge backend aggregate under synthetic-compatible operational flags: 1106 passed, 0 failed, 6 skipped.
- Backend and frontend TypeScript/production builds passed.
- Frontend lint: 0 errors, one pre-existing Fast Refresh warning.

## Live recovered-turn regression

The first live attempt on session `80b41740-1768-459d-93de-6de01e77e7e9` failed with `title_input_unavailable` despite a substantial transcript. Structural inspection found transient Together assistant `error` entries inside turns that later recovered to terminal `stop` responses. The extractor discarded the user witness at each transient error, and the explicit service additionally required the earliest eligible exchange to be the first physical user message.

The repair keeps an authenticated user witness across assistant error/abort entries until the same turn recovers or a later user supersedes it, excludes provider-error payloads from title prose, and lets irrecoverably failed early turns yield to the earliest completed exchange. Browser provenance, bounded disclosure, active-branch revalidation, and title CAS remain unchanged.

Regression validation: focused policy/manual generation tests 17/17; the affected physical transcript now projects three eligible completed exchanges; backend build passed. The aggregate backend run reached 1108 passed, 1 failed, 6 skipped; the sole exact-tool-set failure was reproduced unchanged on base `main` and was caused by the live memory-review tool injection, outside this title patch.

## Operational note

The queue has no persistent schema and is lost on service restart by design. Deployment of the recovered-turn repair requires integration, production build, restart, and a confirmed retry on the affected session.
