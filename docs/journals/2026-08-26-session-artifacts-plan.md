# 2026-08-26 Session Artifacts plan

## Summary

Planned a read-only session **Artifacts** pane to replace Wayang's global Files navigator/editor.

Interview decisions:

- one Artifacts list + inline viewer in the right pane;
- policy-matched files under the Wayang user's home, preserving universal secret/control-plane denials and Protected-project isolation;
- backend-owned `present_artifact` tool as the only v1 agent sharing mechanism;
- completed user uploads also populate the list without focusing it;
- explicit agent shares focus the Artifacts pane;
- durable bounded per-session reference registry;
- Markdown, text/code, PNG/JPEG/static-WebP, PDF, and isolated sanitized HTML previews;
- unsupported/animated formats remain download-only;
- no file editing in v1;
- no automatic discovery from read/write/edit, bash, browser, MCP, backend outputs, or prose.

## Architecture outcome

Created `docs/plans/session-artifacts.md` with:

- exact `ArtifactToolRuntime` object/binding authority and lifecycle;
- SQLite metadata registry, bounds, revision/event, startup/close, and deletion-recovery contracts;
- current-session path authorization reusing Wayang's Project/Profile, Standard-resources, Protected-artifact, and structured-read policy;
- opaque artifact IDs and descriptor-owned no-follow preview/download streaming;
- authenticated/same-origin HTTP response policy;
- DOMPurify sandboxed HTML and local PDF.js canvas rendering;
- shared REST/WebSocket protocol and session/selection correlation;
- desktop/mobile UX, chat cards, Files API retirement, milestones, roles, tests, rollout, and rollback.

A read-only terminal architecture/security review initially returned NO-GO, identified concrete lifecycle, authorization, streaming, renderer, upload, deletion, and protocol gaps, and returned **GO** after they were resolved in the plan.

## Validation

- Read `README.md`, `SECURITY.md`, relevant guides/plans, and current backend/frontend/runtime source.
- `make doctor`: 0 failures, 3 pre-existing configuration warnings (unsafe `.env` mode and unavailable capability approval PIN/cooldown metadata); no secret contents inspected.
- `git diff --check` on the planning worktree.
- No implementation or runtime tests were run because this session produced planning documentation only.

## Authorization boundary

The plan does not authorize implementation, dependency changes, Files-route removal, merge, deployment, or service restart. Those require Clemente's explicit approval after review.
