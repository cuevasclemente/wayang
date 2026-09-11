# Session keyword search and indexing recovery

Status: source implementation and validation COMPLETE on 2026-09-07; details and limits in `docs/journals/2026-09-07-search-relevance-implementation.md`. Source scope was APPROVED by owner submission on 2026-09-06. Owner accepts several minutes of freshness lag to minimize background load. Quoted phrases are OPTIONAL matching units, not required constraints. All units use any-match admission and distinct-unit coverage ranking. Deployment, restart, merge/push and live recovery remain separately gated. Duplicate delivery of the same submission is treated idempotently.
Base: `6b2f749f9ecac24db8f68a825458405ca1cdd912` (explicit local main).
Branch/worktree: `plan/search-relevance-recovery-20260907`, `/home/clemente/src/wayang-worktrees/search-relevance-recovery-20260907`.

## Implementation outcome

Source candidate implements M1–M3, not M4 activation. Final `make check`: 1,403 backend pass/8 skip, 10 frontend pass, 67 scripts pass; search E2E10/10; pagination8/9 with the identical unchanged baseline ordering failure reproduced separately; compiled query worker31/31. Independent source review has no remaining concrete blockers. No canonical integration/deployment/restart/live backfill.

Measured SQL cost justified a bounded read-only query child in addition to the extraction worker; SQLite writes remain main-thread bounded slices. Complete message documents <=128KiB replace overlapping chunks in new indexing, with explicit partial outcomes beyond limits. Exact published body witnesses require legacy BODY reindex; current authorized legacy metadata is the exception. Final release uses a synchronous transport callback after reauthorization. WAL pressure can require approved operator checkpoint maintenance; it is not a hard quota or automatic recovery. See the journal/operator guide for measured limits, additive schema4, and next approval gates. The remainder records the approved design/rationale; where implementation choices differ, the outcome/journal takes precedence.

## Goal and approved contract

The owner reports missing expected past conversations and wants local keyword search: whitespace-separated terms match independently; sessions covering more distinct terms rank higher. Quoted strings should provide phrase matching. No semantic provider or embedding service is needed.

Approved contract:
- Unquoted `alpha beta gamma` admits sessions containing any term in searchable metadata or active-branch user/assistant text. Rank by distinct-term coverage descending, then lexical relevance, then recency and a stable ID tie-break.
- Count coverage across the whole session, not only one message/chunk. Repeated occurrences or many chunks must not outrank greater distinct-term coverage by themselves.
- Quoted phrases require consecutive token matches in order; case/punctuation follow documented FTS tokenization, not byte-identical substring semantics.
- Mixed query behavior: every quoted phrase is one optional matching unit alongside unquoted words. Any unit admits a session; matching more distinct units ranks higher. A phrase-only query returns matches for that phrase; multiple quoted phrases use OR admission.
- Do not silently apply prefix matching to quoted phrases. Decide/document whether existing last-unquoted-token typeahead prefix remains; recommend explicit documented behavior rather than accidental query-order dependence.
- Preserve existing filters, privacy gates, message anchors, snippet sanitization, and active-branch-only scope. Tool output, attachments and thinking remain excluded.

## Verified evidence

Read-only live observations on 2026-09-06 (host UTC date):
- Search health: 697 eligible sessions, 380 state rows counted as indexed, 317 pending, zero reported errors, schema 2, embedder off.
- Watcher started but `background_indexing_enabled=false`, backfill neither running nor completed; policy projection available.
- Catalog health independently reports background sync disabled, mode paused, no active scan/watchers.
- A user-provided two-word query produced zero results with archived included. Each single-word query returned only a few sessions in the target Standard project.
- Metadata identified a likely target conversation, but the bounded `session_read` tool refused exact transcript authorization. No fallback read, direct database access, or alternate content route was attempted. Target content and precise denial cause remain unverified. Metadata visibility is not proof of indexability: `session-interop.ts` lists Standard metadata, whereas both transcript reads and `search/policy-filter.ts` require exact transcript authorization.
- Repository history explains both pauses as deliberate availability mitigation following the August 26 event-loop/FUSE incident. See `docs/journals/2026-08-26-wayang-responsiveness-and-chat-draft-recovery.md`, `2026-08-26-search-backfill-projection-recovery.md`, and August 28 protected-artifact hotpath repair. The older root cause was partly repaired; safe full indexing has not been revalidated here.

