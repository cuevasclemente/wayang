# Wayang/myPi audit follow-up — validated source delivery

Date: 2026-09-06. Private maintainer report. Follows `2026-09-05-wayang-mypi-audit.md`.

## Result and activation boundary

The remaining prioritized correctness findings from the initial audit are implemented, independently reviewed, and validated together. These are source changes, not a production deployment.

Owner explicitly approved local canonical Pi changes, focused checks/tests, unpublished artifact builds/commits and downstream pins. Owner selected **wait-only** cancellation for `subagent_send`: cancelling or reaching its five-minute deadline detaches the observer, retains child execution/ownership, and permits later reporting. Explicit stop requests termination and confirms exit/stream closure, or reports bounded failure while retaining unresolved ownership.

A separate questionnaire asks whether to integrate all three local main branches. At this report checkpoint that decision is pending. No canonical dependency install/build, installed-extension update, service restart, remote push, or private-state purge was performed during this follow-up.

## What changed

### Canonical Pi SDK and core

Reviewed source commit **`29082030485150d0eed76c23b411116512932ee9`**, branch `fix/audit-ingress-model-contracts-20260905`, worktree `/home/clemente/src/pi-mono-worktrees/audit-ingress-model-contracts-20260905`, explicit base `4f7d03ce`.

- Cancellation fences awaited prompt input/authentication/pre-start and automatic continuations before stale context or inference can commit.
- `pendingPromptCount` and snapshot `waitForPendingPrompts()` expose invocation drainage separately from run-only idle/abort. External owners deny new ingress before draining; a hook must not await its own invocation.
- `setModel(model, { persist: false })` preserves authentication, transcript changes, thinking clamp and hooks without writing deployment provider/model/thinking defaults. Ordinary CLI persistence remains the default.
- Core queue clearing returns exact removed objects. SDK clear callbacks distinguish discarded custom messages from already-dequeued work and retained next-turn asides.
- Retry bookkeeping now belongs to the entire run, including synchronous notification reentrancy and the controller-free asynchronous handoff. Cleanup state is finalized before observers or replacement ownership.
- Automatic compaction observer failures after commitment no longer fabricate a second failed/aborted result.

Both packages are required. The audit's actual SDK factory test proves it uses the application-pinned core rather than a nested older copy.

| Artifact | SHA-256 |
|---|---|
| `earendil-works-pi-coding-agent-0.84.1-wayang.29082030.tgz` | `e5a28970f23e5cd0e352848061a0c8e7636174de0a76bb0e0a11749031182f01` |
| `earendil-works-pi-agent-core-0.84.1-wayang.29082030.tgz` | `fee12fdb40ad9a5e2b20ff1ff17d629a6564467b67900356effdd49e96c7b7f7` |

Core retains upstream package version `0.84.1`; immutable filenames and source markers identify the reviewed bytes. `scripts/vendor-pi-artifacts.py` packs already-built clean source without install/publish, refuses different existing artifacts and symlink destinations, and produced byte-identical repeated outputs. Its synthetic tests preserve package runtime bytes and check source/version metadata and overwrite boundaries.

The existing frozen Pi AI artifact was preserved. Its 39 public provider-file hashes verified; only an extracted build-input manifest's stale aggregate structure hash was corrected using the unchanged validator. No provider data was refreshed from the web or taken from unrelated dirty source.

### Wayang

Consolidated branch `audit/full-codebase-20260905`, code checkpoint **`da8b539`**:

- **`888e48f`**: paired SDK/core pins, reproducible packer and dependency-resolution contract.
- **`d175c58`**: exact runtime/request/submission admission ledger. Observation deadlines cannot re-enqueue accepted interviews. Verified persistence, exact discard or successful disposal releases ownership; ambiguous errors do not. Persistence observation follows SDK append ordering and uses no admission polling loop.
- **`4f6f666`**: integrated bridge cancellation/drainage, exact cleanup reservations, browser snapshots and scheduler deadlines. Incorporates reviewed writer changes from `793aa13`, `72b8543` and `6d511e6`.
- Cleanup reservations are private and generation-bound. Error objects act as validated opaque receipts, with fixed content-free errors. Initial and reentrant callers share confirmation; failed partial SDK/closer/disposer state is retained. Explicit retry repeats only unfinished captured operations, never startup or a later ID lookup.
- Standard browser cleanup freezes exact host/workspace generation/lease targets before callbacks. Runtime adapters reuse that snapshot, including retries; older cleanup cannot close a replacement workspace.
- One scheduler deadline starts at acceptance, before runtime creation. Expired budget never means disabled timeout. Unconfirmed cleanup retains running/overlap ownership; exact receipt confirmation rechecks the linked running row before terminalization. There is no busy retry loop or implicit job replay.
- **`5592a98`** incorporates the independently deployed optimistic-echo fix from main (`35af5c5` / `eaa7da5`), preserving the other session's work.
- **`da8b539`** repairs a stale E2E fixture: cancellation replies lacked the server's session/selection envelope and were correctly rejected by unchanged frontend guards. Failure was reproduced on main first. The corrected fixture preserves stale-socket checks and adds explicit wrong-selection rejection.

