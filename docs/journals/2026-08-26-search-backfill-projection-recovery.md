# Search Backfill Policy-Projection Recovery — 2026-08-26

## Incident

Wayang's UI remained at authentication bootstrap. The backend process was alive and listening, but local `/`, `/healthz`, and `/api/auth/status` requests accepted TCP and returned no bytes before timeout.

The deployed process had consumed about eight CPU-hours over about nine hours, peaked at 6.4 GiB memory and 4.1 GiB swap, and was blocked/spinning in filesystem/page waits. A user-approved service restart required systemd's configured SIGKILL escalation after graceful shutdown timed out. The fresh process reproduced the same failure.

The production corpus had 1,627 JSONL files totaling 3.62 GiB and about 1,676 projected session decisions. `indexSessionAttempt()` durably rebuilt and fsynced the complete ~555 KiB Dream policy projection before every session attempt. Boot backfill therefore performed approximately quadratic metadata work on the Node main event loop. Runtime measurement showed about 8.6 MiB/s of repeated writes while HTTP remained unresponsive.

## Change

Plan: `docs/plans/2026-08-26-search-backfill-projection-recovery.md`

- Added `ensureDreamPolicyProjection()`.
- Cache reuse requires the exact current data-directory destination, store inode/size/mtime/ctime, policy generation, and the exact private single-link projection-file fingerprint (device/inode/size/mtime/ctime/mode/link count/uid).
- Missing, replaced, permission-changed, or stale projection files are durably republished.
- The cache is populated only after atomic rename, permission reinforcement, and best-effort directory fsync complete.
- Indexing retains the ensure-current gate on every attempt and CAS retry; exact transcript authorization, mutation fences, file fingerprints, and query-time filtering are unchanged.
- Projection-publication failures are typed as one global prerequisite failure. Full backfill and periodic watcher ticks abort instead of rebuilding/failing once per pending session.
- Removed the immediate watcher hook's duplicate unconditional projection write; `indexSession()` owns the freshness boundary.
- Added an explicit `setImmediate` yield after every completed backfill session so a large unchanged catalog cannot monopolize the microtask queue and starve auth, health, or WebSocket I/O.

## Tests and review

Focused synthetic tests cover:

- unchanged single-session and full-corpus indexing reuse the exact durable projection inode;
- a warmed full-corpus pass yields to a scheduled event-loop turn before completing and leaves no projection temp artifacts;
- a store-only change (new session in the same Standard project, unchanged policy generation) publishes the new `dream: true` decision;
- policy-generation changes force publication;
- permission tampering forces a private replacement;
- full reindex and periodic watcher ticks abort on the first global publication failure;
- existing quarantine, Protected-policy, allowlist, path-collision, header-mismatch, transcript-fingerprint, metadata-CAS, mutation-fence, and active-branch tests remain passing.

Validation evidence before deployment:

- focused `policy-projection.test.ts` + `indexer.test.ts`: **23/23 passed**;
- backend TypeScript build: passed;
- production backend + frontend build: passed;
- full backend suite: **1,017 passed, 7 skipped, 1 failed**. The sole failure was the pre-existing host-dependent real ffmpeg/ffprobe Bubblewrap audio sandbox test (`audio-experiment/media.test.ts`), unrelated to search/projection code;
- independent security review: final **GO**, no remaining findings.

## Deployment and production validation

The first reviewed commit (`bc52181`) was fast-forwarded into clean canonical `main`, built, and restarted. It eliminated the projection-write storm: the store and projection inode/mtime remained stable and backend writes fell from about 8.6 MiB/s to zero. The one-time startup projection/purge reached the listener after about 67 seconds.

That deployment exposed a second, narrower availability defect: the unchanged-session loop repeatedly awaited already-resolved promises, remaining in the microtask queue and delaying HTTP even though projection I/O was fixed. `/api/auth/status` eventually returned 200 but took about 2.0 seconds during the pass. The event-loop yield change and deterministic regression were then added; focused tests remained 23/23, backend build passed, and independent security delta review returned GO.

A reversible maintenance deployment then set both `WAYANG_SEARCH_BACKGROUND_INDEXING=0` and `WAYANG_SESSION_CATALOG_BACKGROUND_SYNC=0`. Startup confirmed both paths paused, but HTTP again accepted connections without returning bytes. The child remained near 29% CPU in FUSE requests. The remaining cause was the paused search heartbeat: every 30 seconds it synchronously called `purgePolicyDeniedSessions()`, which exact-authorized every transcript. On this corpus each purge took longer than the interval, so queued heartbeats continuously starved the event loop.

The emergency follow-up (`c336663`) removes only that unconditional no-change purge from the paused heartbeat. Projection freshness checks continue every 30 seconds without transcript reads. Actual policy-generation changes retain the existing immediate `onPolicyChanged` purge, and search query-time exact authorization independently hides denied stale rows before purge completion. The focused indexer suite passed 24/24, including a deterministic stale-row/no-change-heartbeat regression and a paused-watcher policy-change purge assertion; the backend and canonical production builds passed, and independent re-review returned GO with no blocking findings.

After deployment, the one-time startup authorization pass completed and both maintenance pauses were logged before the listener became available. Across more than two subsequent heartbeat intervals, `/healthz`, `/api/auth/status`, `/api/browser-profiles`, and `/` all returned HTTP 200 in roughly 0.4–1.2 ms locally; systemd remained active/running with `NRestarts=0`, the process slept in `epoll` between bounded CPU bursts instead of remaining blocked on FUSE, and the user confirmed normal UI operation. Automatic search indexing and external Pi-session catalog synchronization remain intentionally paused until the maintenance overrides are removed and the service is restarted.

## Rollback

No schema or data migration occurred. Revert the focused commit, rebuild, and restart. Restart discards the in-process cache; existing `store.json`, transcripts, search databases, and policy projection remain intact.
