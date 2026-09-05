# Wayang/myPi audit: restored delegation and tested corrections

Owner authorized the broad audit and evidenced fixes; restoring subagents was explicitly first priority. After the compatibility correction and owner reload, a real `subagent_dispatch` read smoke succeeded. Six read-only evaluators reviewed lifecycle, frontend, storage/performance, trust, scheduler/integration and myPi. Fresh implementation specialists used separate task branches/worktrees from explicit bases; lead ran tests, reviewed and integrated their commits. Critical Apps and manager/authorization/storage changes received independent source review.

## Consolidated Wayang changes

Audit branch `audit/full-codebase-20260905`, base `b6a0225`, code checkpoint `928e7c6`:

- `993b5f0`: protect active scheduler ownership from terminal-history pruning.
- `0c91769`: WebSocket envelope admission and abort queue/provenance coherence.
- `0e66d95`: one normalized Apps authorization/execution target, conflicting aliases denied.
- `df62563`: model-response selection fencing, page admission-before-epoch, artifact preview loading/abort, current-state TTS buffering.
- `41b8604`: lazy store publication after successful startup, with failing-before/passing-after lock/projection regression.
- `31fcfdd`: first-event policy refresh coalescing, with deterministic failing-before/passing-after starvation regression.
- `928e7c6`: synthetic fsync/header operation-count benchmark and corrected Protected browser authority documentation.

All changes remain source-only in the audit worktree. Main is still clean at `b6a0225`. No backend restart, frontend deployment, remote push, or live state migration/purge.

## Validation and findings

`make check` passes: backend 1166/8 skipped/0 fail, frontend 9, scripts 65; builds/lint complete. Integrated focused E2E passes 14/14. Wider changed specs pass 22/23; the existing repeated-queued-user pagination assertion fails identically on the original frontend/test and remains documented, not weakened. myPi default suite expanded to 92 passing tests; existing check and synthetic tool-ceiling runner/bundles pass, while exploratory whole-team typing still exposes pre-existing drift.

Benchmark found 10/42/82 fsyncs for an unchanged store flush with 1/5/10 eligible Standard pairs, and one read syscall per authorized header byte. No speculative cache was added. Remaining preflight cancellation, queued-interview deduplication, transient global settings, and startup-deadline risks are source-supported follow-up work, not claimed fixes.

Full private report: `docs/audits/2026-09-05-wayang-mypi-audit.md`, including evidence, coverage gaps, validation, rollback and design recommendations. The existing `0acb557` automation-retirement branch has three merge conflicts against this audit, not a need for a second teardown; its destructive startup purge remains a separate deployment boundary.

## Runtime restoration and closure

myPi compatibility fix `1ef31d6` and child freshness retry `9eb1e32` are installed with recoverable backups. Team manager fix `dc5b61d` is source-only; deployed manager differs intentionally until reviewed installation/reload. myPi source checkpoint `9839a84`. No project/profile permissions changed.

Durable handoff: Memoriki `synthesis/wayang-mypi-full-audit-current.md`; reusable extension lifecycle/freshness lessons in `concepts/pi-extension-architecture.md`. Writer worktrees retained for inspection, no unrelated dirty work copied/stashed/overwritten. Lead claims released on completion; older pre-reload lease claims were already absent from the final active-claim listing.