### myPi

Consolidated branch `audit/full-codebase-20260905`, code checkpoint **`0a75171`**:

- **`dc72054`**: whole-Agent-Teams strict typecheck in default checks; real content-union, notification, goal and aggregate-usage contracts with regression coverage.
- **`a37b46c`**, **`75ea8e0`**: wait-only send cancellation/deadline, correlated asynchronous write failures, exactly one notification attempt, confirmed stop, in-flight spawn fencing and family-stop ownership. A reclaimed parent process record cannot erase its outstanding family outcome. Explicit stop is never reported as ordinary idle completion.
- **`cd1cbc3`**: paired SDK/core pins and corrected README reference.
- **`341affc`**: real offline SDK RPC subprocess tests, not manufactured RPC handlers/events. They verify acceptance, retry attempt ends, delayed settlement and legitimate no-run commands/input.
- **`0a75171`**: truthful tool descriptions and smoke fixtures. Cold startup gets 15 seconds; protocol gates retain five-second deadlines. The ceiling harness uses real TypeBox validation and no longer leaks a background fake `sleep` process that held pipes open. Production teardown strictness was not relaxed.

## Validation

- **Wayang full `make check`, including latest main:** backend **1,278 passed / 8 skipped / 0 failed**; frontend **9 passed**; scripts **67 passed**; builds/lint complete.
- **Integrated focused backend selection:** **226 passed**, covering SDK pairing, model defaults, bridge, interview ownership, scheduler and browser service/host behavior.
- **Selected E2E:** **60/60 passed** across artifacts, transcript controller, workspace/model/TTS, echo reconciliation, compaction queue, queued cancellation, durable interviews/cancellation and browser workbench.
- **myPi:** default tests **123 passed**; default check now includes complete Agent Teams typing; synthetic tool-ceiling harness passes.
- **Pi:** seven focused SDK files **116 passed / 2 pre-existing skips**, plus **2 core queue tests**; full `npm run check` and offline build pass. The 38 new SDK contract cases include both independently discovered retry-cancellation gaps.

A cold RPC-fixture startup exceeded its original five-second budget while the full repository/browser gates ran concurrently. Only startup allowance changed; protocol assertions, watchdogs, cleanup confirmation and cancellation tests remain enforced. Existing lint/bundle-size and Node deprecation warnings remain.

The older pagination-order E2E failure documented in the initial audit and peer journal is outside this 60-test selection; it is not claimed fixed. No production provider/browser/account workflow or private transcript/profile fixture was used.

## Remaining decisions and limitations

- Local-main integration is separately awaiting the open owner questionnaire; installation/restart/deployment remains excluded regardless of that answer.
- Performance architecture and inclusion of the previously approved automation retirement were asked but not selected in this follow-up. No feature removal, authority redesign or startup private-state purge was performed. Original measured fsync/header costs and retirement conflicts remain in the initial report.
- Uncooperative hooks or unconfirmed cleanup may intentionally retain ownership until recovery. These are cooperative logical-authority and local lifecycle contracts—not proof of hostile-process containment, remote-effect rollback, or every best-effort viewer/download transport terminating.
- The scheduler's internal same-process stop/start stale-row handling was noted as a further unexecuted embedding edge; production startup currently calls it once per server process. No general scheduler redesign is claimed.
- Parent integration worktrees are the delivery sources. Writer and baseline evidence worktrees are retained; do not install arbitrary intermediate branches. Original artifacts remain available for rollback, and the original myPi recovery checkout was not moved.

## Durable handoff

Plan: `docs/plans/2026-09-05-audit-followup.md`.
Journals: Wayang `docs/journals/2026-09-06-audit-followup.md`; myPi audit `docs/journals/2026-09-06-audit-followup.md`; Pi source `docs/journals/2026-09-05-wayang-runtime-contracts.md`.
Memoriki: `synthesis/wayang-mypi-full-audit-current.md` and `concepts/pi-extension-architecture.md`.
