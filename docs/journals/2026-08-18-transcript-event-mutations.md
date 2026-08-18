# PIN-gated canonical transcript event mutations

**Date:** 2026-08-18  
**Status:** implementation and review complete; PR/deployment receipts pending  
**Wayang base:** `c85cd1ecf9e1af9ab9016788d17b6ed399f15c76`  
**Pi source:** `f351bec91b42ddaf4bb19f68590336a33c438dba`

## Result

Wayang now supports owner-PIN-gated edit/delete for persisted human, assistant, tool, summary, model/thinking, extension, label, session-info, and other supported Pi events. Rendered rows expose exact event management, while the Events inspector covers hidden and off-branch entries.

Mutations rewrite canonical Pi JSONL. Edit preserves the event envelope/type and adds trusted non-content marker metadata. Delete replaces the selected entry with a content-free tombstone at the same ID/parent position. No application revision/undo copy is retained.

## Pi transaction

The vendored Pi package adds atomic multi-entry compare-and-swap replacement under the existing physical session lock. It includes:

- strict bounded JSONL and fatal UTF-8 parsing;
- canonical alias and hard-link checks;
- lock inode ownership, heartbeat, and successor-lock-safe release;
- one fsynced replacement and one rename for target plus summary invalidations;
- typed committed-after-rename failures;
- a system-owned mutation epoch that makes already-open cooperative managers reopen before appending;
- no old-content backup or stale candidate temp.

Vendored artifact:

- `backend/earendil-works-pi-coding-agent-0.84.1-wayang.f351bec9.tgz`
- SHA-256 `981f531ffe7b0a93ccf31a2f794d17c54025894cf8d39094193e892fed023938`

## Wayang transaction and recovery

Backend mutation ordering:

1. acquire process-local session mutation lock;
2. validate exact event/replacement and reserve/consume the shared persistent PIN attempt;
3. stop an idle runtime and recheck every live/human/messaging gate;
4. persist a content-free schema-7 `event_reconcile` recovery row;
5. purge/fence search;
6. atomically rewrite target plus all potentially content-bearing compaction/branch summaries;
7. invalidate history/TODO snapshots;
8. wait for a catalog scan from the new generation;
9. force search indexing with metadata-generation CAS;
10. clear recovery authority;
11. unlock, then invalidate every connected client.

Persistent reconciliation failure keeps search denied, retains recovery authority, invalidates clients after unlock, and returns a fixed attention error.

Whole-session deletion now uses the same hardened PIN cooldown. Row removal and a durable `session_delete` recovery row commit in one store transaction before unlink. Startup recovery runs before catalog/search watchers and finishes incomplete unlinks without allowing transcript resurrection.

## Frontend

- Exact event actions for individual and coalesced rendered rows.
- Lazy paginated all-event inspector.
- Friendly text and bounded advanced JSON editors.
- Exact preview, semantic/external-effect warnings, and explicit acknowledgement.
- PIN cleared on intent, error, cancel, session/visibility change, and completion.
- Whole-app inert portal modals with focus trap/restore and mobile-visible controls.
- Confirmed and ambiguous completion both hide stale history and require a new WebSocket transport before rendering authoritative history.
- Repeat edits retain the trusted marker in the CAS expectation but strip reserved marker fields from editable payload.

## Truthful limits

Deletion removes the selected event's stored payload. It does not discover/remove quotations or paraphrases in unrelated events, provider copies, backups/snapshots, forensic filesystem/SQLite remnants, TTS broker jobs, or already-completed external side effects. These limits are documented in `docs/transcript-event-mutations.md`.

## Validation to date

- Pi focused transaction suite: 24/24.
- Wayang backend aggregate before schema-7 final integration: 897 pass, 0 fail, 5 skip.
- Final focused schema/recovery/mutation/index/session suite: 85/85.
- Final focused transaction/lock/catalog/invalidation suite: 40/40 before durable-journal follow-up.
- Installed vendored Pi SDK CAS integration: pass.
- Frontend production build: pass.
- Frontend lint: no feature errors/warnings; one pre-existing `SessionResultSnippet.tsx` Fast Refresh warning remains.
- Playwright transcript mutation suite: 3/3 after final transport fixes:
  - confirmed edit, repeat edit after shared cooldown, canonical/search proof;
  - committed request with client-side network ambiguity and authoritative reconnect;
  - rejected PIN with byte-for-byte unchanged transcript.
- `make check`: backend/frontend gates pass; unchanged fake-Bitwarden credential-helper script baseline remains 62/63.
- Final independent reviews: concurrency/correctness GO, privacy/security GO, UX/accessibility GO.

No real transcript, real PIN, provider request, or production mutation was used in tests.

## Deployment/rollback

Pending PR merge and exact deployment receipts for The-Sceptre and Tribe-Mac. Rollback may redeploy the prior Wayang/Pi artifact; already edited transcripts remain valid Pi JSONL and deleted content is intentionally not restored by code rollback.
