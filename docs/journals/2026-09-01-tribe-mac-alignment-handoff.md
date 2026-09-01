# 2026-09-01 — Tribe-Mac alignment handoff v5 (issue #45 merged; final Loom delta)

## Request and scope

Clemente asked to deploy the latest Wayang/mypi to Tribe-Mac and chose (2026-09-01 questionnaire): Wren refreshes the handoff for a Loom-owned execution; Wayang target is latest local main `cd98b00`; and mypi is consolidated first so the handoff carries a clean release.

## mypi consolidation (completed this session)

Divergent mypi lines were consolidated and released on `main`:

- `16f98eb` — consolidation release (WIP snapshot merge, recovery-line cherry-picks, session-coordination enable + empty-widget fix, runtime-parity sync, installer tooling, Makefile/README merge).
- `e3ea1f8` + `f68e4b7` — Tribe-Mac parity manifest (`deploy/tribe-mac-alignment-allowlist.json`, planner role `tribe`, 147 entries, 0 unresolved, policy SHA `207a3c88…`).
- `10d9f93` — merge of remote `main` (PR #2 guarded SSH control-socket support); the runtime-authoritative monitor variant won (assistant-authored context excluded by construction), README adopted Clemente's final Mozilla wording, PR test files pass 25/25. `a3433eb` adds the journal addendum on top.

Full decisions and validation: mypi `docs/journals/2026-09-01-mypi-consolidation.md`. Headline validation: npm test 37/0, tests/ 65/0 across nine suites, installer suite 12/0, identity-neutral distribution PASS, parity planner clean against the release tree.

Governing rule: The-Sceptre's installed runtime is authoritative for extension code; reviewed branches win where the runtime matches them. Deliberate hold-backs: the command-guard PIN-path-guard upgrade (`recovery/reviewed-integration` `e61f751`, never runtime-deployed) and the browser-control WIP auth variant (runtime runs the deployed version; WIP preserved in snapshot `34cdd5b`). The behavioral smoke `validate-extensions.cjs` is parked pending ESM-runtime adaptation.

## Deliverables

- Refreshed plan: `docs/plans/2026-08-28-tribe-mac-wayang-mypi-alignment.md`, now led by the final issue-#45 completion override.
- Wayang transfer: merged/published `origin/main` `06795ebbf48a15e6d6fd60700d7c0cbe37fe9f80` (PR #46). It includes the guard approval bridge, large-event projection, and supported workspace-default control. The old `wayang-main-cd98b00.bundle` is stale and prohibited.
- mypi transfer: merged/published `origin/main` `ea88d5e9596dcbc347c864db7f3697a283664556` (code `3f70d1d`) over HTTPS, including guard hardening and the exact-Wayang-owned-manager scope fix for standalone Pi CLI; the Tribe parity policy SHA remains `207a3c88…d86e`.
- This branch: `ops/tribe-mac-alignment-20260901`, ready to republish through the established report channel for Loom.

## Identity and privacy boundaries (unchanged)

Wren performed only source-side work; no Tribe-Mac SSH, control-plane, or identity access was attempted in this session. Remote inventory, backup, activation, and Loom-profile verification remain Loom-owned. The 2026-08-28 preflight amendment (7e10457 provenance comparison, Wren-profile metadata gate, Node-25 handling) carries over unchanged.

## Issue #45 closure and validation

Loom's target-local run correctly found that all visible Project/schedule references had been moved from Wren but the hidden workspace default still blocked nondestructive disable. Raw-store editing and profile deletion/replacement were rejected because they could damage or rewrite attribution.

Wayang PR #46 added authenticated REST, Settings UI, and exact-approved agent surfaces for changing only `workspaceSettings.default_agent_profile_id`, plus redacted reference counts and structured disable blockers. Snapshot regressions prove that Project defaults/allowlists, sessions, schedules, Protected automation, messaging, and capability rows are not rewritten. Fresh stores remain generic and do not seed a named Wren default.

Final CI at feature head `e1491ff` passed Linux Node 22.19, Linux Node 26.4, and macOS Node 26.4. Full Playwright reached 119/121; the two failures reproduce on exact prior `main` and are unrelated to this feature, while the new workspace-default E2E passed. Merge commit is `06795eb`.

## Next action

Clemente resumes the Loom-owned Tribe-Mac session with only the final delta:

1. preserve the current rollback/runtime/store opaquely;
2. stage, build, doctor, and activate exact Wayang `06795eb` on loopback;
3. advance mypi from `440c35e` only if needed to exact `ea88d5e`/code `3f70d1d`, using a separate backup-first parity delta that does not touch Loom identity/auth/context;
4. set the workspace default to Loom stable ID through the new supported control;
5. verify active/configuration Wren reference counts are zero, while allowing inert persisted session attribution/history;
6. disable Wren without deletion or replacement;
7. run the final Loom, standalone-Pi DNS, and command-guard smoke and return non-secret evidence.

Do not repeat already verified Pi or broader mypi migration work; apply only missing exact-release deltas.