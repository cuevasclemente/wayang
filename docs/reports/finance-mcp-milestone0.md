# Finance MCP self-service onboarding — Milestone 0 report

Date: 2026-07-24
Overall decision: **GO — synthetic Milestone 0 feasibility only**

This report covers synthetic security-feasibility work only. No Monarch or PocketSmith code, credential, endpoint, financial record, provider request, brokerage call, Exa query, MemPalace content operation, or financial mutation was used.

## Scoped results

### PIN approval authority — GO for synthetic single-process sub-gate

- Durable PIN-attempt reservation precedes challenge emission.
- One realm-wide pending challenge; global and per-session five-attempt/15-minute limits; durable exponential cooldown.
- Exact preview, manifest/view, session/runtime/profile/project/invocation, current owner-object identity, expiry, and binding revalidation.
- Owner replacement/disconnect consumes old previews and pending reservations.
- Explicit one-time cooldown-state initialization; missing/deleted state fails closed on restart.
- PIN/state files require private parents, exact mode 0600, regular single-link files, and no-follow opens.
- Externally visible denial is generic.

Focused approval-authority tests: **45/45 pass**. Independent scoped review: **GO**.

### Actual-loopback WebSocket feasibility — GO for test-only adapter

A test-only adapter on a real `127.0.0.1` HTTP/WebSocket server uses the production `AuthService` authorization decision but installs no production route.

- Auth enabled: missing/forged cookie and wrong Host/Origin are denied; a synthetic authenticated socket can answer one exact challenge.
- Passwordless: a local agent can forge allowed Host/Origin, nominate a source session, replace the current transport owner, and cause denial of service. Therefore transport/browser ownership is **not** authority.
- Correct approval still requires exact in-process connection identity, exact binding, durable reservation/cooldown, and the PIN.
- Copied IDs, wrong socket, wrong PIN, ordered guess bursts, replay, binding drift, old tabs, and cancelled prompts cannot approve.
- PIN/password/candidates are absent from wire challenges/results and inspected durable stores; transient JS memory residency remains unavoidable and unproven UI/log surfaces remain later work.

Actual-loopback adapter tests: **5/5 pass**. Independent scoped review: **GO**.

### Invocation-scoped typed broker — GO for synthetic state-machine sub-gate

- Frozen child facade exposes dispatch/cancel only and is bound to a transport-owned object identity.
- Exact source session, runtime, release, grant, eligibility, tool, operation, canonical arguments, and deadline.
- One operation per invocation; initialize/list/smoke/idle have no provider authority.
- Epoch plus monotonic deadlines, post-await result fencing, cancellation, and draining prevent reissue while an abort-ignoring executor remains live.
- Stale/mismatched IDs cannot consume newer authority; production IDs use process nonce plus monotonic counter.
- Schema bounds, safe revision arithmetic, duplicate-key rejection, immutable snapshots, and normalized executor failures/results.

Focused broker tests: **14/14 pass**. Independent scoped review: **GO**.

### Proxy-free sandbox and FD3/FD4 transport — GO for exact nested synthetic sub-gate

- Linux x86-64 only; exact SRT `0.0.65` and bwrap `0.11.2` deployment hashes.
- Shell-free/proxy-free chain using pinned static SRT seccomp helper, static direction shim, and static workload.
- Empty tmpfs root; no host-root bind; only read-only `/work`, exclusively created private `/scratch` as the sole persistent read-write bind, fresh namespaced `/proc`, and minimal `/dev`.
- `/etc`, `/home`, `/var`, and `/sys` absent; absolute helper arguments outside work/scratch rejected; writes outside scratch denied.
- Workload proves `CapEff=0`, `no_new_privs`, seccomp filter mode, and denied `/proc/self/setgroups` mutation. Attempts to remount `/proc` after or around SRT failed closed because mount capability was already dropped; the active design retains only the fresh nonpersistent namespaced proc required by SRT.
- Trusted pre-exec shim irreversibly makes FD3 child-write/broker-read and FD4 broker-write/child-read. Parent and workload verify half-close behavior, exact FD inventory, EOF propagation, and Node half-open behavior.
- Distinct network namespace plus controlled live IPv4/IPv6 TCP/UDP listeners and zero host delivery. Child `AF_UNIX` creation is denied with exact EPERM; controlled host Unix listeners were unavailable in the enclosing Wayang sandbox, so normal-host attribution remains pending.
- Bounded framing covers fragmentation, partial response/request, paused reader, zero length, oversized header, early EOF, response EOF, and teardown.
- A setsid/double-fork descendant first proves scratch writability, then waits for a host trigger created after bwrap exit; no escape marker appears.

Focused sandbox/RPC tests: **9/9 pass**. Independent scoped review: **GO**.

### Nested containment fixture — evidence only, not host GO

The revised nested hostile-tree fixture passed **3/3** and intentionally exited 3:

