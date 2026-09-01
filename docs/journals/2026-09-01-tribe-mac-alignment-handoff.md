# 2026-09-01 — Tribe-Mac alignment handoff v4 (mypi consolidated, Wayang cd98b00)

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

- Refreshed plan: `docs/plans/2026-08-28-tribe-mac-wayang-mypi-alignment.md` (targets Wayang `cd98b00`, artifact `4f7d03ce` unchanged, M4 unblocked with the tribe policy).
- Wayang transfer: `origin/main` pushed to `cd98b00…` (exact git-verified fetch replaces the 48 MB bundle; bundle `a75915c2…dd759` remains the documented fallback, staged at `/tmp/wayang-deploy-20260901/` on The-Sceptre).
- mypi transfer: release published to `origin/main` = `a3433eb` (release content head `10d9f93`) over HTTPS. GitHub's host keys were fingerprint-verified against `api.github.com` published values and installed into `~/.ssh/known_hosts` on The-Sceptre (backup `known_hosts.bak-20260901T100918Z`); SSH key auth stays unavailable noninteractively (two passphrase-protected keys, no agent), so HTTPS is the verified transfer path.
- This branch: `ops/tribe-mac-alignment-20260901`, published through the established report channel for Loom.

## Identity and privacy boundaries (unchanged)

Wren performed only source-side work; no Tribe-Mac SSH, control-plane, or identity access was attempted in this session. Remote inventory, backup, activation, and Loom-profile verification remain Loom-owned. The 2026-08-28 preflight amendment (7e10457 provenance comparison, Wren-profile metadata gate, Node-25 handling) carries over unchanged.

## Next action

Clemente starts or selects a Loom-owned Wayang session on Tribe-Mac and directs it at the refreshed plan. Loom executes M0 first, then M1–M3 (Wayang `cd98b00` + combined Pi artifact), then M4 (mypi `10d9f93` via the tribe policy), returning non-secret evidence per milestone.