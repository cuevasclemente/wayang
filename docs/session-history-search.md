# Session History Search

Wayang maintains a local keyword index over authorized Standard pi sessions. No transcript content is sent to an embedding provider.

## Query syntax and ranking

- Space-separated words match **independently**. `leather rain` returns sessions matching either word; sessions matching both rank higher, even when the words occur in different messages.
- Quotes form **one optional phrase unit**. `rain "leather jacket"` returns matches for either unit, with sessions matching both first. Multiple quoted phrases also use OR admission, not mandatory constraints.
- Phrases require consecutive, ordered FTS tokens within one indexed message or metadata document. Case, accents and punctuation follow SQLite `unicode61 remove_diacritics 2`, not byte-identical substring matching. Equivalent token sequences count once.
- Words are exact-token matches: there is no implicit prefix/typeahead wildcard, Boolean syntax, stemming, or semantic search. Operator-like words are literal words.
- Limits: 2,048 query characters, 16 supplied words/phrases, 128 characters per unit. Malformed, empty or oversized units produce an explicit error rather than silently broadening/truncating a query.
- Sessions rank by distinct matching units across their searchable content, then lexical relevance, indexed recency and stable session ID. Repetition cannot increase distinct-unit coverage. The UI preserves this order across projects.

Results retain exact message anchors and sanitized highlighted excerpts. Clicking a result opens a bounded transcript window around that active-branch message, with **Jump to latest** / **Back to match** navigation. Missing or off-branch anchors are reported rather than silently substituted. See [Session transcript pagination](session-transcript-pagination.md).

## Coverage and resource limits

Only active-branch user/assistant text is indexed. Tool inputs/results, thinking, images and attachments are excluded. Source offsets come from revision-bound structural evidence, never the UI's sampled oversized-event projections.

New indexing stores complete message text documents, without artificial role prefixes or chunk-boundary phrase gaps. Included records over 1 MiB or extracted documents over 128 KiB are skipped **whole** and reported as **partial** coverage. Cold search structural builds cap files at 128 MiB and physical records at 8 MiB; the existing 25,000-topology-entry ceiling also applies. Unsupported topology, malformed input and resource ceilings do not masquerade as complete indexing.

A transcript can be visible in the catalog without being eligible for exact transcript indexing. Protected, quarantined, ambiguous-owner and otherwise unauthorized content remains excluded. Body search additionally requires the exact published file path/fingerprint, extraction version, generation and transcript epoch. Rewritten, detached or changed-branch bodies are hidden immediately at query authorization, even while automatic indexing is paused.

Metadata changes are independent of body extraction. In the asynchronous query path, stale searchable/filter metadata excludes that session with an aggregate incomplete warning; it does not make unrelated sessions unavailable. Last-active-only drift uses **indexed recency** for ranking and date filters until metadata refresh.

## Low-load indexing

- One coalescing priority queue, one extraction worker, bounded pending admission and backpressure. Manual and mutation recovery take priority; aged historical work retains a path to progress.
- Automatic discovery starts approximately two minutes after boot, examines at most 16 catalog IDs every five seconds with yields, and does not await extraction. A 697-session discovery pass is nominally about four minutes, excluding filesystem delays; that is not a backfill-completion guarantee.
- Recent-session hooks have a two-minute debounce. Background extraction has a cooldown; busy, failing or continuously changing sessions can take longer. Chat responsiveness and low background load take priority over immediate freshness.
- Exact authorized reads precede extraction. Publication stages at most 16 rows/128 KiB per transaction, yields between batches, and finishes with a short generation/witness flip. Cleanup is candidate-, row- and byte-bounded; it is not a giant delete in the publication transaction.
- Durable state distinguishes queued, running, current, metadata-only, partial, unsupported, failed, stale and legacy/missing coverage. Transient failures back off; repaired metadata invalidates metadata-bound failures. Shutdown fences admission and drains producers before structural teardown.
- Mutation recovery is stricter than ordinary partial search: it requires complete publication and a fresh synchronous acknowledgement before clearing the durable recovery marker.

