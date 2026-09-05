# Wayang + myPi audit — findings and remediation

Date: 2026-09-05. Private maintainer report; no remote publication or production backend deployment performed.

## Executive result

The owner-prioritized delegation outage is repaired and real subagents have completed work. Six initial evaluators, isolated implementation specialists, and independent reviewers contributed through the actual Agent Teams tools. No direct-process policy workaround was used.

The audit produced tested corrections for policy compatibility/freshness, store startup, WebSocket admission, abort bookkeeping, scheduler retention, Apps target binding, four frontend races, and Agent Teams process/request lifecycle. All are consolidated on the two `audit/full-codebase-20260905` branches. **Main branches are unchanged.** Restoration-only companion files are installed; the newer manager lifecycle and Wayang fixes are source-only pending deliberate integration/deployment.

This is an evidence-led broad audit, not a claim of exhaustive line-by-line review or absence of defects. Remaining source-supported risks and unexamined areas are explicit below. No private sessions, credentials, production stores, browser profiles, or real external workflows were used as test fixtures.

## Bases and source locations

| Repository | Explicit base | Consolidated worktree | Tested source checkpoint before this report |
|---|---|---|---|
| Wayang | `b6a022528199c42695689af94212b45f9808ec95` | `/home/clemente/src/wayang-worktrees/full-audit-20260905` | `928e7c6` |
| myPi | reviewed deployed guard release `3c3c8f4` | `/home/clemente/src/mypi-worktrees/full-audit-20260905` | `9839a84` |

myPi's root checkout is an older divergent recovery branch, not the deployed release. Do not install from it or overwrite/switch it silently. Review integration from the explicit audit base into the intended main/release branch. Pi dependency is the reviewed `0.84.1-wayang.4f7d03ce` artifact; lifecycle conclusions below are specific to that contract.

## Fixed findings

P1 means high-impact correctness/availability or a participating authorization defect. P2 means bounded functional/race failure. These are priorities for this single-user application, not CVSS scores or claims of hostile same-UID containment.

| Priority | Finding and impact | Remedy and evidence | Commit |
|---|---|---|---|
| P1 | An unrelated Protected project's supported `scheduled: true` caused myPi's whole companion projection validation to disable Standard team tools. | Accept either boolean scheduling decision independently of subagent authority. Protected parents/targets/path access remain denied. Current-producer fixtures failed before the fix; extension startup and real post-reload dispatch succeeded. | myPi `1ef31d6` |
| P2 | Child reads lacked the launch path's transient fingerprint-staleness retry. Parallel audits repeatedly lost read authority during ordinary publication gaps. | Reuse a bounded stale-only retry around the **whole** lineage + path decision. Every attempt reloads policy; persistent staleness, malformed policy and tightened authority still deny. Synthetic recovery/tightening/persistent/malformed cases pass. | myPi `9eb1e32` |
| P1 | `getStore()` published `_store` before required startup projections succeeded, then released its writer lock on failure. Retries returned unlocked cached state with no store path. | Publish local loaded state/path/generation only after startup succeeds, matching `init()`. Regression fails before correction and passes afterward, including repeated failure, lock reacquisition and positive projection rebuilding. | Wayang `41b8604` |
| P2 | Trailing 25ms store-event debounce could postpone policy publication indefinitely under sustained writes. | Coalesce from the first event; later events do not reset the deadline. Deterministic mocked-watch/timer regression fails on base and passes after correction. This prevents starvation, not every transient stale window. | Wayang `31fcfdd` |
| P1 | Valid JSON `null` reached WebSocket dispatch and dereferenced `msg.type` outside the parse catch. | Admit only non-null, non-array object envelopes with nonblank string types. Preserve unknown string commands and existing per-command payload validation. Focused parser and runtime-recovery tests pass. No real service crash was attempted. | Wayang `0c91769` |
| P2 | Interrupt erased accepted-turn provenance while retaining browser queue records, stranding captures and blocking refresh retirement. | Revoke current mutation authority immediately; preserve retained accepted work. After successful explicit queue clearing, retire the ledger and browser records together. Tests cover true/false/omitted clearing, claimed/pending work, retirement and clear failure. | Wayang `0c91769` |
| P1 | 500 newer skipped scheduler attempts could prune the still-running row used as the overlap guard, permitting another run. | Preserve active rows and retain up to 500 terminal rows. Synthetic regression checks active survival, overlap denial, terminal eviction and pruning after completion. | Wayang `993b5f0` |
| P1 | Apps authorized query-preferred selectors but registration/event delivery used body-only selectors, allowing authorization and execution to target different projects/sessions. | Resolve one target, reject conflicting/malformed aliases, use it for registration and event delivery, and reject stale cross-project event defaults. Three synthetic integration tests include allowed A/excluded or Protected B, no side effects on denial, equivalent aliases and owner defaults. Independently reviewed. | Wayang `0e66d95` |
| P2 | Delayed model responses from A could reselect A after the user moved to B or overwrite B's saving/error state. | Request-generation guard across success/error/finally, invalidated on selection change. Deferred success and failure browser tests pass. | Wayang `df62563` |
| P2 | Unmatched old-epoch transcript pages could invalidate a newer window before request admission. | Match the directional in-flight request before interpreting epoch changes. Before/after page regressions preserve no-op behavior for retired requests and invalidation for admitted mismatches. | Wayang `df62563` |
| P2 | Selecting image/PDF during a pending text preview could leave the spinner stuck. | Reset loading on selection changes and gate successful text publication against abort. Image and PDF switch regressions pass. | Wayang `df62563` |
| P2 | TTS listener captured an old stage and could not resume after waiting for the next chunk. | Advance using current React playback state rather than the long-lived callback's captured stage. Synthetic EventSource/media tests cover chunk gaps, batched completion and no skipping of a playing chunk. No real broker/audio-device test claimed. | Wayang `df62563` |
| P1/P2 | Team manager used attempt-end as completion, overwrote concurrent send waiters, mishandled prompt rejection/process exit, and treated signal-sent as proof of exit. | Settle observed runs on `agent_settled`; reject overlapping sends; correlate prompt/rejection and no-run idle probes; preserve terminal states; select current assistant reports; ignore replaced-process output; escalate TERM to KILL based on exit state. 15 synthetic lifecycle regressions plus independent pinned-SDK ordering review. Not yet live-installed. | myPi `dc5b61d` |

