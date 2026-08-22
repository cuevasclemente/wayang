# Peer-session messaging planning revision report

**Date:** 2026-08-21
**Result:** architecture revised; implementation remains unauthorized and blocked on audited Standard interop plus a separate approved privacy artifact
**Plan:** `docs/plans/2026-08-21-peer-session-messaging-architecture.md`

## Summary

The plan is now aligned to the current Wayang/Pi source boundaries rather than extending the existing connector implementation by analogy. The peer protocol has its own canonical private SQLite database; Pi JSONL and frontend events are explicitly derived projections. M1 is strictly peer SQLite/mailbox/inbox only. In M2, the universal all-ingress per-session arbiter and executable pinned-Pi proof that durable custom-message append can be separated from provider dispatch must both be complete and reviewed before any peer Pi projection or target turn. Ambiguous provider execution is never automatically replayed.

No implementation, deployment, transcript/private-data inspection, privacy-policy mutation, cherry-pick, dependency absorption, or commit was performed.

## Review blocker disposition

1. **Protocol/Pi projection:** fixed canonical `peer_request`/`peer_reply` kinds and `wayang-peer-request-v1`/`wayang-peer-reply-v1` custom messages; fixed escaped canonical-JSON provider frame; `details` is non-authoritative; M1 has no Pi projection, and provider/branch/compaction feasibility runs behind the ordered M2 gate.
2. **Canonical state/tree/mutation:** peer DB owns mailbox sequence and state; Pi/frontend are projections; protocol projection edits are rejected; abandoned branches keep independent inbox state and allow explicit non-dispatching reprojection.
3. **Sender authority:** tools are backend-created closures bound to exact session/runtime generation/Project/Profile; no sender fields or generic HTTP; human inbox actor is separate; target/reply choices are opaque, expiring, and single-use.
4. **Turn arbitration:** one per-session arbiter covers browser messages/steering, peer, connectors, compaction/branching, transcript mutation/purge, model/profile switches, runtime transitions, and scheduled existing-session work, with priority, ordered locks, cancellation, approval behavior, crash fencing, and fairness.
5. **Storage:** dedicated owner-private SQLite with WAL, migrations, migration checksums, permissions, integrity/logical validation, consistent backups, crash recovery, retention, and non-destructive rollback rules; not `search.db` or `store.json`.
6. **Pi dispatch ambiguity:** M2 first completes the universal all-ingress arbiter and proves/adds split append/dispatch against the pinned repository artifact before any projection or turn; marker and settled-range contracts cover retries, provider errors, tool-only turns, overflow, disconnects, and reply-commit crashes; ambiguous attempts terminate without replay.
7. **Approvals:** initial peer attempts requiring approval/PIN/sudo/questionnaire/browser/secret input end `continue_in_wayang`; sender never sees or answers a PIN. Durable remote approval is separate deferred scope.
8. **Attachments:** M4 requires a durable object catalog with stable IDs, source/privacy bindings, hash/size, tombstones/refcounts, and descriptor no-follow revalidation. Current process-local registry and prompt paths are explicitly forbidden.
9. **Archive/purge:** archived targets are denied and non-wakeable initially. A multi-session purge coordinator uses global/full-session ordered locks and content-free recovery journals across peer DB, Pi projections/summaries, catalog, search indexes, attachments, and quotas; completion semantics exclude secure erasure/provider/backups.
10. **Quotas:** auto-run atomically reserves model/context-derived token input/output, tool calls, wakes, causal-root totals, source/target day totals, and global day limits. Settlement releases unused capacity; missing/invalid usage or ambiguous work charges conservatively; unavailable metadata/enforcement denies metered auto-run.

## Retained product/privacy choices

- Initial privacy scope is Standard-to-Standard only; Protected, quarantined, privacy-unknown, and unresolved legacy sessions fail closed.
- Target execution uses only target-owned authority.
- Inbox state is durable and independent of target runtime/Pi branch.
- Same-project precedes cross-project. Cross-project rollout is always M5 and requires a separate approval even if the privacy artifact permits it.
- Idle auto-wake is M3 and requires separate authorization; no wake exists in M1.
- Attachments remain read-only Standard references and are unavailable before M4/catalog readiness.
- Planning does not authorize implementation.

## Mandatory dependency disposition

### Standard interop code dependency