Source findings in `backend/src/search/search.ts`:
- `buildFtsExpression` whitespace-splits, removes quotes/syntax, AND-combines tokens, and prefix-matches the final token when length >=3.
- Matching operates on one FTS row (chunk text plus repeated title/goal), not terms across messages in a session.
- Only the top 200 chunk hits are considered before session deduplication, allowing chunk-heavy sessions to crowd other sessions out.
- Rank is best-chunk position, not session-wide distinct-term coverage.
- FTS SQL failures return an ordinary empty result; paused/incomplete coverage has no degraded signal (only running boot backfill does).
- An in-memory SQLite fixture executing the actual extracted/transpiled query-builder function proved the reported two-word query and its quoted form generate the same expression and exclude sessions whose terms occur only in separate rows. No production data was used.

Additional source-review leads (not proven target causes):
- Watcher selection considers transcript path/mtime/size but not metadata-only changes.
- Error/meta-only states can satisfy unchanged-file skip logic.
- Structural failures may remove index state and thus disappear from error counts; legacy topology/large-entry ceilings need synthetic regression checks.
- Health counts bookkeeping rows, not verified complete current transcript coverage. The 317 missing-state count is a lower bound on search coverage problems, not a complete stale-content inventory.

## Milestones

### M1 — Query semantics and ranking
- Add bounded parser for words and quoted phrases; reject/report invalid or excessive input clearly rather than silently dropping meaningful text.
- Aggregate term coverage per authorized, filtered session before final result cap. Avoid fixed global chunk sampling as the session candidate gate.
- Keep original chunk/message anchors for snippets and navigation. No flattening across message boundaries to manufacture phrase matches. Test phrases crossing chunk boundaries and longer than the existing overlap; merely parsing quotes does not guarantee complete phrase retrieval. Resolve a bounded message-level phrase strategy or a clearly documented supported phrase bound, without silently claiming full phrase support.
- Prototype ranking with existing FTS5 schema first; only migrate if necessary. Measure query costs on a sizeable synthetic corpus, especially common-term OR queries; SQLite currently runs synchronously.
- Update operator docs and input help with supported syntax; no unimplemented Boolean-operator promise.

### M2 — Truthful search status and index lifecycle
- Expose paused versus indexing versus incomplete/error state in response/UI, including zero-result states. Do not label results as complete merely because no backfill is running.
- Return a real query error/degraded signal for SQL failure rather than an ordinary empty list.
- Add cheap metadata invalidation and retryable-error handling with a single bounded indexing queue if needed; avoid full transcript rescans on every metadata edit or keystroke.
- Preserve denial-first purge and query-time authorization. If exact denial diagnosis is needed, add/review a backend-owned content-free reason projection; never work around a failed transcript read with direct storage access.
- Scope health counts to authorized content; do not expose private session details or turn exclusions into bypasses.

### M3 — Sustainable indexing pipeline

Owner explicitly requested this investigation. Recommended architecture and evidence are detailed below; implement before broad automatic indexing is resumed. Scheduling-only containment is not a claim that large-session processing is now safe.

### M4 — Separately authorized runtime recovery
- Do not change pause flags, start a full reindex, rebuild canonical assets, restart services, merge, push, or deploy as part of planning/source implementation.
- After review, diagnose target eligibility through the owning backend/owner flow without releasing denied content. If attribution/header policy needs repair, require its own exact approved mutation plan; never weaken the authorizer.
- After runtime recovery approval, start with one eligible small-session reindex canary and monitor health/auth/chat latency. Confirm expected query behavior using owner-visible results.
- Expand bounded recovery only when safe. If current indexing cannot keep event-loop latency acceptable, implement the scheduling/worker correction first rather than reenabling the old scan.
- Keep external catalog synchronization a separate decision from Wayang-managed-session indexing.

## Team ownership after approval

1. Lead: approved contract, integration, ranking design, synthetic performance evidence, final validation and runtime gating.
2. Query worker (own worktree): parser/ranking and backend synthetic regressions; no UI or live storage.
3. Status/UI worker (own worktree): agreed API status types and SessionsPanel warning/help/tests; coordinate shared type contract before editing.
4. Read-only reviewer: indexing/privacy/error/coverage audit, adversarial query/crowding/phrase-boundary tests and performance review. No production transcripts.

Avoid splitting one SQL/parser change among concurrent writers. All implementation writers use separate branches/worktrees and focused commits for lead review.

## Validation

- Any-term admission; all > some > one distinct keyword; coverage across separated messages; repeated words do not increase coverage.
- Phrase order/adjacency; mixed queries; unmatched/empty quotes; Unicode and punctuation; literal operator-like words; bounded query length/term counts; no FTS injection.
- >200 matching chunks in one session cannot suppress otherwise eligible sessions. Stable ranking, preserved filters/facets and accurate snippets/anchors.
- Archive/title/model/goal metadata-only changes; stale/error state retry; paused indexing; failed SQL; structural/legacy/large-session boundaries with truthful status.
- Existing Protected, quarantined, unknown, revoked, duplicate-owner, mutation/recovery-marker and active-branch tests stay green. Only synthetic fixtures.
- Run focused backend tests, frontend checks, search/navigation E2E, then `make check` from isolated worktrees. Use synthetic HOME/Pi/data dirs and repository default deployment flags; never copy production secret-bearing files.
- Runtime validation later: eligible canary becomes findable, coverage progresses, indexing remains responsive, unrelated chat remains usable, rollback/stop remains available.