Additional maintenance:

- `SECURITY.md` now correctly describes derived Protected browser authority; the obsolete association-activation paragraph contradicted the resolver (`928e7c6`).
- Agent Teams tests are now part of myPi's default `npm test`. Repaired the older tool-ceiling harness's missing TypeBox `Integer` mock and obsolete disabled-latch assertions, retaining real denial checks and explicit reload recovery (`9839a84`).

## Validation

### Integrated gates

- **Wayang `make check`:** backend 1,166 passed / 8 skipped / 0 failed; frontend 9 passed; scripts 65 passed; builds and lint completed. Baseline was backend 1,154 passed / 8 skipped, frontend 9, scripts 65.
- **myPi `npm test`:** 92 passed: 8 title + 29 memory + 55 Agent Teams/goal/report/policy tests. Default coverage previously included only the first 37.
- **myPi `npm run check`:** existing declared type-check gate passes.
- **Complete Agent Teams and child guard ESM bundling:** passes.
- **Synthetic real spawn/runner tool-ceiling harness:** passes with explicit `WAYANG_DIR` for the worktree; checks both launch paths, path-tool ceilings, disabled discovery, synthetic PIN-env exclusion and policy denials.
- **Focused integrated E2E:** 14/14 pass across artifacts, transcript controller and workspace/model/TTS specs.
- **Wider changed E2E suite:** 22/23 pass. The existing `repeated queued users ignore ID-less live replay and prepended history until a new tail occurrence` case still fails its final removal assertion (`expected true`, `received false`). Reproduced separately using the original frontend and original test on the audit base. It was not weakened or counted as passed.

### Qualifications

