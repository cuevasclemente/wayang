# Tribe-Mac Wayang, Pi, and mypi alignment plan

Date: 2026-08-28
Status: In progress; remote execution must be performed by a Loom-owned or neutral Tribe-Mac session
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

## Known source baseline

- Wayang source: clean commit `ff8b15e498f0df1586ee9b7a593f76ca4cf85ec2`.
- Wayang Pi dependency: `file:earendil-works-pi-coding-agent-0.84.1-wayang.4f7d03ce.tgz`.
- Pi artifact SHA-256: `c82956f058b7dc09a2206c8c9f9331f2971042a4fa9597a5ee017f58d5303da9`.
- Last documented Tribe-Mac Wayang deployment: clean detached runtime at `b4368462c5011f034893d3e03bc46160e0672f14`, launchd label `com.wayang.server.b436846`; the older runtime remains a rollback artifact.
- Last documented Tribe-Mac Pi deployment: `0.84.1`; the combined `0.84.1-wayang.4f7d03ce` artifact was still pending on 2026-08-28.
- Last documented Tribe-Mac mypi install: 14 reviewed macOS-compatible extensions, 85 skills, 6 agents, 2 teams, with auth/settings/sessions preserved.

These target facts must be re-inventoried locally on Tribe-Mac before mutation; historical records are not proof of current state.

## Current mypi release caveat

The checked-out `~/src/mypi` feature worktree is not a deployment source: it is 22 commits behind `main` and has a large staged/unstaged partial integration. The clean `mypi/main` head is `b53fc26a77af294e7bb6008e0a6e2810ff639828`, but the broader parity work is split across:

- clean skill canonicalization commit `9f80951f0dfc288507d1edaa55e227a493c72a6b`;
- an uncommitted neutral-parity installer worktree;
- an uncommitted runtime-extension-parity worktree.

Therefore no broad mypi sync may use the dirty feature tree, installed runtime tree, or unfinished parity work. The shared-capability phase waits for either:

1. a reviewed clean integrated mypi release commit and Tribe-Mac allowlist; or
2. an explicitly approved narrower manifest built from already reviewed clean commits.

Keeping Tribe-Mac's existing mypi runtime unchanged during the Pi/Wayang upgrade is safer than distributing unresolved source.

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

1. Create a new clean detached runtime worktree at exact commit `ff8b15e498f0df1586ee9b7a593f76ca4cf85ec2`; leave prior runtime worktrees intact.
2. Run `make doctor` before setup. Resolve only reported prerequisites; no package-manager or privileged mutation by the agent.
3. Run deterministic `make install`, `make build`, focused checks, and isolated smoke tests with the existing private configuration preserved opaquely.
4. Use a new secret-free launchd label rather than editing/printing the old label's environment. Reuse the established `.env` linkage only after metadata and target-path validation.
5. Keep the backend on loopback and preserve existing reviewed remote-access behavior; do not broaden bind/network settings.
6. Switch labels with a bounded health deadline. Verify:
   - new process path and exact Git commit;
   - `GET /healthz` succeeds;
   - production asset loads;
   - expected macOS browser CDP fallback works;
   - old runtime process count is zero;
   - launchd restart count remains stable.
7. Keep the prior label/runtime as the exact rollback target.

### M4 — mypi shared capabilities

This phase begins only after the release caveat is resolved.

1. Build a clean Git-tracked Tribe-Mac manifest with explicit source-to-target entries.
2. Include only reviewed macOS-compatible extensions and identity-neutral skills/agents/teams.
3. Exclude Dreamer/systemd scheduling, tests, generated outputs, secret-dependent providers without local configuration, Wren material, Loom identity/context paths, auth/settings/models/sessions, `.mcp.json`, browser state, and full Memoriki archives.
4. Copy complete extension directories when entrypoints import sibling files.
5. Back up each managed runtime target and stage parallel runtime roots.
6. Validate extension entrypoints, JSON, skill YAML/frontmatter, no unintended symlinks, mode/owner, manifest hashes, and `rsync -rcn --delete` drift against the staged shape.
7. Start Pi in a harmless project and verify expected commands/tools load. Optional integrations may remain unavailable until Loom completes a human-local login/configuration step.

### M5 — Loom-owned control plane and behavior check

- Do not inspect or mutate Tribe-Mac Agent Profiles from Wren.
- Loom verifies that Loom remains the intended local identity/default where desired and that no Wren profile, activation witness, context, or authority exists.
- Clemente performs any OAuth, MFA, password, PIN, account selection, or identity-profile Settings action locally.
- Run a harmless Loom session and confirm one normal response, TODO persistence, questionnaire delivery, and expected model selection.

### M6 — Record and handoff

Record exact commits, artifact hashes, backup paths, launchd label, checks passed, intentional deferrals, and rollback instructions in the Wayang project journal and Memoriki `pi-host-deployment` page. Never record secrets or private configuration content.

## Validation matrix

| Surface | Required evidence |
|---|---|
| Identity | Loom remains active; Wren artifacts absent; Loom context bytes preserved unless separately approved |
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
- The source commit is ahead of `origin/main`; transfer must use an owner-approved exact Git/bundle path rather than assuming GitHub contains it.
- The current mypi parity release is not integrated and blocks broad capability deployment.
- macOS does not support Wayang's Linux Protected deterministic automation runner; no weaker fallback should be enabled.
- Local OAuth/provider login and any launchd/network authorization remain human-owned.

## Team roles and coordination

- **Wren / source lead:** establish exact Wayang/Pi source, audit mypi release readiness, prepare the handoff, and review returned non-secret evidence. No Tribe-Mac identity access.
- **Loom / remote operator:** own Tribe-Mac inventory, backup, staging, activation, validation, and local journal. Do not accept Wren identity artifacts.
- **Release reviewer:** independently compare manifests, hashes, exclusions, and rollback readiness before M3/M4 activation when practical.
- **Clemente / owner:** perform secret-bearing login/MFA/PIN/account steps and any Wayang Agent Profile Settings action.

Remote execution should return a concise evidence report after each milestone so the source lead can reconcile drift without receiving protected content.
