# Concurrent Browser Profile workspaces — implementation handoff (2026-08-13)

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
