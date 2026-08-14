# Concurrent Browser Profile workspaces — implementation handoff (2026-08-13)

## Final four-surface completion and integration gate (2026-08-14)

Clemente authorized completing the four previously deferred product surfaces before final integration. The branch now includes:

- exact synchronous Standard download frame→root-page attribution with browser-epoch, target, workspace, control, and runtime generation fencing;
- exact named-profile credential brokering and UI, including guarded HTTPS document fill, redacted inspection, exact target/body cross-checks, and safe resume;
- metadata-only atomic recovery/restore for compiled managed and migrated storage roots, bounded retry, and PIN-gated permanent purge from verified recovery only;
- profile-wide cooperative Full browser VNC with one explicit controller, one-use takeover, per-batch exact input/output authorization, bounded TCP/WebSocket buffering, server-first RFB greeting preservation, lifecycle/idle fencing, and persistent disclosure that pixels are profile-wide rather than workspace-isolated.

Final functional commits are `1013519`, `c29290a`, `890cb2a`, `3a04afb`, and `adcd26d`. Independent blocker/high review of the completed range returned **GO** after closing output-authorization, buffer-bound, transport-policy, stale-workspace, takeover, credential-body, switch-rollback, and old-WebSocket findings.

The final rebase check reports the branch already up to date with canonical `main` `de97396`. Validation in the isolated worktree:

- backend: **836 passed, 0 failed, 5 skipped**;
- all Playwright E2E: **76 passed, 0 failed**;
- frontend production build: passed;
- frontend lint: 0 errors and the one pre-existing Fast Refresh warning in `SessionResultSnippet.tsx`;
- script suite: unchanged fake-Bitwarden baseline **44/45**, with only `Bitwarden unlock failed`;
- `make doctor`: 0 failures and 3 expected isolated-worktree configuration warnings.

A synthetic managed-Chromium smoke test verified clean startup/fallback/shutdown. This host's Xvfb currently aborts in the NVIDIA EGL/GBM stack, so `auto` correctly falls back to CDP; explicit `vnc` remains fail-closed. This is a host dependency/runtime issue, not activation, and no live Browser Profile was opened.

Source completion does **not** authorize migration, profile access, feature activation, restart, deployment, or publication. Those remain separate gates. No browser-profile contents, cookies, credentials, transcripts, or live production data were inspected.

## Terminal pre-rebase gate

Browser-only blockers independent of Terra were closed through clean branch head `cbdf13f` (`72e8058` latest functional change). Repeated independent blocker/high reviews now return **GO**. Final remediations cover authenticated named-workspace routing, exact human/agent control barriers, retained per-profile workspaces, recoverable managed-profile cleanup, redacted bounded projections, profile-switch operation fencing, disabled-profile catalog-only recovery, fail-closed production download attribution, and immediate closure of forbidden top-level documents.

Validation: backend **819 passed, 0 failed, 5 skipped**; frontend build passed; frontend lint 0 errors/1 pre-existing warning; scripts unchanged fake-Bitwarden baseline **44/45**; `make doctor` 0 failures/3 expected local warnings.

The branch remains based on provisional Terra `601725f`. Rebase onto the final canonical Terra Wayang head and rerun the gate before integration. Production activation, VNC/credential brokering, migrated-profile cleanup, and named-profile downloads remain deliberately unavailable/fail-closed. No migration, profile access, restart, activation, or deployment occurred.

## Status

Source implementation is complete on isolated branch `feat/concurrent-browser-profile-workspaces`, worktree `/home/clemente/src/wayang/.worktrees/browser-profile-tab-implementation`, current head `27921ae`.

This branch is intentionally **not merge/deploy ready** because it is provisionally based on Terra Wayang head `601725f` (schema 5), which is not yet canonical. Browser advances that contract to schema 6. Rebase/reconcile after Terra's independent gate and canonical merge.

No migration, browser-profile access, activation, restart, global extension sync, or deployment occurred.

## Implemented

- Startup-immutable, default-off `WAYANG_STANDARD_BROWSER_PROFILE_HOSTS` composition gate.
- Strict schema-6 Browser Profile catalog:
  - `browserProfiles`
  - `projectBrowserDefaults`
  - `sessionBrowserStates`
  - `browserCleanups`
- Backup-first schema 5→6 migration preserving Terra `title_source` and every pre-existing schema-5 row/array.
- Metadata-only expected-root inventory. It uses path metadata checks only; it does not open/read/copy/move profile contents.
- Canonical storage identity/opener registry and symlink/ownership checks.
- One Standard Chromium host per named profile, with per-session process-local workspaces and exact target ownership.
- Opaque session tab handles and list/open/select/close tools/UI.
- Popup attribution from exact `openerId`; unknown/restored targets never inherit ownership by URL/title/visibility/order.
- Runtime generation fencing, distinct detach/close/revoke semantics, workspace and host idle expiry.
- Exact backend-owned profile listing/switching/current-Project-default tools.
- Authenticated owner routes and CDP viewer resolution for detached workspaces without constructing Pi/runtime authority.
- Standard download capture freezes exact session/workspace/target/runtime ownership and publishes only after reauthorization; detach/close cancels pending downloads.
- Profile management APIs and Settings UI with explicit shared-authenticated-state consequence confirmation.
- Session-owned tab strip in the Browser panel.
- Protected browser regression seams retained and tested.

## Validation

- `make doctor`: 0 failures; expected local warnings for absent `.env` and capability PIN/cooldown metadata.
- Backend aggregate: 808 pass, 0 fail, 5 skip.
- Backend TypeScript build: pass.
- Frontend production build: pass.
- Frontend lint: 0 errors, 1 pre-existing Fast Refresh warning in `SessionResultSnippet.tsx`.
- Script suite: 44 pass, 1 unchanged synthetic fake-Bitwarden failure (`Bitwarden unlock failed`), matching the prior branch baseline; no script files changed.
- Focused owner/startup/download tests added and passing after aggregate run.
- Root checkout remains clean on `main`; browser worktree is clean.

## Required before merge/deploy

1. Terra canonical title work must pass its own gate and merge; rebase Browser onto that canonical head and reconcile schema-6 migration/test fixtures.
2. Independent blocker/high security, correctness, and product/accessibility review of the full Browser range.
3. Close any gate findings; rerun aggregate backend, builds, lint, focused concurrency/download/viewer/Protected matrices, and E2E.
4. Complete remaining plan deltas or explicitly defer them before claiming full reviewed scope, especially profile-wide VNC/controller arbitration, owner adoption of unassigned chrome-created tabs, complete cleanup/purge retry worker, and exhaustive credential-state behavior for shared Standard profiles.
5. Stage a current private store backup and matching backend/frontend build.
6. Separately authorize schema migration, feature-flag activation, restart, and deployment.

## Commit sequence added after the provisional Terra base

- `031659e` schema-6 catalog
- `3d496f9` Standard host ownership/download lifecycle
- `483b091` production/owner route integration
- `4a7596f` profile Settings and session tabs
- `bdf0d69` exact download ownership test
- `be63ecc` legacy schema/reference fixture alignment
- `6803aeb` activation-boundary documentation
- `625c5d6` lazy startup composition tests
- `d24ff36` detached owner selection tests
- `27921ae` no legacy fallback for unconfigured Standard sessions
