# TTS investigation — 2026-09-06

Planning-only investigation on explicit Wayang base `6b2f749f9ecac24db8f68a825458405ca1cdd912`, isolated branch `plan/tts-response-playback-20260906`.

## Findings and validation

- `make doctor`: 0 failures, 0 warnings. Configuration/auth metadata only; no secret values read.
- Read existing TTS source, extractor tests, browser regression, contributor/security docs, historical TTS plans, matching development skills and relevant Memoriki references.
- Source-level repeat cause: autoplay effect includes buffering state, replaying the ended selected source after `onEnded` transitions to buffering. Live audible reproduction not attempted.
- Ran a synthetic `node --input-type=module` probe importing current `backend/src/tts-text.ts`. Confirmed blank table cells shift later values under incorrect headings, and tilde/unclosed fenced code remains speakable.
- Existing browser test stubs `play()` without asserting its calls, so it misses repeats despite covering delayed next-segment selection.
- Read-only inspection of shared broker source confirms ordered generation and per-segment publication before the next synthesis. Also identified a second speech normalization pass that needs compatibility testing.
- No product code changes, dependency installs, provider requests, existing job/transcript inspection, canonical build, deployment, or service restart.

## Handoff

Plan: `docs/plans/2026-09-06-tts-response-playback.md` in this worktree.

Owner questionnaire submitted 2026-09-06: include all visible assistant prose and read every table row as labeled prose. Plan updated; no final-only classifier or semantic model rewrite needed. Implementation approval remains pending. Next: obtain approval, add baseline-failing regressions, then implement and validate isolated source changes. Coordinate any later deployment with audit rollout.
