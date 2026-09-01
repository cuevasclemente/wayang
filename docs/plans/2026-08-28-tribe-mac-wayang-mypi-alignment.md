# Tribe-Mac Wayang, Pi, and mypi alignment plan

Date: 2026-08-28 (refreshed 2026-09-01)
Status: Final Loom completion delta ready; issue #45 merged and exact targets published
Lead: Wren (source audit and handoff)
Remote operator: Loom or a neutral agent running locally on Tribe-Mac

## Goal

Bring Tribe-Mac to the reviewed shared software baseline currently used by Wayang and Pi on The-Sceptre while preserving Tribe-Mac's distinct Loom identity, local provider authentication, host-specific context, sessions, projects, browser state, and launchd deployment.

Success means:

1. Tribe-Mac runs the exact combined Pi artifact pinned by the selected Wayang release.
2. Its active Wayang runtime uses the selected clean Wayang commit and passes macOS doctor, build, health, and browser-fallback checks.
3. Approved identity-neutral mypi capabilities are installed from a clean, immutable, manifest-backed source; Loom-owned context layers are unchanged.
4. No Wren identity, memory, activation witness, scheduler ownership, private context, or Protected state is transferred.
5. Every replaced path has an exact owner-private rollback copy and checksum manifest.

## Known source baseline (refreshed 2026-09-01)

