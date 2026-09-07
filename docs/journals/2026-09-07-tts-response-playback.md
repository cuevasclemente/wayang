# TTS response narration and sequential playback — 2026-09-07

## Authorization and source

Owner chose all visible assistant prose (including progress commentary), every table row as labeled prose, then approved implementation and deployment. Target questionnaire asks The-Sceptre only versus both hosts; both include The-Sceptre, so independent Sceptre deployment can proceed. Tribe-Mac remains untouched pending that answer and coordination with its existing rollout.

Main-source fix: `7db3875`, explicit base `6b2f749`. Integration worktree `/home/clemente/src/wayang-worktrees/tts-response-playback-20260906`, branch `plan/tts-response-playback-20260906`. Separate backend and playback writers supplied bounded file changes; read-only deployment preflight and independent code review contributed. Children had file-only tools; all executable validation, integration, and commits were lead-owned.

## Changes

- Marked lexer (direct declaration of already-locked `marked@18.0.5`) replaces brittle Markdown stripping. Each independently rendered text block is parsed independently. Skip thinking/tools/code, retain commentary and final prose in display-group order.
- All table rows/columns narrated with labels; empty cells preserve alignment. Inline labels, escaped pipes, common/numeric entities and meaningful symbols become speakable, broker-safe prose. The exact shared broker normalizer was tested with synthetic text; no broker code/configuration changed.
- Text pipeline version `speech-text-v3` prevents reuse of old preparation. Oversized direct-mode requests fail explicitly at the existing 20-chunk bound instead of silently truncating. Shared broker remains the streaming/long-response path.
- Small playback controller/hook separates generation progress from playback commands. Exact next segment only; silent buffering, stable completed prefix, user pause/autoplay rejection, stale request/SSE/rejection isolation, explicit full replay, and native media cleanup.
- React StrictMode callback-ref detach/reattach exposed an initial pause regression during testing; disposal now distinguishes same-element reattachment from actual replacement/unmount. Native browser WAV coverage passes.

## Evidence

- `make doctor`: 0 failures / 0 warnings, no secret contents read.
- Unchanged baseline: strengthened browser test failed with two calls to segment 1 after entering buffering. Eight of twelve initial extractor regressions failed against unchanged source.
- Final main-source `make check`: backend 1292 pass / 10 skip / 0 fail; frontend 20/20; scripts 67/67; builds/lint pass. Eight backend skips are existing; two are explicit opt-in cross-repository broker compatibility tests.
- Focused backend tests with `TTS_BROKER_SPEECH_TEXT_SOURCE` set to the reviewed public broker source: 20/20, including both compatibility tests, route quarantine, complete server-owned group submission, and direct-mode resource-bound rejection.
- Isolated main-source Playwright: 13/13 (TTS plus workspace switching). Tests include counted play invocations, delayed/gapped/duplicate events, pause/rejection/retry/session switch, and real native playback of synthetic PCM WAV.
- Independent review approved after fixing per-block fence boundaries and explicit direct limit rejection.
- Existing fast-refresh/large-bundle warnings remain; no tests/dependencies relaxed.

## TTS-only release preparation

Canonical source includes pending audit code not yet active in the service. To avoid activating unrelated Pi/audit changes, created release worktree `/home/clemente/src/wayang-worktrees/tts-sceptre-only-20260907`, branch `release/tts-sceptre-only-20260907`, explicit deployed baseline `eaa7da5`. Its clean rebuild exactly matched the served frontend index/main JS/CSS and all 224 baseline non-test backend JavaScript files. Existing installed `marked@18.0.5` ESM bytes also matched. System service runs compiled output via the normal launcher, not a build-on-restart command.

Release commit `5a533da` contains only the TTS patch on that baseline. Cherry-pick conflicts were restricted to the old TTS block (replaced with the reviewed hook) and the audit-era browser test (kept baseline test; standalone new TTS suite provides release coverage). No other audit changes imported.

- Release `make check`: backend 1168 pass / 10 skip / 0 fail; frontend 20/20; scripts 65/65; builds/lint pass.
- Production-build isolated browser TTS suite: 9/9, including native media.
- Live documented local broker health HTTP 200. Newly created synthetic job `8e05b098dc13726ec166076eb1836519`: segment 1 ready at 16 seconds while running, segment 2/final complete at 26 seconds; final MP3 Range request HTTP 206 / 100 bytes. No existing job or real transcript inspected. Broker job retained under normal retention, not deleted.

## Activation status

Published TTS-only release `5a533da` to The-Sceptre: additive frontend assets and atomic index, plus exactly `backend/dist/tts-text.js` and `backend/dist/routes/tts.js` staged for restart. All 788 other backend files remain byte-identical. Source main fast-forwarded to `7f8da26` without canonical build/install. No Pi/myPi upgrade, service environment edit, private-state migration, remote push, or Tribe-Mac activation.

HTTP bytes verified for index, main JS, CSS, PDF chunk and worker; health HTTP 200, backend PID still 439605 before restart. Main asset `assets/index-BAoLPaRq.js`; index SHA256 `6f240cd8a91539b2af79e38e03e3e611a1f223d50976dad461a5b223865598e0`. Exact uninstrumented release assets additionally passed all 9 TTS browser tests against an isolated preview server without rebuilding. Durable rollback: `/home/clemente/src/wayang-release-backups/tts-20260907` (previous modules/index, before/published hashes). Old frontend assets retained.

Backend remains staged: the `sudo_exec` request to schedule `wayang-tts-restart-20260907` via systemd-run was **not approved**. No timer was scheduled, no restart occurred, and no alternative privilege mechanism was attempted. Loaded-backend activation/verification is blocked pending explicit authorized restart. Do not report staged code as loaded. Memoriki handoff: `synthesis/wayang-tts-current.md`.

Expected runtime allowlist: `backend/dist/tts-text.js`, `backend/dist/routes/tts.js`, new hashed frontend assets, and atomic `frontend/dist/index.html`. Preserve all other backend bytes/dependencies and old frontend assets. Keep backups of the two previous backend modules and frontend index before publication. Restart requires the normal privileged approval tool; record scheduled versus observed activation accurately. A source main merge must not run canonical build/install.
