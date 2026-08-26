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

## Tests and review

Focused synthetic tests cover:

- unchanged single-session and full-corpus indexing reuse the exact durable projection inode;
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

Pending at journal creation. The reviewed commit will be integrated only if canonical `main` remains clean at the expected base, followed by one service restart and direct auth/health/projection-stability measurements.

## Rollback

No schema or data migration occurred. Revert the focused commit, rebuild, and restart. Restart discards the in-process cache; existing `store.json`, transcripts, search databases, and policy projection remain intact.