The peer plan now depends explicitly on unmerged Standard interop commit `89f322a`, but may not reimplement, cherry-pick, copy, absorb, or patch that work in peer scope. It remains blocked by two durable audit findings:

- **SI-1:** catalog discovery must reconcile durable row/canonical path/transcript header and deny quarantined, unclassified/unknown, or project-conflicting sessions before body parse; quarantine is eligible only when exactly false. The same bindings and eligibility must be rechecked immediately before commit. Denial/race regressions must prove `parseBytes = 0`.
- **SI-2:** `session_read` needs a total processed-byte bound and cursor/resume contract, with a high-offset/large-prefix regression proving bounded total scan work rather than only bounded returned bytes.

Required completion evidence remains pending: an independently reviewed successor fix commit, the exact final merged SHA, focused SI-1/SI-2 tests, full repository test/check evidence, and deployment plus live verification. Commit `89f322a` alone is not sufficient.

### Privacy decision artifact dependency

Separately, a final revisioned and explicitly approved artifact must define Standard/Protected read rules, attachment read/reference rules, and provider-retention/disclosure rules. Draft policy or completion of the interop code dependency does not satisfy this gate. No milestone, including M0, may start before both dependencies are complete; M0 then still requires explicit approval.

## Updated rollout

- **M0:** only after both dependencies and explicit M0 approval; freeze protocol/framing/state machine, build the dedicated peer DB foundation, and freeze (not deploy) the M2 Pi feasibility corpus. No inbox rollout, Pi projection, invocation, or turn.
- **M1:** authenticated human inbox and sender-bound same-project Standard mailbox admission backed strictly by peer SQLite; no manual/automatic Pi projection, provider invocation, target turn, or wake.
- **M2:** first complete/review the universal all-ingress arbiter and split Pi append/dispatch plus branch/compaction feasibility; only then permit running-target projection/turn with exact quotas and no ambiguous replay.
- **M3:** idle auto-wake only under a separate post-M2 approval, with wake/root/day controls and operational pause/rollback.
- **M4:** attachments only under a separate approval after the general durable object catalog passes security/privacy/purge gates.
- **M5:** cross-project Standard only under a separate approval and pair-allowlist rollout, even if the privacy artifact permits it.

## Source evidence used

- `backend/src/db.ts`: current single-writer versioned `store.json` includes connector messaging rows.
- `backend/src/messaging/store.ts` and `session-port.ts`: connector state/retry patterns and current recovery reliance on Pi custom-message details.
- `backend/src/pi-bridge.ts`, `routes/ws.ts`, `session-runtime-mutation-lock.ts`, and `queued-chat-messages.ts`: current runtime, ingress, compaction/mutation, and pinned private queue seams.
- `backend/src/attachments.ts`: process-local attachment registry and raw prompt-path projection.
- `backend/src/transcript-mutations.ts` and `docs/transcript-event-mutations.md`: canonical JSONL mutation, runtime/search fences, recovery markers, and summary invalidation.
- Pi `README.md`, `docs/session-format.md`, and `docs/compaction.md`: JSONL tree, branch-local context, provider-visible `custom_message.content`, non-context/metadata treatment of details, and lossy compaction/branch summaries.
- `README.md`, `SECURITY.md`, `docs/configuration.md`, and `docs/connector-neutral-messaging-gateway.md`: Wayang’s single-user threat model, Project/Profile authority, connector separation, and current persistence/privacy contracts.

## Open gates, not design gaps

1. Standard interop successor fixing SI-1/SI-2, independent review, exact final merged SHA, focused/full tests, deployment, and live verification.
2. Final revisioned privacy decision artifact for Standard/Protected reads, attachments, and provider retention/disclosure, with explicit approval.
3. Explicit M0 implementation authorization after both dependencies.
4. Executable pinned-provider framing proof.
5. M2 universal all-ingress arbiter completion before projection/turn.
6. Pinned-Pi split append/dispatch, provider-start/settlement, and branch/compaction preservation feasibility.
7. Durable attachment catalog implementation/review plus separate M4 approval.
8. Separate M3 auto-wake and M5 cross-project approvals.

No repository checks were run because this assignment was documentation-only and the worker had no authorized command-execution surface. The implementation orchestrator must run the plan’s checks after implementation is authorized.
