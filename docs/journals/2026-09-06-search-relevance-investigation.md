# Session search relevance and sustainable indexing investigation

Date: 2026-09-06 (host UTC date). Investigation/planning only.

## Findings

- Live search health: 380/697 eligible sessions have index-state rows; 317 pending; zero reported errors. Automatic indexing is disabled. Catalog synchronization is independently paused. These were deliberate August 26 availability mitigations, not settings to remove blindly.
- Current query builder strips quotes, AND-combines words at chunk level and prefix-matches the last token. Session ranking uses the best of at most 200 global chunk hits, not session-wide distinct-term coverage. Actual query-builder/SQLite synthetic fixture reproduced the mismatch.
- The user-provided missing-query example returned no results with archives included. Metadata found a likely target, but exact bounded transcript authorization denied the read. No fallback was attempted; target eligibility/root cause is unresolved and must remain distinct from the confirmed general index backlog.
- Owner expanded scope to sustainable indexing. Source review found full transcript extraction/replacement for changes, overlapping producers, main-thread parsing/FTS publication, repeated excluded-line processing, and incomplete retry/status handling.
- Isolated synthetic current-chunker probe: excluded 1/4/16 MiB tool lines took 25/334/5007 ms, with 7/12/52 ms maximum sampled event-loop delay and two chunks each. Single run, not production performance. Script retained in `docs/experiments/2026-09-06-search-chunker-probe.cjs`; synthetic fixtures retained at `/tmp/wayang-synthetic-search-probe-gAoioK`.

## Proposed direction

Plan: `docs/plans/2026-09-06-search-relevance-recovery.md` (ignored by existing repository rules; present on disk, not committed).

Keyword OR admission + session-wide coverage ranking, real phrases, truthful incomplete/paused/error status. One coalescing search queue; independent metadata refresh; reuse revision-bound active structural offsets; one extraction worker with byte-bounded backpressured output; small SQLite staging transactions and short publication flip; bounded cleanup/retries. Keep current SQLite ownership until measurement justifies writer-worker complexity. True append indexing follows a correctness proof for branches/rewrites/prefix identity.

Preserve exact authorization, body-admission and prepublication checks, mutation recovery barriers, query-time denial and staged-content purge. Additive migration rather than a destructive derived-table reset. Independent reviewers agreed queue-only or worker-only changes are insufficient to bound the entire pipeline.

## Validation and boundaries

- `make doctor`: zero failures/warnings; no secret contents inspected.
- Read source, focused tests, operator guide, past incident journals, and relevant wiki; no full suites were run because no application implementation occurred.
- Dedicated branch/worktree based on explicit local-main `6b2f749f9ecac24db8f68a825458405ca1cdd912`: `plan/search-relevance-recovery-20260907`, `/home/clemente/src/wayang-worktrees/search-relevance-recovery-20260907`. The slug is only an identifier; actual investigation date is recorded above.
- Application code, canonical checkout, private configuration, services and indexes unchanged. No manual reindex, deployment, restart, merge, push, or runtime mutation.
- Open decisions: owner acceptance of approximately 30–60 second freshness versus immediate search; mixed quoted/unquoted query behavior; implementation approval. Runtime recovery remains separately authorized.
- Durable wiki handoff: `synthesis/wayang-search-recovery-current.md`; general lesson added to `concepts/wayang-project.md`.
