# Keyword search and sustainable indexing — source implementation

## Scope and owner decisions

Source implementation/validation approved September 6; duplicate questionnaire delivery treated idempotently. Owner accepts several minutes of freshness lag to minimize background load. Quoted phrases are optional matching units alongside independent words; distinct-unit session coverage ranks first. Deployment, canonical merge, service restart, live migration/backfill and catalog recovery remain unapproved.

Task worktree: `/home/clemente/src/wayang-worktrees/search-relevance-recovery-20260907`, branch `plan/search-relevance-recovery-20260907`, explicit base `6b2f749f9ecac24db8f68a825458405ca1cdd912`. Query and pipeline writers used separate worktrees/branches, produced focused commits integrated by the lead, and had no production-data access. A separate read-only reviewer challenged authorization, resources and lifecycle behavior through several fix/review rounds.

Canonical main advanced independently to `fc0a8de` (TTS changes) during this work. That peer work was not altered or merged into this candidate; any promotion needs an explicit latest-main integration gate. Canonical checkout is clean. The original missing-target authorization denial remains unresolved; it was not bypassed or attributed solely to backlog.

## Delivered

- Literal bounded parser with actual SQLite tokenizer deduplication; optional phrase/word OR admission, session-wide distinct-unit coverage, lexical/indexed-recency/stable-ID tie breaks, filters and exact message anchors. No implicit prefix matching.
- SQL aggregates sessions before limits, selects best chunks only for top sessions, and keeps complete facets. UI preserves cross-project ranking instead of regrouping by project recency.
- Independent metadata projection, revision-bound structural offsets, one extraction worker, coalescing priority queue, gradual yielded discovery, conservative recent debounce and background cooldown, durable typed outcomes/retries, bounded generation staging/flip/cleanup and additive schema 4.
- Exact published file/revision witnesses gate body results before aggregation. Legacy bodies lack proof and stay hidden until rebuilt; authorized current-presentation legacy metadata is retained. Stale title/goal/archive/model metadata excludes that session, not the whole query.
- Production SQL executes in a bounded disposable read-only child. Child snapshot attestation, whole-response discard/retry and main-process reauthorization protect snippets and facets. Final validation and HTTP release are synchronous in the same stack; sending a returned promise result is expressly not release-authorized.
- Paused/incomplete/unavailable warnings including zero results; useful fixed syntax/operational errors; last-observed coverage plus fresh rejection aggregates and queue/publication metrics.
- Stop/drain across queue and batch producers; exact recovery receipts and synchronous publication acknowledgement before marker clearance. Partial coverage cannot clear a mutation recovery marker.
- Updated operator guide `docs/session-history-search.md`, implementation plan, synthetic diagnostics and focused regressions.

## Review findings fixed

Stale indexed body under current-file authorization; detached-body metadata-only admission; stopped producers reopening SQLite; hours-long discovery cadence; unsafe cross-mode structural worker joining; tokenizer-equivalent units inflating coverage; ordinary/duplicate successors invalidating recovery success; metadata repair not invalidating negative cache; transient structural staleness cached as unsupported; asynchronous microtask gaps between authorization and actual transport release.

Final independent source review found no further concrete blockers in its inspected scope. This is source review plus lead-run tests, not a claim of production validation or formal isolation.

## Validation

- Canonical `make doctor`: 0 failures/warnings. Isolated worktrees correctly lack private `.env`; no private config copied. Installed exact locked backend dependencies in pipeline workspace because canonical node_modules did not match the checked-in audited SDK. Lead used those dependencies read-only; frontend/E2E installs were isolated. No dependency lock changes in this task.
- Final `make check`: **1,403 backend pass / 8 skip / 0 fail; 10 frontend pass; 67 script pass; backend/frontend builds and lint pass.** Existing frontend fast-refresh warning and bundle-size notice remain.
- Search E2E: **10/10 pass**, isolated offline servers. Initial new malformed-query test expected text without the existing `Search failed:` prefix; corrected the selector after reading its synthetic accessibility snapshot.
- Transcript-pagination E2E: **8/9 pass**. The `repeated queued users ... new tail occurrence` ordering assertion at line 604 fails identically on clean explicit-base `6b2f749` in separate `test/search-baseline-20260906`; unchanged baseline failure, not weakened or fixed here. Exact search-anchor latest/back navigation passed.
- Compiled-JavaScript query worker/async tests: **31/31 pass**, verifying production module resolution as well as source/tsx execution.
- All tests used synthetic homes, Pi roots, stores and transcripts; no real provider/browser-account activity.
- An initial mistaken Make argument launched the broader E2E suite until the command deadline. Its exact synthetic listener PIDs were terminated afterward; all task test ports were verified closed. No live service was stopped or restarted.
- Full check evidence retained at `/tmp/wayang-search-make-check-20260906.log`; it is not an artifact publication or private-runtime log.

## Synthetic performance evidence

Not production throughput, filesystem SLA, or end-to-end health/auth/WebSocket latency guarantees:

| Workload | Focused observation | Full concurrent test-suite observation |
| --- | --- | --- |
| Cold 20k topology / 2k included docs / excluded 7 MiB physical record | 5.4 s wall; 31 ms max sampled parent timer gap | 14.1 s wall; 80 ms max gap |
| Same indexing workload SQL staging / publication flip | max 0.95 / 0.31 ms | max 7.05 / 0.49 ms |
| 16-unit, 10k-row / 500-session query in child | source child 782 ms wall, 11 ms max parent gap | 2,048 ms wall, 16 ms max parent gap |
| Compiled child query | 672 ms wall, 10 ms max parent gap | not separately measured |

The old two-term SQL measured about 114–135 ms synchronously in the first integrated fixture. Restricting chunk ranking to selected sessions reduced two-term SQL to roughly 58–73 ms, but 16 common units still took 425–561 ms; that evidence justified a separate read-only query process instead of asserting SQL output limits were enough. Current exact authorization/snapshot preparation remains on the parent and needs runtime observation.

Pinned-reader WAL test reached the 64 MiB watermark; repeated admission checks wrote nothing, denial/cleanup remained possible, and reader release plus explicit checkpoint/truncate allowed admission again. This proves the tested pressure behavior, not automatic recovery.

## Limits and next authorization boundary

- Included records/documents beyond compiled limits are partial; unsupported large/malformed topology remains explicit. Complete search of every historical session is not promised by this source change.
- Shared-FTS unpublished rows can change BM25 statistics and equal-coverage ordering; they never become results/facets.
- WAL watermark is not a hard filesystem quota and can require approved operator checkpoint maintenance. Slow storage, native SQLite memory and synchronous authorization remain operational risks.
- No safe append-delta optimization, external catalog redesign, embeddings, arbitrary transcript repair or target-policy bypass was added.
- No canonical integration/build/install, runtime pause change, manual production reindex, migration, restart, push or deployment was performed. Worktrees and reproducible synthetic fixtures retained; no destructive cleanup.
- Next step, only if approved: integrate exact latest main and rerun gates; design private backup/rollback and deployment; retain pause, perform an authorized small eligible canary, then gradually enable recovery with real health/auth/chat/WebSocket measurements. Catalog synchronization is a separate decision.
