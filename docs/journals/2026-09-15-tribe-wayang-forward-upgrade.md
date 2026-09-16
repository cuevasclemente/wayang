# 2026-09-15 — Tribe-Mac supervised Wayang forward upgrade

## Goal

Bring Tribe-Mac's Wayang from the 2026-09-05 release (`e0aed464…`, Wayang `f4b03c8`) up to current `main`, so the session-renaming / automatic-title fix reaches a lagging host. Keep it a simple, repeatable, supervised **Wayang-only** forward upgrade; preserve all private state and the existing launchd arrangement.

## Root cause: launchd was bypassing the launcher symlink

Tribe's `~/Library/LaunchAgents/com.wayang.server.plist` had `ProgramArguments[0]` pointing *directly* at the old runtime binary:

```
…/runtimes/e0aed464…/bin/wayang-backend
```

The 2026-09-08 handoff successfully moved `~/.local/bin/wayang-backend` to `wayang-ed15a0c-6c20a80/bin/wayang-backend`, but launchd never invoked that symlink, so the "select" was inert and Tribe kept serving `e0aed464…`. The fix is a one-time repoint of `ProgramArguments[0]` to the symlink; after that, upgrades are a symlink switch only.

## Second finding: `main` would have silently regressed Tribe's titles

Current `main` pinned the automatic-title provider to OpenRouter **DeepSeek V4.1 Flash** (ZDR), fail-closed on a missing OpenRouter credential. Tribe has no such credential; it titles with **Terra via Codex** (`openai-codex` / `gpt-5.6-terra`). Deploying `main` as-is would have silently disabled Tribe's titles.

Added a host-local, enumerated selector (`feat/backend: host-selectable reviewed session-title provider`, merged to `main` as `6275afe`):

- `WAYANG_AUTO_TITLE_PROVIDER` — unset/empty/`openrouter`/`deepseek` → OpenRouter DeepSeek (unchanged default); `codex`/`terra` → Codex/Terra; anything else → fail closed with `title_model_unavailable`, never substituting a provider.
- Both descriptors are immutable, frozen, pinned by provider/id/api/baseUrl, with the same reviewed credential-source allow-list; the Codex path additionally requires `registry.isUsingOAuth` and rejects non-empty `baseUrl`/`headers`/`env`. No `models.json`/extension/runtime override is ever consulted.
- Wired both construction sites (`session-title-service.ts`, `manual-title-generation.ts`) and the test seams through one factory.

Validation: backend suite **1444 pass / 0 fail / 10 skip**; new focused title tests included. Sceptre is unaffected (default unchanged).

## Wayang-only native candidate

The full-stack `assemble-tribe-candidate.mjs` both rebuilds Node/Pi/myPi and drags in apply machinery the owner deprioritized. Added a thin `assemble-tribe-wayang-only.mjs` that reuses the reviewed `buildWayangRuntime` only (dev install → builds → exact prod install → `better-sqlite3` native rebuild + ABI smoke → deterministic archive), run natively on darwin/arm64.

Two toolchain issues surfaced and were fixed:

1. Tribe's staged `pi-stack-deploy` `dist/` (2026-09-04) set the build environment `PATH` to *only* the node bin dir, so `tsc` failed under npm. Rebuilt `pi-stack-deploy` `dist` from current source (which appends `/usr/bin:/bin:/usr/sbin:/sbin`) and synced it to Tribe.
2. `archiveWayangRuntime` requires the output directory to be owner-private (0700); the staging audit dir was 0755.

Candidate pins:

| Item | Value |
|---|---|
| Wayang source | `main` @ `6275afeec0be1ab14064d8ce33921ec7ac3523cd` |
| Pi triplet | `fa40ae91` / `22ca19ed` / `fa40ae91` |
| Archive | `wayang-runtime.tar.gz` |
| Archive SHA256 | `519c7026fbf04acf1a2adf224e3e610316e124019e7c3105df7f5982cb8f34a8` |
| Public files | `19998` |
| Prepared-tree aggregate | `40f57daff9157aa506eb4379173f85e602128326cbc1b1f6544a00c3df835c6c` |
| New runtime dir | `wayang-6275afe-519c702` |
| Title provider | `codex` |

## Handoff tooling

On branch `ops/tribe-supervised-upgrade-20260915` (`docs/runbooks/`):

- `tribe-wayang-upgrade.sh` — `prepare`/`verify`/`select`/`repoint`, pinned, fail-closed, never starts or stops a service, never reads private config. `repoint` edits only `ProgramArguments[0]` and proves the environment dictionary and the rest of the plist are byte-identical by hash.
- `assemble-tribe-wayang-only.mjs` — the Wayang-only native assembler.
- `2026-09-15-tribe-supervised-upgrade.md` — operator runbook with the concrete pins.
- `scripts/tests/tribe-wayang-upgrade.test.mjs` — 17 tests (script suite: **84 pass / 0 fail**), including repoint hash preservation, provider allow-list, and switching from a previously-selected managed runtime.

The generated `$new/bin/wayang-backend` wrapper exports `WAYANG_AUTO_TITLE_PROVIDER=codex`, so the host-local choice lives in a public generated file and no private `.env` edit is needed. `run-with-env.mjs` only fills *undefined* keys from `.env`, so the export wins.

## Status

`prepare` and `verify` both succeed on Tribe against the pinned aggregate; the old runtime and launcher are unchanged. Remaining work is the supervised switch, to be run by the owner from the Mac terminal: `launchctl bootout --wait gui/501/com.wayang.server`, then `repoint`, `select`, and `launchctl bootstrap gui/501 …/com.wayang.server.plist`, then `verify` + `healthz` + a real title check on a fresh session.

## Follow-ups

- After the switch, confirm titles actually generate on Tribe (needs `WAYANG_AUTO_SESSION_TITLE=on` and Codex OAuth already present on the host).
- Consider merging the `ops/tribe-supervised-upgrade-*` handoff branches, or moving them to a durable ops location; they are currently unmerged, as with the 2026-09-08 handoff.
- Reconcile the manual (non-transactional) runtime selection before any future managed full-stack operation.