- A separate exploratory whole-Agent-Teams `tsc` invocation is **not green**: the entry point has pre-existing SDK typing drift (content arrays, notification levels, usage shape, goal-tool generics and nullable stdio); a `.ts`-import flag is also needed. The passing default `check` still covers title/memory, not all extensions. Bundling is not a substitute for this type check. No new manager-specific diagnostic beyond existing nullable stdio sites appeared.
- Existing frontend lint warning, bundle-size warning and Node deprecation warnings remain.
- Synthetic process mocks exercise production manager code but cannot automatically detect future changes in pinned SDK event ordering. Add a direct SDK contract test for delayed preflight, no-run acceptance and settlement when changing that dependency.
- Child retry tests cover parent tightening and persistent denial; an additional fault between successful lineage validation and path validation would strengthen regression coverage of the full recheck invariant.
- No new production backend, browser profile, native mobile or external provider workflow was activated.

## Measured performance evidence

New bounded, offline benchmark: `backend/src/scripts/benchmark-store-projections.ts`. Run from `backend/` with the hermetic test preloader, as with unit tests. It creates and removes only synthetic fixtures and prints aggregate results.

### Unchanged store flush

One local run, no synthetic sessions/interviews, restricted Standard project/profile pairs:

| Eligible Standard pairs | fsync calls for one unchanged flush | Elapsed (local run only) |
|---:|---:|---:|
| 1 | 10 | 1.85 ms |
| 5 | 42 | 6.71 ms |
| 10 | 82 | 8.33 ms |

The count follows the source's four projection publications per Standard pair, each with file/directory fsync, plus store durability. Larger session/interview sets add serialization/filtering cost. These are operation counts and one local timing sample, **not a production latency estimate**.

### Bounded header authorization

For 25 repeated reads of a synthetic header:

| Header bytes | read syscalls | Elapsed (local run only) |
|---:|---:|---:|
| 361 | 9,025 | 17.01 ms |
| 4,201 | 105,025 | 110.45 ms |
| 60,105 | 1,502,625 | 1,259.03 ms |

The one-byte reader deliberately avoids reading body bytes before classification; replacing it casually with read-ahead would change that boundary. However, search invokes authorization across the corpus before SQL filtering, and ownership matching scans session arrays repeatedly. A bounded file operation does not make the aggregate request cheap.

**Recommended direction:** request-scoped ownership indexes and candidate-first authorization where privacy-safe, followed by affected-pair projection publication. Preserve current-state reauthorization, duplicate-owner denial, and denial-before-commit semantics. Do not add another stale shared cache or weaken the header-before-body rule just to improve a benchmark.

## Remaining source-supported risks and decisions

These are **not reported as fixed or execution-reproduced**. They deserve a follow-up focused on SDK ingress/settings and durable delivery rather than mixing speculative changes into the tested corrections above.

1. **High: interrupt during prompt preflight can still start inference afterward.** `pi-bridge.ts` prompt/abort paths and pinned `AgentSession.prompt()` show a gap while input/`before_agent_start` hooks await: Pi may report idle, abort returns, then the accepted prompt starts when the hook releases. The current work counter is not cancellation. Reproduce with a gated synthetic preflight, then introduce an exact ingress cancellation contract at the SDK boundary. Do not merely emit another UI idle event.
2. **High: interview retry deduplicates durable entries, not already queued submissions.** `pi-bridge.ts::deliverInterviewSubmission` queues custom steering then waits 30s for persistence; `interview-delivery.ts` retries after timeout. A long tool can leave the first copy queued while another is inserted. Test across two delivery deadlines. Reconcile in-flight identity and confirmed queue discard/runtime destruction, not only durable history; do not silently promise exactly-once external effects.
3. **Medium: session model switching temporarily changes global defaults.** `applyPiSessionModelSelection()` calls SDK `setModel()`, which writes shared settings before async `model_select` hooks, and restores them afterward. Another session/default edit can observe or race that interval. Existing coverage checks final in-memory/Protected state, not file-backed Standard settings during the hook. Prefer a non-persisting SDK operation or properly isolated settings overlay; preserve global resource discovery separately.
4. **Medium: scheduled timeout excludes runtime creation.** The manager records a running row before awaiting runtime creation, then applies timeout to prompt execution. A hung `session_start` hook can outlive the deadline and block later jobs. Carry one cancellation/deadline fence through creation, but do not declare an active runtime safely stopped before cleanup is proven.
5. **Medium: Agent Teams stop is still a termination request, not awaited exit confirmation.** New escalation corrects the signal-state mistake, but callers needing exact teardown must await exit. Unresponsive sends and no-run states without further evidence still need bounded cancellation semantics. Initial slash-prefixed task text retains Pi command interpretation; changing it to literal text requires a documented contract/SDK change.
6. **Lower priority:** duplicated composer storage/layout work per keystroke; legacy capability activation/revocation names that no longer control derived authority; broader extension type/default-test coverage. Avoid cosmetic churn before the higher-impact state boundaries above.

