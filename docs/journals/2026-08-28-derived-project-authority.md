# Project privacy/RBAC-derived authority — 2026-08-28

## Owner decision

Wayang no longer has user-managed per-Project/Agent capability associations, revisions, PIN activation, individual revocation, or capability Settings. Current Project privacy and Agent Profile RBAC are the authority source:

- Standard Project + enabled allowed profile: Standard resources, Standard browser, and same-user host execution.
- Protected Project + enabled explicitly allowlisted profile: isolated Protected browser and deterministic Protected automation.
- Provider/model, names, prompts, profile resource preference, legacy association rows, and legacy approval history are not authority inputs.
- Human-only secret entry and operation-specific approvals remain separate hard boundaries.

## Integrated changes

Canonical main commit `998bf11 feat(policy): derive authority from project RBAC` includes:

- stable privacy/RBAC-derived authority witnesses and current-state reauthorization;
- inert retention of legacy association/history rows for rollback compatibility;
- removal of capability activation/revocation REST routes, frontend API methods, Settings tab, PIN challenge UI, and obsolete E2E behavior;
- denial-first projection publication and runtime/browser/automation latching for privacy, allowlist, profile-disable, and deletion transitions;
- removal of the legacy exact-Wren Standard-resource fallback that could bypass an excluding Standard allowlist;
- schema 8, with a backup-first schema-7 migration that rebinds eligible Protected automation jobs to derived revisions and blocks ineligible jobs;
- automatic Protected automation authority while preserving operation-specific human preparation/login/MFA/CAPTCHA and purge confirmation;
- updated security, installation, configuration, agent, and operator documentation.

The branch was rebased onto and preserved `cf546cc fix(workspace): preserve approved previews across activity` before fast-forward integration.

## Validation

- Post-rebase backend: 1081 passed / 0 failed / 8 expected skips.
- Frontend: 4/4 tests; lint has one pre-existing Fast Refresh warning and no errors.
- Scripts: 63/63.
- Backend and frontend production builds passed.
- Focused derived-authority/workspace/automation migration suite: 77/77.
- Replacement Settings Playwright E2E: 1/1.
- Independent read-only security/architecture review: GO; it noted only the existing startup-immutable Standard Browser Profile host gate as a deployment preflight.

## Deployment

- Wayang restarted on canonical main `998bf11`.
- `/healthz` returned `{"status":"ok"}` on the configured loopback listener.
- A mode-private `store.json.backup-v7-*` artifact confirms the backup-first schema migration ran before schema 8 publication.
- The old backend closed its listener on TERM but did not finish shutdown promptly; Clemente completed the restart. Investigate shutdown cleanup separately if this repeats.

## Rollback

Revert `998bf11` and restore the schema-7 backup only as one coordinated rollback while Wayang is stopped. Do not selectively reactivate legacy association rows under schema 8: current authorization intentionally ignores them.