The 64 MiB WAL admission watermark is **not a hard disk quota**. Safety denial/cleanup can still write, and a bounded transaction may overshoot. A retained large WAL can keep indexing paused after a reader exits; an operator checkpoint/reset/truncate may be required. This implementation does not automatically perform a potentially expensive truncating checkpoint. Inspect aggregate health metrics and investigate through an approved maintenance flow; never reset the index or copy private storage into a development workspace merely to diagnose pressure.

## Responsive query execution

Production MATCH SQL runs in one disposable read-only Node child process, reusing the tested SQL implementation. It has four pending slots, a five-second queue-inclusive deadline per attempt, a 64 MiB V8 heap limit, a 2 MiB request ceiling and a 512 KiB result ceiling. The V8 limit does not bound SQLite native memory. Cancellation/timeout kills that child, not the server; success waits for its database reader to close and its process to exit.

The child attests publication/metadata state within the same transaction as MATCH. The parent reauthorizes before releasing any snippets **or facets**. Changed snapshots discard the whole response and retry at most once. Final validation, formatting and HTTP release execute in one synchronous segment—an awaited response value alone is not release authority. Main-thread exact authorization and filesystem latency remain costs to monitor.

Unpublished rows never contribute results/facets, but their presence in the shared FTS corpus can affect BM25 statistics and reorder equal-coverage sessions during staging/cleanup. Distinct-unit coverage still dominates ranking. This is not fully isolated ranking statistics.

## API and UI status

```text
GET  /api/sessions/search?q=…&cwd=…&archived=…&since=…&until=…&model=…
                          &has_goal=…&has_error=…&limit=30
GET  /api/sessions/search/health
POST /api/sessions/search/reindex      body: { session_id?: string }
```

The UI debounces input by 250 ms and searches at two characters. Archives are hidden by default. Filters preserve project, model, date, goal and error selection.

Responses include results, facets, timing, optional aggregate `coverage`, and a `degraded` reason such as `indexing_paused`, `indexing_in_progress`, `index_incomplete` or `index_unavailable`. Warnings remain visible for zero results. Fresh body/metadata revision rejections are aggregate counts; rejected IDs and private diagnostics are not returned. Coverage counts describe **last-observed work state**, not a fresh corpus body scan. Zero errors or an idle backfill does not prove complete coverage.

Invalid syntax returns HTTP 400 with a fixed public explanation. Busy query admission returns 429; unavailable, timeout, changed or oversized execution returns a safe operational error instead of an ordinary empty result. Health includes queue/publication metrics without transcript/query text. Manual per-session reindex awaits its actual result; repeated full-manual requests share one in-flight corpus producer.

## Pause, migration and recovery

`WAYANG_SEARCH_BACKGROUND_INDEXING=0` disables automatic discovery and recent-session indexing. Existing authorized results remain queryable; explicit manual reindex remains available. Policy refresh, denial and bounded cleanup continue. Query authorization is independent of physical purge completion. Catalog synchronization is a separate subsystem and pause decision.

The derived SQLite database is `<dataDir>/search.db`, beside `store.json`. Schema 4 adds session metadata, durable work state, generations and immutable publication witnesses. Migration from existing schema 2 retains old rows without a bulk FTS rebuild. **Legacy body rows lack exact publication evidence and remain hidden until rebuilt**; currently authorized, current-presentation legacy metadata can still match. This is an intentional safety limitation, not full historical phrase coverage before recovery.

This runtime refuses destructive schema downgrade. Older runtimes may not: do not point an old runtime at a migrated database for rollback. Deployment must separately plan private backup/restore, keep the maintenance pause initially, validate a small eligible canary and expand gradually while observing health/auth/chat/WebSocket responsiveness. Source validation does not authorize a live migration, reindex, restart or catalog recovery.

## Tests

- `make check`: backend synthetic unit/integration, frontend tests/lint/build, script checks.
- Search/browser: `npm --prefix e2e test -- session-search.spec.ts transcript-pagination.spec.ts` with isolated test ports.
- `backend/src/search/` includes query grammar/ranking, exact revision authorization, asynchronous release races, queue/shutdown, worker limits, migration, metadata retry, large topology and pinned-reader WAL regressions. Compiled query-worker tests also exercise production module resolution.
- All fixtures use synthetic homes, session roots and stores; no real provider calls or private transcripts are required.