## Rollback and deferrals

Keep current live runtime and index untouched until explicit activation. Prefer no schema change for M1. If migration is necessary, use a separately approved private backup/rebuild path with no database contents exposed to agents. Preserve old runtime artifacts and maintenance pause for operational rollback; do not delete transcripts or reset shared stores.

Deferred: semantic search, embeddings, cross-machine index, attachments/tool-output indexing, arbitrary transcript repair, general catalog redesign, and unrelated performance refactors. Query semantics and coverage recovery are separate deliverables: neither alone fixes both observed problems.

## Sustainable indexing: recommended design

### Additional evidence and diagnostic

`docs/experiments/2026-09-06-search-chunker-probe.cjs` extracts and transpiles only the current pure chunker, permits only its `node:fs` import, and uses synthetic temporary files. It does not import runtime configuration or open private state. One run on Node 26.4.0 produced:

| Excluded tool-result physical line | Chunker wall time | Maximum sampled event-loop delay | Output chunks |
| --- | ---: | ---: | ---: |
| 1 MiB | 25 ms | 7 ms | 2 |
| 4 MiB | 334 ms | 12 ms | 2 |
| 16 MiB | 5,007 ms | 52 ms | 2 |

These are illustrative single-run isolated measurements, not production throughput or end-to-end latency guarantees. Fixture creation and TypeScript transpilation are excluded from timing. Synthetic fixtures are retained at `/tmp/wayang-synthetic-search-probe-gAoioK` (~21 MiB); no private content exists there.

The cause is visible in `chunker.ts`: each 64 KiB read concatenates and rescans the growing physical-line buffer, then copies the remaining buffer; after the line is complete, JSON is parsed even when its role will be excluded. All selected utterances and resulting chunks remain resident until extraction finishes. Streaming disk reads do not imply bounded parsing, allocation, or transaction work.

`indexer.ts` performs full extraction before structural filtering and then one synchronous delete/reinsert FTS transaction. The backfill yields between sessions only. Watcher ticks, boot backfill, immediate hooks, and manual requests can overlap. Current shutdown clears timers without draining/cancelling those index jobs. Query/health policy filtering also walks and exact-authorizes the eligible catalog synchronously; worker extraction alone does not fix this cost.

### Approved starting point for implementation

1. **One search-specific queue.** Route boot, changes, manual reindex, and ordinary immediate hooks through a coalescing queue keyed by session/revision. Initially one running extraction, bounded pending admission, completion cooldown/debounce, priority for explicit/recent work, and aging for historical backfill. Stop/pause prevents admission and drains/cancels at reviewed checkpoints. Mutation recovery must still await actual reconciliation using its exact recovery marker; an enqueue acknowledgement is not completion. Do not introduce a universal catalog/search scheduler.
2. **Reuse structural evidence.** Add a narrow revision-bound iterator of active user/assistant event IDs, roles, offsets and lengths. Check topology before extraction; skip tool-only and sibling-branch rows without parsing them again. Existing structural workers/cache/offsets are useful but not uniformly cheap: cold builds still parse whole records and append refresh recomputes active topology. Do not reuse UI `readBoundedEntries()` projections as canonical search input: those intentionally sample oversized events and would silently lose text.
3. **One bounded extraction worker.** Move exact JSON/text extraction and chunk packing off the HTTP thread. Use backpressured row-and-byte-bounded batches, not a transcript-sized return array. Bound physical record handling, worker time/heap, transfer bytes and pending output. Use linear segmented-line accumulation or a reviewed streaming JSON strategy. Oversized/unsupported records must produce explicit partial/unsupported coverage, not silently successful truncation.
4. **Keep one SQLite owner initially.** Use small row-and-byte-bounded main-thread staging transactions with yields and measured duration, followed by a short publication-pointer flip. No bulk copy/delete, cascading cleanup, or FTS rebuild in that flip. This retains the existing final synchronous authorization/CAS boundary; a writer worker adds another revocation/acknowledgement protocol and is justified only if measurements show bounded FTS writes/checkpoints still exceed the budget. A row count is not a hard wall-clock ceiling on slow storage.
5. **Separate session metadata.** Store/update one session-level metadata projection/meta search document rather than rewriting body chunks when title/archive/model/goal changes. Body extraction version/config and metadata revision have independent dirty state. Avoid creating a new generation just for repeated last-active changes.
6. **Durable progress and retry state.** Track requested, attempted and successful revisions separately; expose queued/running/current/stale/metadata-only/partial/failed/paused/unsupported distinctions as appropriate. Keep typed transient failures with capped backoff and stable negative outcomes until relevant input/version changes. Global authorization-projection failure pauses admission once, not once per session. Queue memory can be reconstructed from durable dirty state instead of loading a whole transcript corpus at boot.
7. **Incremental content updates follow proof, not assumptions.** First eliminate duplicate concurrent work, metadata-triggered extraction, excluded-event rereads and unbounded changed-session publication. Then add verified event/append deltas with newline, branch-descendant and prefix-identity evidence; path+size or a tail witness alone cannot prove an earlier region was not rewritten. Branch switches, edits/deletes, file replacement and uncertain appends invalidate/rebuild. A constantly changing session must report its actual last searchable revision; do not promise 30–60 second freshness unless snapshot/prefix correctness and maximum deferral are proven.

