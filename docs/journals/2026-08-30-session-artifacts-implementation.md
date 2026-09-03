# 2026-08-30 Session Artifacts implementation

## Summary

Implemented the accepted `docs/plans/session-artifacts.md` design on branch `feat/session-artifacts-20260830`, based on Wayang `main` commit `66a359f` and carrying the canonical plan forward as `e502e99`.

The right-panel **Files** browser/editor is replaced by a read-only, session-scoped **Artifacts** surface. No production deployment, merge, or service restart was performed.

## Delivered behavior

- Added an owner-private bounded SQLite artifact reference registry at `$WAYANG_DATA_DIR/artifact-index.db` with strict startup schema/file checks, per-session revisions, deduplication, precedence, pruning, restart persistence, orphan cleanup, and session-deletion cleanup.
- Added the immutable backend-owned `present_artifact` tool for exact live interactive runtimes. It is withheld from scheduled sessions, requires its exact registered tool object, rechecks current Project/Profile/session/path authority, and returns only opaque artifact IDs and bounded display metadata.
- Completed chat uploads register only after private persistence succeeds. Their durable transcript annotation carries the opaque artifact ID, producing an **Open** chip without showing the private storage path in visible chat.
- Added authenticated opaque-ID list, preview, and forced-download routes. Browser callers cannot submit host paths.
- Preview/download paths reauthorize current session policy and canonical location, reject symlinks/hard links/non-regular files and explicit secret/control-plane paths, open no-follow, compare file identity, and reauthorize between streamed chunks.
- Added backend classification and bounds for Markdown/text/code, PNG/JPEG/static WebP, PDF, and HTML source. GIF/animated WebP, SVG, malformed/oversized, and unsupported content remain download-only.
- Added safe frontend renderers:
  - React Markdown/GFM with raw HTML disabled, remote images blocked, and explicit safe external links only;
  - escaped read-only code/text;
  - backend-validated raster images;
  - lazy local PDF.js canvas rendering without native embeds, XFA, annotation/action layers, or document-originated asset configuration;
  - exact-allowlist DOMPurify sanitization inside a unique-origin `sandbox=""` `srcDoc` iframe with `default-src 'none'`.
- Added catalog WebSocket events, explicit agent-share focus, passive upload refresh/unread behavior, trusted tool-result cards, upload chips, desktop collapsed-panel expansion, and mobile user-click navigation to Tools.
- Retired `/api/fs/tree`, `/api/fs/read`, and `/api/fs/write`; retained only project discovery. Removed FileTree/FileViewer and Monaco/react-arborist editing dependencies.
- Added shared REST/WS protocol shapes, documentation, security guidance, dependency locks, and rollback notes.

## Security findings resolved during implementation

- The first HTML renderer configuration combined DOMPurify `USE_PROFILES` with an exact tag allowlist; browser regression showed this still admitted an `<input>`. The profile was removed, ARIA/data attributes were fail-closed, and the exact allowlist now passes hostile-HTML E2E coverage.
- Synthetic API tests often return `{}` for unknown routes. The first Artifacts hook trusted that shape and could crash the right panel, causing unrelated E2E timeouts. The hook now validates exact session/revision/array shape and fails as a bounded panel error.
- Post-commit catalog listeners are isolated so a UI/WebSocket listener exception cannot roll back the durable registry or make attachment persistence delete source bytes after artifact commit.
- A timed-out Playwright run left one synthetic backend process on test port 18787. Clemente explicitly approved stopping it; the identified process tree was terminated and no task-worktree E2E backend remains.

## Validation

- `make doctor`: 0 failures; expected new-worktree warnings before install/build.
- Focused backend artifact/runtime integration: **10/10 passed**; attachment-inclusive focused run: **12/12 passed**.
- Clean-environment full backend suite: **1,135 passed, 8 skipped, 0 failed**.
- Frontend unit tests: **6/6 passed**.
- Frontend production build: passed. PDF.js is lazy split; Vite retains its existing large-main-chunk warning and reports the separate PDF/worker assets.
- Frontend lint: 0 errors; one pre-existing Fast Refresh warning in `SessionResultSnippet.tsx`.
- Frontend production dependency audit: **0 vulnerabilities**.
- New Playwright artifact tests: **2/2 passed** (desktop migration/Markdown/hostile HTML; mobile Tools).
- Browser regression excluding one known baseline interview test: **119 passed / 120**, with the sole pagination failure reproducing unchanged on current `main`.
- The excluded interview-cancellation test reproduces unchanged on current `main` and on this branch.
- `make check`: passed end-to-end (backend, frontend, scripts, lint, builds).
- `git diff --check`: passed.

## Rollout and rollback

Implementation remains isolated in the `session-artifacts-implementation` task worktree. Promotion should use normal review/merge/build/deploy procedures and requires a separate production restart decision.

Rollback is commit-level: restore the Files UI/routes separately from the artifact core if needed. The artifact registry contains metadata references only; leaving an unused owner-private database is safer than deleting it. Source files are never copied, rewritten, or deleted by the feature.