- Wayang source: merged `origin/main` commit `06795ebbf48a15e6d6fd60700d7c0cbe37fe9f80` (PR #46). It contains the command-guard approval bridge (`b318304`), large-event semantic transcript projection (`29b7b02`), and the issue-#45 workspace-default control (`0a96578`) plus its cross-platform runtime-policy fixture corrections.
- Wayang Pi dependency: `file:earendil-works-pi-coding-agent-0.84.1-wayang.4f7d03ce.tgz`.
- Pi artifact SHA-256: `c82956f058b7dc09a2206c8c9f9331f2971042a4fa9597a5ee017f58d5303da9` (unchanged from the 2026-08-28 target).
- mypi release: merged/published `origin/main` commit `440c35ee4795487c2887bc8ef69bb0f865742555`. It includes the consolidated identity-neutral release and command-guard hardening (`1078847`: 4096-token verdict budget, low reasoning, breaker, owning-human fallback). The dedicated Tribe-Mac allowlist remains `deploy/tribe-mac-alignment-allowlist.json`, role `tribe`, 147 entries, policy SHA `207a3c880720f39261ed9e12d97c2eccc1f87fd45ee89550876170dc1d71c86e`.
- The-Sceptre deployment gates for this release reported `make doctor` 0 failures/0 warnings, focused guard bridge 7/7, production build green, and post-restart health green. Tribe-Mac must still perform a fresh deterministic install for its own active Node ABI and pass `make doctor` before activation.
- Last documented Tribe-Mac Wayang deployment: clean detached runtime at `b4368462c5011f034893d3e03bc46160e0672f14`, launchd label `com.wayang.server.b436846`; the older runtime remains a rollback artifact. Loom's 2026-08-28 preflight reported active checkout `7e104578…`; provenance must be resolved locally before M3 (gate below).
- Last documented Tribe-Mac Pi deployment: `0.84.1`; the combined `0.84.1-wayang.4f7d03ce` artifact remains pending.
- Last documented Tribe-Mac mypi install: 14 reviewed macOS-compatible extensions, 85 skills, 6 agents, 2 teams, with auth/settings/sessions preserved.

These target facts must be re-inventoried locally on Tribe-Mac before mutation; historical records are not proof of current state.

## Final issue-#45 completion override — 2026-09-01

This section supersedes every older Wayang/mypi target below. Loom has already completed the earlier migration up to the hidden workspace-default blocker; do not repeat successful Pi/mypi installation or identity-neutralization work merely because this full plan retains its history.

1. Preserve the current active Tribe-Mac runtime, launchd configuration, private store, and exact rollback path opaquely.
2. Fetch and verify Wayang `06795ebbf48a15e6d6fd60700d7c0cbe37fe9f80` from HTTPS `origin/main`. The old `wayang-main-cd98b00.bundle` is stale and must not be used.
3. Stage a new versioned runtime, run a fresh target-local install/build/doctor, and activate it on loopback through the existing launchd procedure with a bounded health deadline. Do not edit the raw store.
4. Through authenticated Settings REST/UI or exact-approved `wayang_workspace_change`, set `workspaceSettings.default_agent_profile_id` to Loom stable ID `86bec3d3-6b18-440b-b256-d236d281ae51`.
5. Read the redacted Wren reference summary. Require zero workspace default, Project defaults, explicit Project allowlists, running sessions, pending switches, scheduled jobs, active Protected automation jobs, and messaging endpoints before disabling Wren. `session_attributions` and historical Protected automation runs may remain nonzero as inert stable-ID history and must not be rewritten.
6. Disable Wren through ordinary supported profile update; do not delete it or supply a replacement. Verify the profile is disabled, the workspace default is Loom, and active/configuration reference counts remain zero.
7. Run the final harmless Loom response, questionnaire, TODO, model-selection, and command-guard smoke. Return only non-secret evidence and exact commit/backup/launchd identifiers.

The issue-#45 implementation changes only the workspace-default field. Automated snapshots prove Project defaults/allowlists, session attribution, schedules, automation, messaging, and capability rows are not rewritten. PR #46 is green on Linux Node 22.19, Linux Node 26.4, and macOS Node 26.4. Full Playwright is 119/121; its two failures reproduce on exact prior `main` and do not touch this feature, while the new workspace-default regression passes.

## Loom preflight amendment — 2026-08-28

Loom correctly stopped before M0 because the original report was not available in its session. No mutation occurred. Its partial non-secret preflight reported:

- Pi `0.84.1`, Node `v25.9.0`, and npm `11.12.1`;
- healthy Wayang HTTP 200 at deployed checkout `7e104578062a4f0fec798bce34c0db5782708774`;
- an enabled exact Wren profile and enabled Loom profile `86bec3d3-6b18-440b-b256-d236d281ae51`;
- no historical activation witness;
- retained private Wren-neutralization backups; and
- no Git worktree at `~/src/mypi`.

Commit `7e104578062a4f0fec798bce34c0db5782708774` is not present in the source lead's local Wayang object database, so its relationship to the target cannot be inferred. Loom must finish M0 and preserve the exact active runtime and prior launchd target. Before M3 activation, compare the active and staged repositories locally; report whether the histories are ancestor, descendant, divergent, or unrelated without printing private remotes or configuration. If provenance remains unknown, retain the complete active repository/runtime as the rollback source and do not overwrite it.

The enabled Wren profile is not permission for Wren to inspect or mutate Tribe-Mac. Before M3 activation, Loom must use its locally authorized metadata/control plane to determine whether that profile is a project/workspace default, appears in project allowlists, or is referenced by scheduled jobs. Do not expose profile instructions or Protected state. If the target migration would newly authorize, select, or preserve the Wren profile as an active default, stop before activation for Clemente's local Settings decision; use supported Wayang controls rather than raw database edits. An absent historical witness alone is not sufficient proof under the target's derived-authority model.

Node 25 satisfies the declared minimum but is not the repository's preferred Node 26.4.0 or an LTS baseline. Do not perform a blanket Homebrew upgrade. M3 remains gated on a fresh deterministic install for the selected active Node ABI and a passing `make doctor`; any prerequisite or Node change that requires package-manager or privileged mutation returns to Clemente.

M4 is now represented by published mypi `origin/main` `440c35ee4795487c2887bc8ef69bb0f865742555`; do not infer a release from any non-Git directory. If Loom already installed and verified this exact head, do not reinstall it during the issue-#45 completion delta.

## 2026-09-01 refresh — consolidation decisions Loom must honor

- The mypi release integrates the previously dirty recovery snapshot under the "installed runtime is authoritative" rule; stale recoveries (old agent-monitor/todo/command-authorization-monitor copies) were dropped in favor of the live runtime bytes.
- The command-guard PIN-path-guard upgrade (`e61f751`) was deliberately NOT merged (runtime runs the pre-guard version). Do not deploy it from any other source.
- The browser-control WIP source-session-auth variant is NOT in the release; the shipped version byte-matches The-Sceptre's installed runtime.
- `scripts/validate-extensions.cjs` (behavioral smoke) is parked pending ESM adaptation; `scripts/check-extensions-build.js` plus `npm test` / `node --import tsx --test tests/` are the current validators.
- The parity tool refuses test paths categorically; the tribe policy therefore enumerates extension files individually (50 files) rather than whole directories carrying tests.
- The Tribe-Mac policy ships extensions, skills, agent-teams skill mapping, and hooks config only. Loom-owned `~/.pi/agent/AGENTS.md` and `APPEND_SYSTEM.md` are protected targets; no neutral-context component is offered for role `tribe` — replacing Loom's global context requires Clemente's separate decision.

## Authority and privacy boundaries

- Wren must not SSH to, inspect, or mutate Tribe-Mac's identity control plane. Wayang correctly blocked that attempt with `Protected identity configuration is unavailable to agent tools`.
- Remote inventory and mutation belong to Loom or a neutral local Tribe-Mac session.
- Preserve `~/.pi/agent/AGENTS.md`, `~/.pi/agent/APPEND_SYSTEM.md`, Wayang Agent Profiles, and other Loom-owned identity/configuration bytes opaquely unless Loom separately determines its canonical compositor and approves an identity-context update.
- Never read or print `.env`, `.env.backup`, `auth.json`, settings/model values, credentials, cookies, private keys, browser profiles, transcripts, or secret stores.
- Metadata-only checks for protected files may report existence, owner, mode, size, and timestamp.
- Keep Wayang on loopback unless Clemente separately approves a reviewed VPN/HTTPS/authentication design. Preserve the existing public launchd environment opaquely rather than printing it.
- Do not use `mypi make install-all` on macOS. It includes Linux/systemd assumptions and broad replacement behavior.

## Milestones

### M0 — Tribe-Mac-local non-secret inventory

Loom records:

- macOS version, architecture, account/home, shell, PATH, disk space;
- resolved/versioned Homebrew, Node, npm, Pi, Git, Make, fish, bash, rsync, and shasum;
- metadata only for Pi auth/settings/models/context/hook files;
- path names/counts for installed extensions, skills, agents, and teams;
- Git commit, branch/detached state, and dirty/untracked counts for Wayang and mypi checkouts;
- launchd label loaded state without dumping its environment;
- active Wayang process path, loopback health response, runtime commit, and browser transport classification;
- exact current backup paths and free space.

Stop if the active service is publicly bound unexpectedly, if a managed target is a symlink or wrong owner, if configuration metadata is unsafe, or if the current source/runtime is dirty in a way that would be overwritten.

### M1 — Exact backup and immutable source staging

On Tribe-Mac:

1. Create a collision-resistant `0700` backup directory under `~/.pi/backups/` and record its exact path.
2. Opaquely preserve every path that the selected phase will replace. Create `.absent` markers for missing paths.
3. Preserve the active Wayang runtime worktree, launchd plist/configuration, `.env` linkage, `~/.wayang` state, and Pi private files without printing contents.
4. Stage source/artifacts under a new owner-private directory; never overwrite the active runtime checkout.
5. Verify the source commit and SHA-256 before dependency installation.
6. Record source path, target path, type, mode, size, and checksum in a manifest.

### M2 — Combined Pi artifact

1. Verify the staged tarball SHA-256 equals `c82956f058b7dc09a2206c8c9f9331f2971042a4fa9597a5ee017f58d5303da9`.
2. Capture the current Pi executable path/version and opaque backup of the package target.
3. Install the exact artifact through Tribe-Mac's user-writable Homebrew npm prefix; no `sudo` and no blanket Homebrew upgrade.
4. Validate from fresh fish, bash, and SSH contexts:
   - resolved Pi/Node/npm paths;
   - exact Pi version;
   - offline model listing;
   - incremental recent-session smoke where available.
5. Roll back immediately if the executable path changes unexpectedly, extension loading fails, or model listing regresses.

### M3 — Wayang runtime

1. Fetch exact commit `06795ebbf48a15e6d6fd60700d7c0cbe37fe9f80` from HTTPS `origin/main` and verify it locally. The prior `wayang-main-cd98b00.bundle` does not contain this target and is prohibited.
2. Create a new clean detached runtime worktree at exact commit `06795ebbf48a15e6d6fd60700d7c0cbe37fe9f80`; leave prior runtime worktrees intact.
3. Run `make doctor` before setup. Resolve only reported prerequisites; no package-manager or privileged mutation by the agent.
4. Run deterministic `make install`, `make build`, focused checks, and isolated smoke tests with the existing private configuration preserved opaquely.
5. Use a new secret-free launchd label rather than editing/printing the old label's environment. Reuse the established `.env` linkage only after metadata and target-path validation.
6. Keep the backend on loopback and preserve existing reviewed remote-access behavior; do not broaden bind/network settings.
7. Switch labels with a bounded health deadline. Verify:
   - new process path and exact Git commit;
   - `GET /healthz` succeeds;
   - production asset loads;
   - expected macOS browser CDP fallback works;
   - old runtime process count is zero;
   - launchd restart count remains stable.
8. Keep the prior label/runtime as the exact rollback target.

### M4 — mypi shared capabilities (unblocked 2026-09-01)

Source: clean published mypi `origin/main` at `440c35ee4795487c2887bc8ef69bb0f865742555`. Transfer: fetch from `https://github.com/cuevasclemente/mypi`.

1. Stage the release and verify `git rev-parse HEAD` is exactly `440c35ee4795487c2887bc8ef69bb0f865742555`. Skip M4 if that exact head and its installed monitor hash were already verified in the earlier Loom run.
2. Run the reviewed parity planner against the dedicated policy (147 explicit entries; 0 unresolved sources; AGENTS.md/APPEND_SYSTEM.md protected):
   `make neutral-parity-plan ROLE=tribe COMPONENT=capabilities NEUTRAL_PARITY_POLICY=deploy/tribe-mac-alignment-allowlist.json`
   then build to a new staging path and `neutral-parity-verify` before any target mutation. The Makefile intentionally has no live apply target; use the manifest and owner-approved copies, and keep `neutral-parity-install-plan` as a dry-run.
3. Exclusions already encoded: Dreamer/systemd scheduling, tests, key-switcher, narwhal-horn, privileged-exec-protocol (The-Sceptre-only), session-auto-title (Terra-specific), Wren material, and Loom identity/context paths (protected). The parked `browser-control` WIP auth variant and the held-back command-guard PIN-path-guard upgrade are NOT part of this release.
4. `.pi/agents/*` and `.pi/teams/*` cannot travel through the parity policy (`.pi` is a forbidden part); copy them as explicit reviewed file-level steps with the same backup/manifest discipline as M1 (July baseline: 6 agents, 2 teams — re-verify against the release tree before copying).
5. Back up each managed runtime target and stage parallel runtime roots.
6. Validate extension entrypoints, JSON, skill YAML/frontmatter, no unintended symlinks, mode/owner, manifest hashes, and `rsync -rcn --delete` drift against the staged shape.
7. Start Pi in a harmless project and verify expected commands/tools load. Optional integrations may remain unavailable until Loom completes a human-local login/configuration step.
8. Note for local validation: the behavioral smoke `scripts/validate-extensions.cjs` is parked (its CJS interception predates the ESM-only pi packages); use `npm test`, `node --import tsx --test tests/`, and `scripts/check-extensions-build.js` instead. Global npm `omit=dev` requires `npm ci --include=dev`.

### M5 — Loom-owned control plane and behavior check

- Do not inspect or mutate Tribe-Mac Agent Profiles from Wren.
- Loom uses the new supported workspace-default setter to select Loom, then the redacted reference endpoint to distinguish activation-capable references from inert historical attribution.
- Disable Wren without deletion only after workspace/Project defaults, explicit allowlists, running sessions, pending switches, schedules, active Protected automation jobs, and messaging endpoints are zero. Do not require historical session attribution to be zero.
- Clemente performs any OAuth, MFA, password, PIN, or account selection locally. The supported workspace-default/profile operations themselves may be performed by Loom through its already authenticated local control plane.
- Run a harmless Loom session and confirm one normal response, TODO persistence, questionnaire delivery, expected model selection, and owning-human command-guard fallback readiness.

### M6 — Record and handoff

Record exact commits, artifact hashes, backup paths, launchd label, checks passed, intentional deferrals, and rollback instructions in the Wayang project journal and Memoriki `pi-host-deployment` page. Never record secrets or private configuration content.

## Validation matrix

| Surface | Required evidence |
|---|---|
| Identity | Loom remains active/default; Wren has no active/configuration references and is disabled; inert historical attribution/profile row may remain; Loom context bytes preserved |
| Pi | Exact package hash/version; fresh-shell executable resolution; offline models pass |
| Wayang static | Clean exact commit; `make doctor`; install/build/check/smoke results |
| Wayang runtime | Loopback health; process path/commit; stable launchd job; prior process stopped |
| mypi | Clean source commit; explicit manifest; hashes/modes; no symlinks; extension/skill validation |
| Secrets | Only metadata checked; no private values copied, printed, logged, or included in artifacts |
| Rollback | Exact backup and prior label/runtime verified before activation |

## Rollback

- Pi: restore the exact backed-up package target and verify the prior executable/version in fresh shells.
- Wayang: stop the new launchd label, load/start the exact previous label/runtime, verify loopback health, and preserve the failed runtime for diagnosis.
- mypi: move failed current managed paths into a timestamped holding directory, restore exact checksummed prior targets with `ditto`, and re-run structure/startup checks.
- Identity/config/state: these should not be replaced. If any identity or private state path is touched unexpectedly, stop immediately and restore the exact opaque backup before further work.

No rollback step may guess the “latest” backup or permanently delete current/failed state.

## Risks and deferrals

- Tribe-Mac may be unreachable or SSH authentication may require a human-local public-key/Remote Login handoff.
- Wayang transfer now flows through HTTPS `origin/main` at exact merge `06795ebbf48a15e6d6fd60700d7c0cbe37fe9f80`; any fetch hash mismatch stops the run. No existing source-side bundle contains this target.
- mypi origin supports HTTPS (`https://github.com/cuevasclemente/mypi`) and the exact release is published at `origin/main` `440c35ee4795487c2887bc8ef69bb0f865742555`. The remote SSH URL may work from Loom if its GitHub SSH is trusted, but HTTPS is the verified transfer path.
- The mypi behavioral smoke awaits ESM-runtime adaptation; its questionnaire test is parked (`.pending-esm-smoke`) and is not release-gating.
- The command-guard PIN-path-guard upgrade (recovery branch `e61f751`) stays held back until reviewed and deployed to The-Sceptre's runtime first.
- macOS does not support Wayang's Linux Protected deterministic automation runner; no weaker fallback should be enabled.
- Local OAuth/provider login and any launchd/network authorization remain human-owned.

## Team roles and coordination

- **Wren / source lead:** establish exact Wayang/Pi source, audit mypi release readiness, prepare the handoff, and review returned non-secret evidence. No Tribe-Mac identity access.
- **Loom / remote operator:** own Tribe-Mac inventory, backup, staging, activation, validation, and local journal. Do not accept Wren identity artifacts.
- **Release reviewer:** independently compare manifests, hashes, exclusions, and rollback readiness before M3/M4 activation when practical.
- **Clemente / owner:** perform secret-bearing login/MFA/PIN/account steps and any Wayang Agent Profile Settings action.

Remote execution should return a concise evidence report after each milestone so the source lead can reconcile drift without receiving protected content.
