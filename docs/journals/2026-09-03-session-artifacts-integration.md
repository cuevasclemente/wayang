# 2026-09-03 Session Artifacts integration

## Summary

Reconciled the accepted Session Artifacts implementation with authoritative `origin/main` commit `8c11dfb` in the isolated `session-artifacts-integration-20260903` worktree on branch `feat/session-artifacts-integration-20260903`.

The canonical plan commit and implementation commit applied without textual conflicts. The integration preserves later mainline changes for global image bounds, runtime shutdown, command-guard approval delivery, semantic large-transcript projections, workspace-default profile control, and vendored Pi documentation. The separate unpublished browser-workbench declutter branch/local-main commits were not overwritten or folded into this feature.

This integration replaces the Files browser/editor with the read-only, session-scoped Artifacts pane, durable reference registry, exact backend-owned `present_artifact` tool, completed-upload registration, safe preview/download routes, trusted chat cards, and desktop/mobile focus behavior described in `docs/plans/session-artifacts.md`.

## Validation

- Fresh-worktree `make doctor`: 0 failures; expected warnings for absent dependencies, local `.env`, and build output before setup.
- `make install`: completed from committed lockfiles.
- Focused backend artifact/upload/runtime suite: **13/13 passed**.
- Frontend unit suite: **9/9 passed**.
- Frontend production dependency audit: **0 vulnerabilities**.
- Focused artifact Playwright suite: **2/2 passed**.
- Clean-default release gate with deployment-only environment flags explicitly set to repository defaults: `make check` passed.
  - backend: **1,150 passed, 8 skipped, 0 failed**;
  - frontend: **9/9 passed**;
  - scripts: **64/64 passed**;
  - frontend/backend production builds passed;
  - lint: 0 errors and the pre-existing `SessionResultSnippet.tsx` Fast Refresh warning;
  - Vite retained the existing large-main-chunk warning, while PDF.js remained lazy-split.
- Full isolated Playwright run: **121/123 passed**; both Session Artifacts cases passed.
- The two remaining failures were the pre-existing interview-cancellation acknowledgement and repeated-queued-user DOM-order assertions. Both were rerun against an untouched `origin/main` `8c11dfb` worktree and reproduced identically, so they are baseline failures rather than Artifacts regressions.
- `git diff --check`: passed.

The first unqualified release-gate attempt inherited deployment-only host environment settings into the otherwise unconfigured worktree. The Standard Browser Profile startup gate correctly failed because that test composition did not include the production schema host, and background-pause expectations reflected the inherited maintenance overrides; dependent shared-store tests then cascaded. The successful gate explicitly used the documented repository defaults (`WAYANG_STANDARD_BROWSER_PROFILE_HOSTS=0`, background indexing/sync enabled), without reading or copying deployment secrets.

A backend production audit still reports the same pre-existing transitive advisories present on `origin/main`; this feature adds no backend dependency. The newly added frontend production dependencies audit cleanly.

## Promotion and activation

Source promotion uses the normal GitHub PR/CI path from `feat/session-artifacts-integration-20260903`. Production build/deployment and `wayang.service` restart remain separate from source merge. Until that restart occurs, the running service remains on its prior backend behavior even if static frontend assets are rebuilt.

Rollback remains commit-level. Source files are never copied, rewritten, or deleted by Artifacts, and an unused owner-private `artifact-index.db` should be left in place rather than deleted without an explicit cleanup decision.
