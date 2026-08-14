# Terra canonical session titles implementation

**Date:** 2026-08-13  
**Status:** final local integration, synthetic validation, and independent terminal privacy/concurrency gates complete (GO)
**Authorization boundary:** no extension installation, flags, live Terra transcript calls, service restart, production schema migration, deployment, or remote push

## Implemented commits

- Pi `529ab5c1` — locked revision-state session-name CAS with human/automatic origin metadata.
- Pi `6c8f459b` — immutable `InputEvent.originalText`, preserving raw human input across chained extension transforms.
- Wayang `526a5c9` — schema-5 title provenance and bounded durable browser source markers.
- Wayang `d3c0a4d` — remove legacy first-message PATCH and add frontend contract E2E.
- Wayang `78f8caf` — vendored uniquely versioned Pi artifact, bounded Terra policy/provider, live and selected-session activation orchestration, explicit disclosure flags, documentation.
- Wayang `e8feb84` — trigger generation after idle `prompt()` resolves and its source marker is durable.
- Wayang `c0b120c` — preserve concurrent explicit Wayang titles after automatic Pi CAS and invalidate physical snapshots despite mirror failure.
- Wayang `601725f` — pin the immutable-original-input Pi artifact.
- mypi `01712e6` — identity-neutral opt-in TUI extension using durable interactive markers and Pi CAS.
- mypi `fa64d30` — next-completed-exchange retry regression.
- mypi `b20393e` — fail closed when the runtime lacks the reviewed naming CAS.
- mypi `cf645fd` — bind branched interactive provenance using all entries plus current-branch membership.
- mypi `9f38972` — persist immutable pre-transform raw input while binding to the transformed user entry.
- Pi `2ad8cf88`, `61437082`, `daf73d49` — serialize migrations with title writers, make existing-session rewrites atomic and append-coordinated, and atomically materialize new session identity before publishing its path.
- Wayang `55b864f`, `03c4408`, `25f3762`, `f99ad21`, `5f4fa90` — bypass mutable compatibility dispatch, pin and freeze Terra request identity, isolate title OAuth from `models.json`, bind new Pi IDs to Wayang IDs, and materialize before path publication.
- mypi `8cf1799`, `e4977bd`, `474f695`, `0f1a261`, `c043144` — use the immutable Codex dispatcher, pinned request identity, isolated built-in OAuth runtime, and final Pi artifact.

Final heads:

- Pi `daf73d49`
- Wayang `5f4fa90`
- mypi `c043144`

Vendored Pi artifact:

- version `0.84.1-wayang.daf73d49`
- SHA-256 `46af9ae9b980caac86a8c87e438ad8e2d6719be91082554cc5ca31c9e97926f2`

## Validation

- Pi focused CAS/materialization suite: 20/20; earlier input-event suites plus full Pi check pass.
- Wayang title/provenance focused suite: 74/74 before the final dependency-only pin; new mirror regressions pass.
- Wayang backend aggregate against the final artifact: 779 pass, 0 fail, 5 skip.
- Wayang frontend lint/build: pass with one existing Fast Refresh warning.
- Wayang title E2E: 2/2.
- Wayang `make doctor`: 0 failures, expected unconfigured local `.env`/approval-metadata warnings.
- Wayang `make check`: feature/backend/build gates pass; one unchanged command-guard-blocked fake-Bitwarden credential-helper script fixture remains unrelated.
- mypi extension: 7/7 synthetic tests and TypeScript check pass after clean `npm ci --ignore-scripts`.
- No live provider request was made; the Codex adapter was exercised with synthetic fetch and verified `store: false`, SSE, no source-session affinity, no tools.

## Safety and behavior

- Both feature flags default off. Protected disclosure requires the general and Protected-specific flags.
- Requests use only bounded persisted first-three exchange prose; infrastructure prompts, reasoning, tools/results, attachments, generated paths, later turns, and metadata are excluded.
- Ordinary Pi captures immutable pre-transform `originalText` but hashes current transformed text; an additional later transform fails marker binding closed rather than pairing raw prose with a different user entry.
- Same-count failures coalesce; later completed exchanges permit retry while reusing first-three content.
- Request-time policy/digest checks happen synchronously immediately before dispatch; commit performs a fresh physical parse and shared Pi CAS.
- Manual names use the same lock and win races. Any prior `session_info`, including explicit clear, suppresses automatic naming.
- Wayang marks owned SessionManagers in a process-global WeakSet so the ordinary Pi extension defers.
- Selected stopped-session catch-up reuses the initial history parse and stats the same file before disclosure; the second full parse occurs only after a valid provider result at commit.

## Independent terminal gate

Fresh independent scoped reviews returned:

- `PRIVACY GATE: GO — no blocker/high findings.`
- `CONCURRENCY GATE: GO — no blocker/high findings.`

The gate uncovered and drove fixes for mutable compatibility dispatch, mutable catalog endpoint aliases, models-configured OAuth substitution, stale migration rewrites, non-atomic transcript replacement, Wayang/Pi session-ID mismatch, and publication of unmaterialized session paths. A later generic stale-extension finding was independently adjudicated as outside the Terra title path and not applicable to its exact manager/CAS behavior.

## Final integration follow-up

A rollout review of the first gated artifact found that atomic migration through a symlink could replace the alias and split one session ID into divergent files. The final Pi integration therefore added stable physical descriptor/path revisions, short revision-validated append and replacement transactions, crash-safe materialization reconciliation, strict tail handling, hardlink denial, transactional manager state, and stable legacy fork snapshots.

Final exact heads before this journal update:

- Pi `5bc35555`
- Wayang `bdbbcc4`
- mypi `9ad15b4`

Final vendored artifact:

- version `0.84.1-wayang.5bc35555`
- SHA-256 `b25bad929297ebb76c0c95cae3d52304a5f40c2a3157fdf3e364b35423409b7a`

Final validation:

- Pi full check and focused session/input/fork suites: 70/70.
- Wayang title/provenance/bridge/session/provider slice: 76/76; backend and frontend production builds pass.
- Wayang unrestricted aggregate exceeded the parallel 30-minute harness cap in two protected-automation feasibility tests; both tests pass individually and are unrelated to title behavior.
- mypi extension: 7/7 and TypeScript pass.
- Independent terminal privacy/security gate: GO.
- Independent terminal concurrency/correctness gate: GO.

Clemente explicitly authorized both Standard and Protected interactive title disclosure. No flags were changed and no live provider request, production migration, restart, deployment, or remote push occurred during this gate. The separate identity-neutral downstream Pi proposal is `docs/plans/downstream-pi-session-transactions.md`.
