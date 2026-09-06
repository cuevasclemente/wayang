# Audit follow-up: remaining correctness contracts

## Authorization and starting state

Owner requested: “let's finish up what remains here.” Continue bounded correctness remediation and integration preparation, not live deployment. Earlier child notifications are historical; do not reopen subsequently fixed findings without new evidence.

Explicit consolidated clean bases: Wayang `0b8ba93`, myPi `9bf8b4a`. Existing report: `docs/audits/2026-09-05-wayang-mypi-audit.md`. Wayang main remains `b6a0225`; myPi main is `493e5e1`, with reviewed deployed release `3c3c8f4` already below the audit branch. Preserve root myPi's divergent recovery branch and all unrelated work.

Pinned SDK source commit is `4f7d03ce` in pi-mono. The existing source worktree has unrelated dirty changes; never use/copy/commit those changes. If approved, create a fresh task worktree from the exact commit. No SDK full-release command, live provider probe, install or push.

Owner answered the implementation questionnaire:
- **Approved:** local canonical SDK fixes, focused tests/checks, unpublished artifact build/commit and Wayang/myPi pin updates; installation/restart/push/full release excluded.
- **Selected:** team send cancellation or five-minute waiting deadline detaches only the observer, leaves child execution tracked, and reports eventual output. Explicit stop requests termination and confirmed exit.

Independent source investigation and synthetic regressions continue alongside canonical implementation. Intentional boundary redesign, performance architecture and automation-retirement inclusion were asked separately; default is preservation, not feature removal or private-state purge.

## Invariants and design

### Pending ingress cancellation

SDK idle can coexist with an accepted call awaiting input/auth/compaction/before-agent-start. Record cancellation before the first await and fence stale continuations before queue insertion, message commitment and provider start. Preserve existing queued-work retention behavior. Cancellation requested, preflight drained, active run ended and whole run settled are distinct facts. Do not change isStreaming early or rely on swallowed extension exceptions.

Preferred canonical API repair: ingress cancellation at SDK prompt/run boundary, including custom-message continuation. Wayang abort and scheduled timeouts must use that contract rather than synthesize success before it holds. Reproduce with real SDK, offline provider and gated hooks, then validate fresh post-cancellation prompt success.

### Session-only model selection

Preferred narrow SDK operation: select model with persistence disabled, retaining authentication, transcript model_change, thinking clamping and model_select hooks while skipping provider/model and incidental thinking-default writes. Keep current Standard resource/settings reload semantics. Remove Wayang write-then-restore, not replace it with global in-memory loading accidentally freezing resource discovery.

Test with synthetic file-backed Standard settings during a gated model_select hook, including independent defaults edit, thinking clamp, queue/runtime identity and later reload.

### Interview admission identity

Reserve exact runtime + request + submission identity synchronously before dispatch. Retries reconcile durable tool/custom entries or join existing admission; they must never enqueue merely because an observer timed out. Separate observer deadline from accepted work lifetime. Release ownership exactly once after verified persistence, proven non-admission/exact discard, or completed old-runtime cleanup. Never deduplicate by answer text or evict unresolved records by TTL. Retain existing server provenance and markDelivered validation. This is delivery deduplication, not exactly-once external effects.

Inspect SDK queue/receipt guarantees before choosing the minimal implementation; user-message-only private queue adapter is not proof of custom-message discard. Account for sendCustomMessage itself remaining pending before the existing 30-second clock starts.

### Scheduler startup deadline

Capture one monotonic deadline at acceptance and arm cancellation before runtime creation. Fence late runtime publication and prompt dispatch; use remaining time rather than restart the timeout after creation. Expired budget is never interpreted as disabled timeout. Preserve current runtime generation fences and prompt-timeout cleanup ordering.

Uncooperative in-process hooks cannot be forcibly terminated safely. While cleanup remains unproven, retain running/overlap ownership and bounded actionable cleanup-pending status. Independent jobs should remain usable. Never report success merely because abort or a signal was sent; do not solve this with another scheduler framework.

### Agent Teams lifecycle and checks

After owner chooses semantics, forward send cancellation and implement one waiter cleanup path for completion/error/abort/deadline/write failure. Preserve prompt/run ownership independently from the observer if detaching. Confirm stop only after actual exit/required closure, fence in-flight spawn against shutdown, attempt every child's cleanup, and surface unresolved teardown explicitly.

Independent safe task: add whole-team static coverage and fix actual SDK typing drift without broad casts, invented aggregate context counts, or weakening error semantics. Preserve slash-command behavior. Add direct pinned-SDK RPC acceptance/no-run/settlement contract tests in addition to existing manager mocks.

## Agent roles and isolation

1. SDK contract reviewer (read-only completed); fresh regression writer owns a new Wayang SDK-contract test file. Canonical SDK implementation gets its own pi-mono worktree only after approval.
2. Delivery/deadline reviewer (read-only completed); regression writer owns new focused helper/test files in a separate Wayang worktree. Lead exclusively integrates bridge call sites; no concurrent pi-bridge.ts writers.
3. Teams reviewer (read-only completed); typing writer owns myPi index/tests/check configuration in a fresh worktree. Lifecycle writer gets a separate worktree after cancellation decision.
4. Lead owns plan, branch integration, command execution under real tool ceilings, hermetic tests, and final evidence/report. Independent review of SDK cancellation, delivery ownership and scheduler cleanup before integration.

Every delegated role reports concise future-value wiki lessons to lead, never writes memory or activates live state. No shell/direct-agent workaround for denied child tools.

## Milestones and validation

- [x] Confirm clean bases, current source mechanisms and historical-versus-current findings; make doctor passes (expected absent synthetic .env warning).
- [x] Add real-SDK and delivery/deadline regressions; record failing baseline before implementation.
- [x] Resolve exact SDK/build and send-cancellation authority choices; record answers here.
- [x] Implement contracts with red/green tests and independent reviews, including retained cleanup receipts, shared/reentrant ownership and real browser composition.
- [x] Run Wayang make check (backend1278/8skip/0fail, frontend9, scripts67), myPi123 plus complete team typing/ceiling smoke, SDK116/2skip pluscore2 and fullcheck/offlinebuild, and60/60 selected E2E.
- [x] Correct baseline cancellation-test framing against actual server contract, preserving stale/wrong-selection rejection; original separate pagination-order failure is not claimed fixed.
- [x] Update findings report and project journals; complete wiki closeout.
- [x] Owner approved all-three local-main integration; completed checked fast-forwards of Wayang/myPi and Pi merge363cef07 preserving existing main metadata. Combined Pi full check and focused SDK/core/metadata tests pass; package-tree comparisons and sampled runtime hashes verify preservation. No deployment approval inferred; no canonical install/build/restart/push.

Final source report: `docs/audits/2026-09-06-wayang-mypi-followup.md`. Pi source29082030; Wayang codecheckpoint da8b539 (includes main eaa7da5 via5592a98); myPi codecheckpoint0a75171. The later frontend echo deployment was performed independently, not by this follow-up. Source SDK and core artifacts were paired and actual resolution tested; only audit dependency directories were updated.

## Rollback and deferrals

Keep every writer in a separate branch/worktree from the explicit bases above. Stage only owned paths. Retain previous SDK tarball and documented pin until replacement is verified; source-only inverse commits provide rollback. No cleanup of unrelated worktrees.

No backend/frontend deployment, installed extension overwrite, service restart, remote publication, private-store migration/purge, new external effects, or intentional privacy/approval weakening. Performance redesign and already-approved automation retirement remain separately scoped until owner answers; regression/performance evidence can inform that choice without implementing it.
