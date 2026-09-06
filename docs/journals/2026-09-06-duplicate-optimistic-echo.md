# Duplicate optimistic user echo follow-up

## Scope

Owner supplied a screenshot showing one resendable user row, assistant activity, and a second identical user row without Resend. That is consistent with a durable row plus a temporary echo, but the screenshot alone does not establish exact live event ordering or duplicate backend delivery. No production transcript, credentials, browser state, or service configuration was inspected or modified.

Task branch `fix/duplicate-echo-bubble`, worktree `/home/clemente/src/wayang-worktrees/duplicate-echo`, explicit base `b6a0225`. Canonical checkout and peer audit worktree unchanged. `make doctor` passed with no warnings/failures before diagnosis.

## Reproduction and fix

A synthetic window-v1 browser regression reproduces:

1. Send while idle; frontend displays an optimistic row with its client ID.
2. Exact accepted ACK removes the in-flight submission record.
3. Authoritative history replaces the optimistic row with a durable user event and assistant output.
4. A delayed ID-less live echo with the same client ID recreates a temporary user bubble below the assistant, splitting its live continuation.

The existing occurrence ledger only looked at still-in-flight submissions. The focused change in `frontend/src/panels/ChatPanel.tsx` first reserves matching optimistic rows one-to-one and remembers their client IDs before history replaces them. This retains presentation evidence after ACK cleanup, without retaining attachment payloads or adding a new ledger. Existing selection guard and 512-ID bound remain. No protocol, persistence, automatic resend, or global text-deduplication change.

Final regression fixture explicitly preserves the idle optimistic row (it does not send a synthetic queued ACK for an idle send). It covers both early-ACK and no-early-ACK orderings, two deliberate identical sends, one actual outbound send per turn, and preserved live assistant continuation. With production code restored byte-for-byte to base, the early-ACK test fails with two rows; the control passes. Both pass with the fix.

## Validation

- `make check`: passed; backend 1154 pass / 8 skipped / 0 fail; frontend 9/9; scripts 65/65; builds and lint pass with existing fast-refresh/large-chunk warnings.
- Delivery + assistant timeline + window controller + pagination: 35 pass / 1 fail.
- Queue cancellation/recovery: 23/23 pass.
- Combined focused browser coverage: 58 pass / 1 existing failure.
- Existing failure: `transcript-pagination.spec.ts:552`, final assistant-prefix ordering assertion at line 601. Independently rerun on unchanged canonical `b6a0225`, same failure. Not weakened or counted as green.
- `git diff --check`: clean.

Tests used the repository's synthetic HOME/Pi/data/environment harness, isolated ports 20787/17173, and no provider. Worktree dependency directories are symlinks to the existing canonical package dependencies; no installation or dependency mutation was needed.

## Release boundary

Owner approved deployment after review. On 2026-09-06 at approximately 01:36 UTC, fast-forwarded clean canonical main from `b6a0225` to source commit `35af5c5` and deployed the frontend on The-Sceptre. Prepublication rebuild reproduced the same hashed asset filenames; all nine delivery regressions passed again. Published new JS/PDF chunks additively after byte comparisons, verified unchanged shared CSS/worker/icon, and atomically swapped index.html. Old hashed assets remain for open tabs and rollback.

HTTP byte comparisons passed for the served index, main JS, PDF chunk, CSS, and PDF worker. Health returned OK; system `wayang.service` remained active with unchanged PID 439605 and start time (2026-09-04 14:04:05 PDT). No backend restart, remote push, Tribe-Mac deployment, or production transcript/configuration mutation.

Served main asset: `assets/index-Dmj8x7r2.js`; SHA256 `1a7af69fe45635e524bef9e412cde5e56fa34bec4d7564ca8b99ec8c74127ee1`. Index SHA256 `3d152db6a51e4158b3748fd59383cfa5248093d6d2e8206742e2cc4117cc705a`. Rollback entry page: `/tmp/wayang-frontend-before-35af5c5/index.html`; restore using a staged same-directory rename into canonical frontend/dist if needed. This is temporary host storage; old assets are retained in frontend/dist/assets.

Browser tabs must reload to load the new bundle. The screenshot's exact live cause remains unverified, and the owner has not yet reported whether reload removes the original duplicate.