### Publication, migration, and privacy requirements

- Stage into bounded unpublished generations. Every result/snippet/facet path excludes unpublished, invalidated and unauthorized generations before applying limits. Cleanup, staging disk use and WAL growth are bounded and observable.
- Shared-FTS staging rows can influence corpus BM25 statistics even when result filters hide them. Measure and explicitly decide whether this temporary ranking drift is acceptable; do not call generation filtering full ranking isolation.
- Final CAS binds session/job invalidation, exact file fingerprint, policy generation, active-branch revision, metadata projection and extraction version/options. A structural epoch alone is insufficient because safe appends preserve it while changing the revision.
- Old indexed content is retained only while still valid; privacy changes, mutation fences, deletion and incompatible rewrites deny visibility immediately. Purge/cleanup obligations include unpublished text, not only published rows. Query authorization remains independent of purge completion.
- Use an additive migration if generations/session metadata need schema changes. The current automatic drop-on-version-change mechanism would destroy coverage before backfill and is unsuitable for a no-outage rollout. Migration/rollback must be reviewed separately; never expose or copy private databases into a task workspace.
- Authorization optimization is targeted and measured: reuse phase-local observations and generation-keyed ownership maps where safe, but preserve fresh checks across yields and body admission. Do not speculatively read body bytes merely to optimize the current bounded header reader.

### Resource targets and instrumentation

Owner accepts several minutes before new content becomes searchable and explicitly prioritizes minimizing background load. Use a conservative multi-minute refresh/debounce and inter-job cooldown with gradual historical backfill. This is a tradeoff, not a guaranteed completion deadline for continuously changing or unsupported inputs.

Before choosing worker heap, batch byte count, query limits, or activation thresholds, record a synthetic baseline and test a small explicit budget table. Proposed acceptance starting points (not established results): indexing-induced health/auth/WebSocket p95 regression <=50 ms on the reference workload; main-thread indexing slices target <=10 ms and flag >25 ms; no sustained event-loop delay >100 ms attributable to indexing. Measure slow-storage and checkpoint tails too; revise concrete gates against the existing service baseline and deployment host.

Add aggregate-only queue age/count, oldest eligible unindexed age, revision lag, extraction/read/chunk bytes, worker restarts, phase durations, SQL transaction/checkpoint durations, staged/WAL bytes, retry outcomes and event-loop pressure. No transcript text, query text, private paths, session titles or protected identifiers in diagnostics. Admission can slow on measured pressure; fairness prevents indefinite backfill starvation. Do not infer quietness merely from an idle chat bubble.

### Expanded synthetic validation and sequence

- Giant excluded and included records, UTF-8 boundaries, malformed/truncated tails, many small events, long active sessions, sibling branches and unsupported topology.
- Overlapping producers/coalescing, fair backfill, continuous writes, metadata-only updates, transient failures, stable failures, restart/recovery, pause/shutdown, DB locked/full and worker crash.
- Revocation/mutation/deletion after every async boundary, stale worker reply, partial publication, bounded abandoned-generation cleanup, and no stale replay after restart.
- Sustained simultaneous chat/health/auth/search traffic during backfill, including common-term OR searches. Measure query-time authorization separately from FTS and extraction; do not conflate a successful `/healthz` with responsive session open or WebSocket handling.
- Implementation order: lock query/API contracts and baseline; queue/status/metadata containment; bounded worker/offset/generation pipeline; adversarial/security/performance review; separately approved small canary and gradual activation; true append-delta optimization after correctness proof.

Team adjustment: add a bounded index-pipeline implementer owning queue/chunker/indexer/migration in a separate worktree, with an independent privacy/performance reviewer. Query worker and pipeline worker must agree schema/generation visibility before concurrent code work. The lead integrates shared contracts; do not give multiple writers overlapping migration/indexer ownership.