- hostile fixture started;
- setsid/double-fork descendants outlived process-group termination;
- exact PID/start-time cleanup removed them.

This does not prove systemd user scopes, cgroup v2 delegation/limits, normal-host filesystem behavior, or host process-tree cleanup.

## Validation record

Combined focused run:

- approval authority: 45
- invocation broker: 14
- sandbox/RPC: 9
- total: **68/68 pass** in the combined core run
- actual-loopback adapter: **5/5 pass**
- all focused Milestone 0 tests: **73/73 pass**
- backend TypeScript build: **pass**

The full gate was attempted in the nested Wayang agent sandbox. All Milestone 0 and restricted-MCP tests passed, but four unrelated Browser/credential tests failed because the enclosing sandbox forbids AF_UNIX listeners and cannot launch their nested Chromium fixture; two existing sandbox tests skipped for the same outer restriction. The script unlock-socket test likewise failed only at AF_UNIX `listen(2)`. Environment-independent results:

- backend build: pass;
- frontend lint: 0 errors, one pre-existing Fast Refresh warning;
- frontend production build: pass;
- script tests: 9/10, with the sole AF_UNIX-listener failure above;
- focused Milestone 0 tests: pass;
- normal-host containment: 13/13, exact GO summary, exit 0.

A current `make doctor` completed with 0 failures and one expected nested-overlay warning that `.env` appears mode 0666; the previously verified normal-host file is mode 0600. A normal-host `make check` and `make test-e2e` remain required for the environment-bound release gate. Existing dirty worktrees were preserved.

## Dirty-worktree reconciliation

The Wayang tree was already heavily dirty before Milestone 0 and was not reset, cleaned, or committed. Current relevant status includes modified `backend/src/pi-bridge.ts` and untracked `backend/src/agent-runtime.ts`, its tests, the restricted-MCP subtree, `scripts/milestone0/`, and `docs/reports/`. The ignored `docs/plans/finance-self-service-mcp-onboarding.md` remains deliberately preserved. Unrelated dirty files were not altered for reconciliation.

The original private SHA-256 review manifest is intentionally not published: it names removed prototype files and an internal planning document, and its hashes predate public-path sanitization. The two proc-gate C files it referenced were rejected comment-only experiment tombstones and were never imported, compiled, or launched. This archived narrative records the historical review outcome but is not a reproducible manifest for the current tree.

## Legacy Wren MCP regression and correction

Final metadata preparation exposed a regression: `agent-runtime.ts` reserved the generic `mcp` name for Standard and restricted profiles alike, filtering Wren's pre-existing Pi MCP adapter. The corrected policy permits the ordinary adapter for Standard profiles (including scheduled Wren runs) while restricted profiles still require the exact backend-issued source-bound object; restricted scheduled, counterfeit, replaced, or revoked proxies remain denied. Focused runtime tests pass 13/13, Pi-bridge/restricted suites pass 23/23, backend build passes, and independent security review issued GO. Deployment restart and fresh-runtime metadata verification remain pending.

## Final prerequisites for overall Milestone 0

1. **Normal-host containment proof — satisfied**
   - After four fail-closed oracle-improvement runs, the final reviewed run passed all 13 checks with exact `SUMMARY pass=13 fail=0 decision=GO-TESTED-PRIMITIVES` and exit 0.
   - Evidence and exact scope are in `docs/reports/finance-mcp-milestone0-containment.md`.

2. **Finance directory mode — satisfied**
   - The maintainer corrected and verified the configured private Finance directory as mode `0700` and owned by the Wayang OS user.

3. **Fresh Finance Exa metadata prerequisite — satisfied**
   - The maintainer confirmed a fresh Finance runtime exposes exactly `web_search_exa` and `web_fetch_exa` without invoking either tool.

4. **Wren legacy MCP behavior — satisfied**
   - After the Standard-profile policy correction and service restart, the maintainer confirmed a fresh Wren runtime can use its ordinary MCP adapter again.

5. **Current-tree normal-host release gate — satisfied**
   - The maintainer reported `make doctor` exit 0, `make check` exit 0, and `make test-e2e` exit 0 with 27 E2E tests passing.

All Milestone 0 prerequisites and acceptance gates are satisfied. Final decision: **GO for the tested synthetic feasibility boundaries only**. Failure of any normal-host property must stop the project; no weaker sandbox, descriptor, cgroup, approval, or broker fallback is allowed.

## Explicit deferrals

This Milestone 0 GO authorizes closing the synthetic feasibility phase and beginning the separately authorized Milestone 1 proposal/catalog/PIN-approval control-plane implementation. It does not authorize real Monarch code execution, credentials, staging, activation, provider access, financial-data reads, category/tag/note changes, or PocketSmith activation. Production route integration, cross-process approval transactions, typed durable phase transitions, source-controlled release building, credential brokering, receipts/quotas, and full adversarial rollout review remain later milestones.
