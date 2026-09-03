# Session Artifacts production deployment — 2026-09-03

## Intent

Deploy the Session Artifacts implementation merged through PR #48 without regressing the separately integrated browser-workbench declutter already served by the production checkout.

## Source reconciliation

- Authoritative artifact source: `origin/main` merge `fe932ff`.
- Existing local-only browser declutter: implementation `28c62a1`, journal `67e08c4`.
- A fresh deployment worktree first cherry-picked the browser line onto `origin/main`; the merge was conflict-free and passed the combined release and browser gates.
- Final production history merged `origin/main` into the existing local `main` ancestry at `fb1b03e`. Its tree is byte-identical to the validated cherry-pick candidate, preserving both histories without a reset.
- Root `main` fast-forwarded from `67e08c4` to `fb1b03e` and remains clean. `origin/main` remains the published Artifact merge; the browser declutter and production merge are still local-only.

## Validation before restart

- `make doctor`: 0 failures, 0 warnings.
- Clean-default `make check`: backend 1,150 passed / 8 skipped / 0 failed; frontend 9/9; scripts 64/64; lint and production builds passed.
- Focused Playwright (`session-artifacts`, `browser-workbench`, `protected-browser`): 14/14 passed, including both Artifact cases.
- Root deterministic `make install`, `make build`, and isolated `make smoke`: passed.
- The first combined check inherited the live deployment's Standard Browser Profile and paused-indexing flags, causing the expected fail-closed/paused assertions. Rerunning with only those three deployment flags omitted produced the clean-default result above; no production setting was changed.

## Deployment boundary

The existing system-level `wayang.service` remained active on its pre-Artifact process while assets were built. An approved transient systemd timer was scheduled to restart the service after 90 seconds, allowing the initiating Wayang turn to finish before its own backend process is replaced. No environment, service-unit, network, authentication, Project/Profile, transcript, browser-profile, or user-data setting was read or changed.

Post-restart production verification remains required:

1. confirm a new service PID/start timestamp and active/running state;
2. confirm local `/healthz` and the production root return HTTP 200;
3. confirm a fresh eligible interactive runtime exposes `present_artifact`;
4. present and preview one synthetic harmless artifact, then verify download behavior;
5. confirm the Browser pane retains the decluttered information hierarchy.

## Rollback

The predeployment source is preserved as the first parent `67e08c4`. If startup or live smoke fails, rebuild that known prior source and restart through the same reviewed service procedure. Do not delete or rewrite Wayang data, artifact metadata, transcripts, attachments, projects, or browser profiles as part of rollback.
