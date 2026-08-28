# 2026-08-28 — Tribe-Mac alignment source audit and Loom handoff

## Request and scope

Clemente asked to bring Tribe-Mac in line with the current Wayang and mypi setup. He clarified that Tribe-Mac has its own enduring agent identity, Loom. The intended result is shared software parity while preserving Loom and excluding every Wren identity, memory, activation, scheduler, and authority artifact.

## Source-side findings

- Wayang is clean at `ff8b15e498f0df1586ee9b7a593f76ca4cf85ec2`.
- Wayang pins `earendil-works-pi-coding-agent-0.84.1-wayang.4f7d03ce.tgz`.
- The combined Pi artifact SHA-256 is `c82956f058b7dc09a2206c8c9f9331f2971042a4fa9597a5ee017f58d5303da9`.
- Local `make doctor` passes platform/tool/config checks but reports the installed `better-sqlite3` binding unavailable for Node 26.4.0 ABI 147. A target runtime must run a fresh deterministic dependency install and pass doctor before activation.
- The last documented Tribe-Mac Wayang runtime is detached commit `b436846` under secret-free launchd label `com.wayang.server.b436846`, with the prior runtime retained for rollback.
- The last documented Tribe-Mac mypi installation was a reviewed macOS allowlist of 14 extensions, 85 skills, 6 agents, and 2 teams with private Pi state preserved.

## Identity-bound execution result

Clemente authorized a non-secret inventory and safe remote execution. Wren's first SSH inventory attempt was rejected before connection with `Protected identity configuration is unavailable to agent tools`. This matches the intended Wren/Loom control-plane isolation and was not bypassed.

Remote inventory, backup, activation, and Loom-profile verification must therefore be performed by Loom or a neutral agent running locally on Tribe-Mac. Wren may review only the returned non-secret evidence.

## mypi release caveat

The checked-out `feature/runtime-extensions` worktree is 22 commits behind `main` and contains a large staged/unstaged partial integration. It is not a release source.

Related parity work is split across:

- clean skill canonicalization commit `9f80951`;
- an uncommitted neutral-parity installer worktree;
- an uncommitted runtime-extension-parity worktree.

Broad mypi deployment is deferred until Clemente chooses whether consolidation is in scope and a clean Git-tracked Tribe-Mac allowlist/manifest is reviewed. Tribe-Mac's existing mypi runtime should remain unchanged during the immediate Pi/Wayang alignment.

## Deliverables

- Detailed backup-first plan: `docs/plans/2026-08-28-tribe-mac-wayang-mypi-alignment.md`.
- Isolated branch: `ops/tribe-mac-alignment-20260828`.
- Plan commits: `2da1e64`, then `4771d8f` with the native-binding caveat.
- The plan was privately published through the established report channel with no Matrix notification and no TTS so Loom can open it on Tribe-Mac.
- Memoriki `pi-host-deployment` was updated with the stable Loom/Wren boundary and active handoff state.

## Next action

Clemente starts or selects a Loom-owned Wayang session on Tribe-Mac and directs it to execute plan M0, then M1–M3 only if each gate passes. Loom returns exact versions, commits, hashes, backup paths, validation results, and blockers without protected content. M4 mypi deployment remains blocked pending clean release consolidation and scope confirmation.

## Remote mutation status

No Tribe-Mac files, services, identity state, credentials, configuration, or network settings were changed by this session.
