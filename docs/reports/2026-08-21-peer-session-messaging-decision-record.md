# Peer-session messaging decision record

**Date:** 2026-08-21  
**Status:** Product direction recorded; implementation not authorized and no milestone may start until both mandatory dependencies are complete

Clemente selected the following intended Wayang behavior:

1. The intended end state allows a **Standard** session to send a direct request to another **Standard** session, including across projects, but M1 is same-project mailbox/inbox only and cross-project rollout is deferred to separately approved M5.
2. The intended end state may automatically wake an idle, resumable target, but M1 has no Pi projection or invocation, M2 initially permits only already-running target turns after its internal gates, and auto-wake is deferred to separately approved M3.
3. Peer requests and replies are first-class attributed events (`peer_request` and `peer_reply`), never forged human (`user`) or `system` events.
4. Execution uses only the target's project, profile, instructions, tools, credentials, provider, quotas, command guard, and newly obtained target-side approvals. Sender or prior human approvals are not inherited.
5. Standard attachment sharing is read-only by reference, with no byte copying.
6. **Protected** crossings are denied in both directions and must fail closed at send, receive, wake, attachment resolution, retry/replay, and reply. Unknown or stale policy also denies.
7. The provisional product direction would make privacy mode the visibility boundary, with Standard transcripts cross-session readable/read-only and Standard attachments read-only through reviewed tools/APIs and controlled exact-file reads. This is not governing policy until the separate final revisioned privacy decision artifact defines Standard/Protected reads, attachments, and provider retention/disclosure and is explicitly approved.
8. mypi `.pi/coordination` room broadcasts and claims remain advisory. Direct invocation is durable Wayang database state.

The detailed design is in [`docs/plans/2026-08-21-peer-session-messaging-architecture.md`](../plans/2026-08-21-peer-session-messaging-architecture.md).

## Mandatory dependencies

### 1. Standard interop branch

Peer implementation depends on the unmerged Standard interop branch at commit `89f322a`. Peer scope must not reimplement, cherry-pick, copy, absorb, or independently patch it. Commit `89f322a` is not the final dependency because review found two durable blockers:

- **SI-1:** the catalog must reconcile the durable row, canonical path, and transcript header and deny quarantined, unclassified/unknown, or project-conflicting sessions before body parse. Quarantine is exact-false: only `quarantined === false` is eligible. The same eligibility/bindings must be rechecked immediately before commit, with denied/conflict/race tests proving `parseBytes = 0`.
- **SI-2:** `session_read` must enforce a total processed-byte bound with a resumable cursor, including a high-offset/large-prefix regression proving bounded total scan work.

The dependency gate requires an independently reviewed successor fix commit, the exact final merged SHA, focused SI-1/SI-2 test evidence, full repository test/check evidence, deployment evidence, and live verification. All remain `PENDING`; no peer milestone may consume the branch before the complete record is approved.

### 2. Privacy decision artifact

Separately, the privacy work associated with session `4bf6a8e4-820a-4656-833d-8bbbe601de7f` must produce a final revisioned and explicitly approved decision artifact defining Standard/Protected read rules, attachment read/reference rules, and provider-retention/disclosure rules. Draft policy, code behavior, or completion of the Standard interop branch does not substitute for this artifact. Artifact revision/approval: `PENDING`.

## Staged authorization decision

- **M0:** may begin only after both dependencies are complete and Clemente explicitly approves M0.
- **M1:** strictly peer SQLite/mailbox/inbox only; no Pi projection, provider invocation, target turn, or wake.
- **M2:** must first complete/review the universal all-ingress arbiter and split Pi append/dispatch plus branch/compaction feasibility before any projection or target turn; running targets only afterward.
- **M3:** idle auto-wake requires a separate post-M2 approval.
- **M4:** attachments require a separate approval after the durable catalog evidence.
- **M5:** cross-project Standard requires a separate approval even if the privacy artifact permits it.

**This record and the plan authorize documentation and review only. They do not authorize code implementation, provider calls, use of real transcript or attachment content, policy mutation, dependency cherry-picking/absorption, deployment, or rollout. Dependency completion does not authorize M0; Clemente must explicitly approve it, and M3/M4/M5 retain their separate approvals.**