### Proportionate simplification

- **Reuse the already-approved Protected Automation retirement**, rather than recreating it. Branch `feat/protected-automations-collapse-20260829` at `0acb557` removes 17,534 lines and adds 322 across 86 files relative to its base. A non-checkout `merge-tree` against the audit's committed fixes identifies conflicts in `backend/src/agent-runtime.ts`, `backend/src/app.ts`, and `backend/src/interactive-browser-runtime-injection.test.ts`. That is a tractable reconciliation task, not a justification for another automation framework. Its startup private-state purge is a separate consequential deployment boundary; none was run.
- **Question the global Apps-start veto.** Standard host execution already has unsandboxed same-user authority, while agent Apps start is denied whenever any Protected project exists. This is a deliberate participating-tool safeguard, not containment; its friction should be weighed against accidental-launch protection. Recommend a policy decision before changing it, not silently removing it during an audit.
- **Keep origin/auth checks and human credential/approval boundaries.** VPN and single-user status do not make arbitrary browser-origin requests the owner. The reviewed browser/workspace paths did not reveal an additional approval bypass.
- **Reduce duplicated authority state before adding monitors.** Producer/consumer scheduling drift and projection starvation are concrete examples of correctness costs from duplicated state. Keep one resolver and explicit boundary contracts; isolate inert legacy data from live authorization terminology.

Unanswered owner choices remain whether intentional boundary redesign is authorized and whether additional user-visible feature removals should be implemented rather than recommended. They did not block the narrow fixes above.

## Coverage and limits

| Stream | Examined | Gaps |
|---|---|---|
| Lifecycle | bridge, WebSocket admission/delivery, queue adapter, abort/settlement, runtime setup/shutdown, model switch, pinned prompt/RPC flow | executable preflight/default-isolation reproductions; all third-party hooks |
| Frontend | transcript controller, substantial ChatPanel delivery/model/TTS paths, artifacts, browser ownership, focused E2E | native mobile client; real audio broker; exhaustive render profiling |
| Storage/performance | store commit/startup, projections, search/catalog authorizer, bounded header logic, synthetic operation counts | production-sized synthetic corpus timing; complete artifact/pagination storage review |
| Trust | common HTTP/WS auth/origins, Apps attribution/launch/proxy, browser route/tool binding and handoff, workspace preview/commit, artifact reauthorization | exhaustive browser internals; every platform/provider path |
| Scheduler/integration | run retention/overlap, manager lifecycle, interview delivery/recovery, human-interaction/headless controls | messaging transports, full TTS/title/warmup review, startup-timeout reproduction |
| myPi | companion policy/child guard, team manager/RPC, reports/goals, test/installation drift | exhaustive guard/skill/provider/coordination implementation audit; full-extension static gate |

## Activation, rollback and handoff

Installed for restoration:

- Protected-scheduling compatibility correction and bounded child-read stale retry.
- Previous directories preserved at `~/.pi/backups/agent-teams-scheduling-20260905-9832d7ae/agent-teams` and `~/.pi/backups/agent-teams-child-freshness-20260905/agent-teams`.
- Owner `/reload` enabled the real smoke and delegation. Existing parent manager remains the earlier loaded version; do not claim the new manager is live merely because its source tests passed.

Source-only:

- All Wayang changes, including projection refresh. No backend restart/static deployment.
- New myPi manager lifecycle. Reviewed install plus `/reload` (or a fresh runtime) is required for activation.

Next deployment should integrate the reviewed audit commits into the intended branches, recheck clean current bases, install exact myPi bytes backup-first, and separately approve the Wayang restart/frontend deployment. Preserve divergent branches and active sessions. No remote push is implied.

Rollback is by focused inverse commits before deployment; restoration files have recoverable backups. Writer worktrees are kept for inspection and were not silently deleted or merged into main. Test logs are ephemeral supporting evidence; this report and the project journals carry the durable conclusions.
