# Peer-session messaging: source-aligned implementation plan

**Status:** revised architecture; implementation unauthorized and not implementation-ready until both mandatory dependencies and the milestone authorization gates below are satisfied
**Date:** 2026-08-21
**Scope:** first-class Wayang session-to-session requests and replies; this is not connector transport messaging
**Authority:** planning does **not** authorize implementation, deployment, migration, private-data inspection, or live-session testing

## 1. Outcome and retained product decisions

A running Wayang session may send a bounded request to another eligible session. The target owns execution under its own immutable Project/Profile policy, tools, model, provider, runtime generation, and approvals. The sender cannot lend identity, capabilities, approvals, browser state, model selection, or filesystem authority. The target may produce a linked peer reply. A human has a separate inbox actor and can inspect or route peer messages without impersonating a model session.

Retained decisions:

1. Standard-to-Standard is the only initial privacy class. Any Protected, quarantined, unresolved-legacy, or privacy-unknown source or target fails closed.
2. Same-project delivery precedes cross-project delivery. Cross-project remains M5 and requires a separate rollout approval even if the privacy artifact permits it.
3. Idle eligible targets may eventually auto-wake, but only after M2 proves the Pi append/dispatch boundary and the per-session arbiter. Archived targets are initially non-wakeable and denied with an inbox-visible terminal reason; unarchive is a separate human action.
4. Target authority is always re-resolved at admission and immediately before projection, dispatch, reply, attachment open, and delivery.
5. Peer attachments are read-only Standard objects, not paths. They remain M4 and unavailable until a durable attachment object catalog exists.
6. Approval-required execution terminates as `continue_in_wayang`. No peer or sender handles a PIN or approval answer. A durable approval protocol would be a separate design and authorization.
7. Loop prevention and exact pre-dispatch quotas are mandatory before auto-run.
8. The peer mailbox is durable and independent of Pi branch selection. Pi events are provider/UI projections, never canonical protocol state.

## 2. Mandatory dependencies and authorization gates

Two separate prerequisites block **every** implementation milestone, including M0. Neither substitutes for the other.

### 2.1 Standard interop implementation dependency

Peer work has a mandatory dependency on the unmerged Standard interop branch at commit `89f322a`. That commit is evidence of direction, not an approved or consumable final dependency. Peer scope must **not** reimplement, cherry-pick, copy, absorb, or independently patch any part of it. The Standard interop owner must fix and review the following durable audit findings on that branch:

- **SI-1 — catalog classification before body parse:** catalog discovery must resolve and reconcile the durable catalog row, canonical path, and transcript header before parsing any transcript body. It must deny quarantined, unclassified/unknown, and project-conflicting sessions at that pre-parse boundary; quarantine eligibility is exact-false (`quarantined === false`), so missing, null, stale, malformed, or otherwise non-false values deny. Eligibility and the same durable row/path/header bindings must be rechecked immediately before committing a result. Regression tests must prove `parseBytes = 0` for every denied classification and for row/path/header conflict and race cases.
- **SI-2 — bounded `session_read`:** `session_read` must enforce a total processed-byte bound across scanning, skipping, decoding, and returned content, with a cursor/resume contract that cannot require rescanning an unbounded prefix. Regression coverage must include a high-offset request against a transcript with a large prefix and prove the total bound, not merely the response-size bound.

This dependency is satisfied only when a successor commit containing both fixes has independent review, the final integrated result is merged, and the exact final merged SHA is recorded here (replacing `PENDING`). The dependency record must include focused SI-1/SI-2 test evidence, the full repository test/check evidence, deployment evidence, and live verification of the deployed behavior using policy-safe/synthetic observations. Required record:

- reviewed successor fix commit: `PENDING`
- exact final merged SHA: `PENDING`
- focused SI-1/SI-2 tests: `PENDING`
- full test/check evidence: `PENDING`
- deployment and live verification: `PENDING`

Until every field is complete and reviewed, no peer milestone may begin and peer code must not consume the branch.

### 2.2 Privacy decision artifact dependency

Separately, a final, revisioned privacy decision artifact must define and approve the Standard/Protected read rules, attachment read/reference rules, and provider-retention/disclosure rules that govern peer payloads and projections. It must also resolve, in writing:

- which Standard session prose, peer payloads, provenance fields, replies, and attachment bytes may cross session and project boundaries;
- whether the target provider/model is allowed to receive each projected field and how provider retention is disclosed/handled;
- retention, deletion, backup, search-index, transcript-compaction, and branch-abandonment treatment;
- whether cross-project Standard delivery is approved or remains deferred to M5;
- whether model-generated peer replies may be projected back into the sender provider context automatically;
- the user-facing disclosure and consent model for idle auto-wake and metered provider use.

Required artifact revision and approval evidence: `PENDING`. Draft discussion, code behavior, commit `89f322a`, or approval of the interop dependency does not approve this artifact. **No milestone, including M0, may start until the final revision is explicitly approved.**

After both dependencies are complete, Clemente must explicitly authorize M0 implementation. Later progression is not implicit: M2 requires review of M1; M3 requires a separate auto-wake approval after M2 evidence; M4 requires a separate attachment approval after catalog evidence; and M5 requires a separate cross-project approval. Tests before those gates use synthetic homes, data directories, projects, sessions, providers, and transcripts only.

## 3. Source alignment and replacement boundaries

The implementation must integrate with, but not silently extend, these current surfaces:

| Current source | Observed contract | Required peer architecture |
|---|---|---|
| `backend/src/db.ts` | Versioned canonical Wayang metadata is a single-writer `store.json`; connector messaging rows are embedded there. | Peer protocol state uses a dedicated private SQLite database. Do not put peer payloads in `store.json` or `search.db`. `store.json` keeps only existing session/project/profile metadata. |
| `backend/src/messaging/*` | Connector endpoint transport, Matrix attestation, retries, and session port already exist. | Reuse concepts and the eventual arbiter ingress, not connector endpoint rows, sender authority, or connector retry assumptions. Peer requests are a distinct local protocol. |
| `backend/src/messaging/session-port.ts` | Connector turns can create runtimes and inspect `custom_message.details` for recovery. | Peer recovery reads the peer DB plus verified Pi projection content/entry IDs. `details` is never authority or collision evidence. |
| `backend/src/pi-bridge.ts` | Runtime registry, browser queue seam, compaction, model changes, tools, and connector prompt handling share a large lifecycle owner. | Add one session turn arbiter in front of every ingress and mutation. Do not add a parallel peer-only lock/queue. |
| `backend/src/session-runtime-mutation-lock.ts` | Process-local boolean exclusion only. | Replace/expand into durable-admission, process-owned lease/fencing semantics with ordered operation classes. |
| `backend/src/queued-chat-messages.ts` | Exact cancellation depends on pinned Pi private steering-queue layout. | Keep as a compatibility seam only behind the arbiter; peer correctness cannot depend on private queue mutation. |
| `backend/src/attachments.ts` | IDs are process-local; records retain host paths/inodes; prompt notes expose raw paths. | Not usable for peer attachments. M4 requires a durable no-follow object catalog first. |
| `backend/src/transcript-mutations.ts` | PIN-gated canonical JSONL rewrite, summary invalidation, runtime fencing, search fencing, and a recovery journal. | Peer projection kinds are protocol-owned and non-editable. Session purge coordinates transcript, peer DB, indexes, catalog, attachments, and projections under ordered locks/journals. |
| Pi session v3 | JSONL is a tree; `custom_message` participates in context; `details` is not provider-visible; compaction and branch summaries are lossy branch-local context. | Peer DB is canonical mailbox/server order. Versioned `custom_message` entries are branch-local projections only. |

The pinned repository artifact—not the globally installed Pi package—is the implementation target. M0/M2 tests must inspect and exercise `backend/earendil-works-pi-coding-agent-0.84.1-wayang.f351bec9.tgz` through the backend dependency resolution. This Pi artifact work is separate from the Standard interop dependency in section 2.1; peer scope may consume that dependency only after its reviewed successor is merged, its exact final merged SHA and evidence are recorded, and M0 is explicitly authorized.

## 4. Trust and authority model

### 4.1 Actors

- **Session actor:** an exact tuple `(session_id, runtime_generation, project_id, agent_profile_id)`, captured by a backend-created tool closure. It has no caller-supplied sender field.
- **Human actor:** the authenticated Wayang owner using an HTTP/UI route. It is never represented as a session actor and never invokes the model tool endpoint.
- **Target execution actor:** the target session’s newly re-resolved tuple and effective runtime policy. It is not the source actor.
- **System actor:** recovery, purge, retention, and projection workers operating through internal typed ports and fenced claims.

Display names, cwd, provider/model names, prompt text, Pi metadata, loopback origin, connector identity, and possession of a request ID are not authority.

### 4.2 Sender-bound custom tools

Eligible interactive runtimes receive backend-created closures such as:

```ts
peer_list_targets(): Promise<{ choices: PeerTargetChoice[] }>
peer_send(input: { choice_id: string; body: string; attachment_object_ids?: string[] }): Promise<PeerSendReceipt>
peer_reply(input: { reply_choice_id: string; body: string }): Promise<PeerReplyReceipt>
```

There is no `sender_session_id`, `sender_project_id`, `sender_profile_id`, arbitrary target ID, URL, provider/model selector, generic HTTP method, or approval/PIN field. Every call checks object identity for the exact installed tool definition and revalidates the captured tuple before any DB reservation.

`peer_list_targets` creates opaque random choices stored server-side. A choice binds exact source tuple, target session and immutable Project/Profile IDs, privacy decision revision, purpose (`send` or reply to one exact request), issuance/expiry, and a nonce. Choices are short-lived, single-use at reservation, process-generation-bound, and invalidated by model/profile/project/runtime/session changes. Expired, replayed, copied, or mismatched choices fail before payload persistence or provider work.

The human inbox uses separate authenticated routes and explicit human audit fields. It cannot mint a session tool choice or claim that a human-authored message came from a session.

## 5. Canonical peer protocol

### 5.1 Message kinds and identity

The peer DB recognizes exactly:

- `peer_request`
- `peer_reply`

A reply references one exact request and reverses its source/target sessions. V1 has no arbitrary broadcast, edit, reaction, approval, cancellation-as-message, nested attachment payload, or generic custom kind.

Every message has a random opaque `message_id`; every request has a random `request_id`; every causal conversation has a `root_request_id`. A reply has `in_reply_to_request_id`. IDs are never accepted as authority without the current bound actor/choice and DB relationship.

Canonical server sequence is a monotonic 64-bit integer assigned transactionally in the peer DB. Sequence determines mailbox order only. Connector timestamps, Pi entry order, wall clocks, and UI receipt order do not.

### 5.2 Canonical state versus projections

The peer SQLite rows are canonical for identity, payload hash, source/target bindings, server sequence, causal root/depth, quotas, retention, dispatch/reply status, and projection occurrences. Pi JSONL entries and frontend events are derived projections.

A Pi entry cannot create, edit, acknowledge, reject, or reply to a peer message merely by containing matching text or `details`. Reconciliation always starts from the peer DB row and verifies a recorded projection occurrence against the exact Pi entry/content digest.

Frontend inbox events are emitted from DB snapshots/change notifications. Reconnect reloads the DB snapshot. They are not reconstructed from Pi history.

### 5.3 Versioned Pi projections

Requests and replies project through these exact Pi kinds:

- request: `type: "custom_message"`, `customType: "wayang-peer-request-v1"`
- reply: `type: "custom_message"`, `customType: "wayang-peer-reply-v1"`

`display: true`. `details` may contain non-authoritative UI hints, but no authorization, dedupe, recovery, quota, or purge decision reads it. If details are missing, altered, exposed by a future provider adapter, or copied to another branch/session, security behavior is unchanged.

The provider-visible `content` uses one fixed, provider-tested frame. All variable fields are encoded in a single canonical JSON object on one physical line. JSON escaping converts CR/LF and controls so payload text cannot create a line-anchored close marker:

```text
<<<WAYANG_PEER_REQUEST_V1>>>
{"body":"...","message_id":"...","provenance":{"kind":"peer_request","source_label":"..."},"request_id":"...","server_sequence":"..."}
<<<END_WAYANG_PEER_REQUEST_V1>>>
```

Reply uses the corresponding `REPLY` markers and includes `in_reply_to_request_id`. Object keys and allowed fields are fixed and lexicographically serialized; strings are NFC, bounded UTF-8, and JSON escaped; unsafe controls/bidi formatting in labels are rejected; the frame has a versioned SHA-256 test vector. Provider-visible provenance is deliberately minimal and truthful: peer-agent origin, non-human status, safe source label, message/request IDs, and sequence. It never claims user authority or inherited approval. Host paths, project roots, profile instructions, provider details, hidden policy, attachment paths, and raw internal IDs not approved by privacy policy are absent.

M0 freezes canonical frame test vectors and the adversarial provider-conversion corpus. The first M2 substage must run that corpus through every supported pinned provider adapter: close-marker text, JSON quotes, backslashes, CR/LF, Unicode separators, bidi controls, long input, tool-like text, fake user/system tags, and nested peer frames. Acceptance requires byte-exact conversion showing the whole frame as one custom/provider message with no role escalation. Until those M2 tests and the universal arbiter gate pass, projections and dispatch are unavailable.

### 5.4 Tree, branches, compaction, and inbox behavior

Pi branch order is not mailbox order. A projection occurrence records `(message_id, target_session_id, pi_entry_id, parent_entry_id, active_leaf_before, content_sha256, projected_at)`. It is appended only under the arbiter’s transcript-write lease to the then-current target leaf.

If the user later branches before that occurrence, the projection is abandoned from active provider context but remains in Pi history. The canonical message remains visible and actionable in the independent inbox. It is not silently appended again and never auto-runs twice. A human may explicitly **project into current branch**; that operation creates a new occurrence linked to the same message, does not consume wake quota, and cannot redispatch an already dispatched request. The UI labels branch-local visibility separately from canonical read/reply state.

Compaction and branch summarization are lossy and cannot be canonical acknowledgement. Before M2 dispatch, a feasibility suite must prove at least one safe behavior for the pinned Pi artifact:

1. a recent projection survives `buildSessionContext()` byte-for-byte until intentionally compacted;
2. compaction/branch hooks can preserve a safe peer provenance summary without changing authority; and
3. abandoned projections do not become active merely because server sequence is later.

If preservation cannot be proven, peer projection/dispatch is NO-GO. M1 SQLite/mailbox/inbox-only may still operate because it has no Pi projection or provider invocation. After the complete M2 feasibility gate passes, compaction leaves inbox state complete; explicit re-projection is allowed only under the occurrence rules above.

### 5.5 Editing protections and protocol purge

Transcript mutation listing may display peer projections, but edit/delete endpoints reject `wayang-peer-request-v1` and `wayang-peer-reply-v1` with `protocol_owned_event`. No advanced-JSON bypass. Labels and unrelated entries retain existing behavior.

Removing peer payload/projections occurs only through the coordinated protocol purge in section 12. A content-free Pi tombstone may replace a projection while preserving tree position. Ordinary transcript mutation must not create a DB state transition, and DB retention must not rewrite Pi without the purge journal and locks.

## 6. Dedicated private SQLite database

### 6.1 Location and filesystem contract

Use `WAYANG_DATA_DIR/peer-messaging/peer.db`, not `search.db` and not the connector/search schemas. The parent is canonical, current-uid-owned mode `0700`; DB, WAL, SHM, migration lock, backup, and recovery journal artifacts are regular no-symlink files with owner-only permissions (DB/sidecars `0600`). Unsafe owner/type/link/mode/canonical-path state fails startup for peer messaging without replacing evidence.

Enable WAL, `foreign_keys=ON`, bounded `busy_timeout`, and explicit synchronous policy justified by crash tests. One backend-owned repository connection/service is the write authority; readers use bounded statements. No raw SQL or DB path is exposed to tools, UI, connectors, or providers.

### 6.2 Required schema families

- `schema_migrations(version, applied_at, migration_sha256)`
- `peer_messages` — immutable identity/bindings/kind/body/body hash/sequence/root/depth/created/retention
- `peer_request_state` — admission, projection, dispatch, settlement, reply, handoff, failure
- `peer_projection_occurrences` — exact Pi entry/branch/hash evidence
- `peer_dispatch_attempts` — fenced attempt, append/dispatch markers, provider call evidence, settled range, usage
- `peer_target_choices` — opaque binding/expiry/consumption (or process-private for M1, durable before recovery can consume them)
- `peer_quota_accounts`, `peer_quota_reservations`, `peer_quota_settlements`
- `peer_attachment_refs` — M4 catalog IDs only
- `peer_purge_operations`, `peer_purge_steps`
- `peer_attention` — bounded non-sensitive recovery/ambiguity notices

Payload rows and state rows use foreign keys and restrictive transitions. Bodies are bounded and never copied into diagnostics or ordinary logs.

### 6.3 Migration, validation, recovery, backup, rollback

Each migration is transactional, monotonic, checksum-pinned, and tested from every released peer schema. A newer/unknown schema fails closed. Startup performs `quick_check`, FK checks, exact schema/index/trigger validation, state-machine logical validation, sequence/root/reply/projection referential checks, quota conservation, and unfinished journal recovery before workers start.

Before a migration, create a SQLite-consistent backup through the backup API after checkpointing under the peer service lock; verify header, schema version, integrity, permissions, and logical validation before migration. Never byte-copy a live WAL database. Retain backups under a documented bounded owner-only policy.

Rollback is code/schema-specific:

- before migration commit: SQLite transaction rollback;
- after commit but before workers: restore only a verified backup while peer messaging is stopped and the DB lease is exclusive;
- after new protocol work exists: do not downgrade destructively; disable peer workers, export non-secret operator diagnostics, and use a reviewed forward repair/migration;
- rollback never claims to remove provider retention, transcript copies, backups, or external side effects.

Corruption or failed logical validation disables peer admission/dispatch and raises attention; it never initializes an empty replacement DB.

## 7. One per-session cross-ingress turn arbiter

### 7.1 Ownership

M2 introduces one arbiter per Wayang session. Every operation that can append, dispatch, alter effective context/runtime, or race a turn must enter it:

- browser first messages, steering, follow-ups, resend, and interrupt;
- peer request projection/dispatch and peer reply projection;
- connector turns and connector commands that change active session use;
- compaction and branch navigation;
- transcript mutation and coordinated purge;
- agent/profile and model/provider switch;
- scheduled work targeting an existing session;
- runtime creation/replacement/reattachment and recovery append.

Creating a wholly new scheduled session may stay outside until it first targets a session. No ingress calls `session.prompt`, Pi append, `session.steer`, queue internals, model switch, compaction, or transcript CAS directly.

### 7.2 Operation and lease model

Admission creates an immutable operation with session, actor kind, source ID/idempotency key, operation class, enqueue sequence, cancellation policy, approval policy, deadline, and required locks. Dispatch claims one operation with a monotonically increasing fencing token bound to runtime generation, transcript mutation epoch, active leaf, project/profile, model/provider, and current policy revision. Every async continuation rechecks the token before append, provider dispatch, state settlement, reply, or UI publication.

Lock order is global and exact:

1. purge coordinator/global catalog fence;
2. ordered session IDs (lexicographic full UUID);
3. peer DB transaction/claim;
4. session arbiter lease;
5. Pi transcript write/CAS lease;
6. runtime/provider dispatch lease;
7. search/index/attachment projection fences.

Never await provider or human input while holding SQLite write transactions or multi-session locks.

### 7.3 Priority, fairness, cancellation, approval, and crashes

Priority applies only before lease claim:

1. denial/revocation/purge fences and active cancellation;
2. authenticated human interrupt and already-admitted human-gate resolution;
3. browser direct turns and steering;
4. accepted connector/peer/scheduled existing-session turns in server sequence;
5. compaction/maintenance and background reprojection.

FIFO holds within a class. Bounded aging prevents starvation, but background work never jumps an interactive turn already ready to claim. Capacity limits apply before payload acceptance where possible.

Queued cancellation removes one exact arbiter operation by opaque operation ID. Active cancellation aborts the exact fenced runtime call, marks outcome conservatively, and never auto-replays. Existing pinned Pi queue capture may implement browser compatibility after the arbiter has assigned identity, but incompatibility fails only that cancellation and cannot clear unrelated work.

An approval/questionnaire/PIN/browser/secret requirement from an auto-run peer operation is terminal `continue_in_wayang`; the arbiter cancels/denies the pending target-owned gate according to its native lifecycle and releases the lease. The sender receives no gate object and can never answer it. A later human continuation is a new human operation, not completion authority for the peer worker unless a separately designed durable protocol is authorized.

On restart, unclaimed durable ingress remains queued. A claimed operation with no provider-dispatch evidence may be reconsidered only by the M2 split-boundary rules. Any claim at or beyond ambiguous dispatch becomes terminal attention/no-auto-replay. Fencing prevents stale process continuations from publishing.

## 8. Split Pi append/dispatch feasibility milestone

Current high-level prompt APIs do not establish an implementation-safe boundary between durable user/context append and provider dispatch. M2 must first prove or add, in the pinned downstream Pi artifact, a reviewed API that separates:

1. append an exact versioned peer `custom_message` projection and durably return its entry ID/current leaf;
2. commit the peer DB projection/attempt marker;
3. dispatch provider work from that exact leaf/range without appending a second user-equivalent message; and
4. expose authoritative dispatch-start and settled-range evidence.

Required evidence tests cover all built-in provider transports used by Wayang, retries, stream disconnects, aborts, context overflow recovery, automatic compaction, tool calls, tool-only completion, provider error entries, runtime teardown, service crash after every boundary, and branch/model/profile changes.

Until the universal arbiter and split append/dispatch feasibility are both completed and reviewed in M2, M1 remains strictly peer SQLite/mailbox/inbox only: **no Pi projection, provider invocation, target turn, auto-run, wake, or auto-replay**.

### 8.1 Attempt markers and conservative failure table

The peer DB, not Pi details, records these monotonic facts:

- `reserved` — quota and exact attempt claim committed;
- `projection_appended(pi_entry_id, parent_id, content_sha256)`;
- `dispatch_started(provider_attempt_id, runtime_generation, leaf_id)` — only if Pi/provider transport exposes trustworthy evidence;
- `settled(first_entry_id, terminal_entry_id, terminal_kind, usage)`;
- `reply_committed(reply_message_id)`;
- terminal `failed_safe`, `failed_ambiguous`, `continue_in_wayang`, or `settled_without_reply`.

Rules:

| Last proven fact | Recovery behavior |
|---|---|
| reservation only; no Pi append and no dispatch evidence | release/re-reserve under policy; one retry allowed with same logical request and new fenced attempt |
| projection appended; dispatch provably not started | may dispatch once from exact recorded leaf after all bindings/quota are revalidated |
| dispatch may have started, stream disconnected, process crashed, or marker write failed | `failed_ambiguous`; never auto-replay |
| provider emitted an error/aborted terminal | settle usage conservatively; no replay; inbox error |
| tools ran but no assistant prose/reply | `settled_without_reply` unless `peer_reply` committed |
| `peer_reply` DB commit succeeded, then tool result/assistant/service crashed | reply remains canonical; idempotent projection/delivery may resume; never insert a second reply |
| assistant prose exists but no `peer_reply` call | do not infer or auto-copy prose as a reply in v1 |
| context overflow compaction then retry | allowed only if Pi proves the original provider attempt did not execute and exact projection provenance remains on the active branch; otherwise ambiguous |

A settled range is the exact active-branch entries from the recorded projection through Pi’s authoritative terminal state. Merely observing `turn_end`, `agent_end`, WebSocket close, an assistant-looking event, or an empty queue is insufficient. M2 tests must define terminal kinds for normal assistant completion, tool-only completion, provider error, abort, and overflow recovery.

## 9. Requests, replies, and approval behavior

A target dispatch receives the request projection as non-human peer context and the target’s backend-bound `peer_reply` closure. The provider instruction says it may reply only through that tool when it has a response for the source; ordinary assistant prose remains target-session work and is not automatically disclosed.

`peer_reply` binds exact target tuple, root/request ID, source destination, and dispatch attempt. It accepts only reply body (and M4 catalog refs). The DB transaction validates one permitted reply according to the v1 cardinality policy, consumes the reply choice, inserts `peer_reply`, links it to the request, and settles any quota component. Tool retries return the same receipt by idempotency key. A source projection worker may then append `wayang-peer-reply-v1` under the source arbiter; failure to project does not lose the reply from inbox.

If the target needs approval, PIN, sudo, interview/questionnaire, browser user mode, secret input, payment, MFA, CAPTCHA, or other human-only interaction, the attempt ends `continue_in_wayang` with the target session’s canonical URL. It is not left running and the source receives only the non-sensitive reason code. The target human can continue in Wayang under normal target authority. The source session and source model never receive, render, store, or transmit a PIN.

## 10. Exact quotas, loop prevention, and metering

### 10.1 Causal loop controls

Every request carries canonical `root_request_id`, `parent_message_id`, and `depth`. V1 limits one directed edge per `(root, source_session, target_session, request_kind)` and rejects self-send unless separately authorized (default deny). A target cannot peer-send from an auto-run unless the root policy permits it and depth remains below the fixed ceiling. Replies do not create new roots or wake chains.

### 10.2 Predispatch reservation

Before projection that can auto-run, atomically reserve exact ceilings for:

- input plus maximum output tokens for this target model/context;
- maximum target tool calls;
- one idle wake if the target is stopped;
- root cumulative tokens/tool calls/wakes;
- source and target per-day tokens/tool calls/wakes;
- global peer per-day safety ceiling.

Reservation binds request, root, source/target, UTC accounting day, model/provider/context metadata revision, dispatch attempt, and expiry. Context calculation includes system/profile instructions, active-branch context, the exact peer frame, tool schemas, and configured maximum output. Tool-call ceiling is enforced in the target tool dispatcher, not estimated after execution.

If model context/max-output metadata, active-context measurement, usage accounting capability, current day account, or tool-call enforcement is unavailable or stale, metered auto-run is denied before projection/dispatch. There is no “best effort” unmetered wake.

Settlement consumes trustworthy provider token usage and exact observed tool calls/wake. Unused reservation is released atomically. Missing/invalid provider usage or an ambiguous attempt is charged at the full reserved token amount; observed calls are charged, with the reserved ceiling retained where call completion is ambiguous. Reconciliation proves conservation: `available + active reservations + settled use = configured budget` for every account. Expired reservations are reclaimed only after dispatch state proves no ambiguity.

Quota denial leaves the request in inbox as `paused_quota` without provider-visible projection or wake. A human may open the target and act separately; that does not silently bypass peer accounting.

## 11. Idle and archived targets

M1 never wakes. M3 may wake only an active, non-archived, non-quarantined session whose exact Project/Profile/policy remains eligible and whose runtime is stopped/idle with no pending switch, mutation, human gate, connector turn, scheduled run, or purge.

Archived targets are initially **denied and non-wakeable** (`target_archived`). This is safer than accumulating hidden paused work and avoids archive/unarchive races. The canonical request may remain in the source’s sent view with the terminal denial, but no target projection is created. If product requirements later prefer queued/paused delivery, that is a separate decision requiring visible target inbox semantics and quota/retention rules.

Inbox visibility is independent of runtime and Pi active branch. An abandoned branch, stopped runtime, model switch, or compaction cannot hide or acknowledge canonical mail.

## 12. Durable attachment catalog prerequisite

M4 starts only after Wayang has a durable attachment object catalog with:

- stable random object ID independent of process lifetime and path;
- immutable source session/project/privacy class and creator actor;
- canonical storage root/object key, byte length, MIME declaration, SHA-256, creation/retention state;
- deletion/tombstone state and reference counts/edges;
- owner/type/mode/no-symlink/no-follow regular-file validation;
- descriptor reopen with device/inode/size/hash revalidation immediately before every read;
- bounded bytes/counts and exact read-only target grant;
- purge and backup semantics integrated with session deletion.

Peer APIs accept only catalog object IDs selected through a source-bound opaque choice. They never accept or return raw prompt paths, process-registry IDs, filenames as authority, `file://` URLs, project-relative escapes, or arbitrary attachment IDs. The target receives a backend-owned read-only reference/projection approved by privacy policy. Deletion or hash mismatch fails before provider/tool use. No peer implementation may reuse today’s process-local `attachmentRegistry` as durable provenance.

## 13. Multi-session purge and completion semantics

Session permanent deletion, peer retention expiry, and explicit peer purge use one coordinator. It identifies every affected source/target session, message/reply/root, projection occurrence, quota reservation, index row, attachment reference/object, and compaction/branch-derived copy known to Wayang. It acquires global and full-session locks in the order from section 7, writes a content-free durable operation journal, fences new ingress, and advances idempotent steps.

Required steps:

1. freeze affected peer roots/messages and deny new choices/replies/dispatch;
2. cancel queued operations and conservatively settle active/ambiguous attempts;
3. tombstone/remove canonical peer payloads according to requested scope;
4. replace every known Pi projection with a content-free protocol tombstone through atomic CAS while preserving tree shape;
5. invalidate dependent compaction/branch summaries when exact non-inclusion cannot be proven;
6. purge peer inbox/search projections and existing `search.db` rows that contain projected prose;
7. drop attachment references and purge eligible objects through the attachment catalog;
8. reconcile session metadata/catalog and publish invalidations;
9. logically validate peer DB, Pi occurrence coverage, indexes, attachments, and quota conservation;
10. mark the journal complete and release fences.

Recovery resumes the exact journal; it never guesses completion from missing files. Ordered locks prevent source/target reciprocal-message deadlocks. A session cannot be reported permanently deleted while peer payload or known projection cleanup is pending.

**Purge completion** means canonical Wayang/Pi live storage, peer inbox, local indexes, and catalog-governed attachment objects named by the operation have reconciled successfully and future provider context/search cannot retrieve those known live copies. It does not mean secure media erasure and does not remove provider retention, remote connector history, backups/snapshots, swap, forensic remnants, external side effects, or untracked paraphrases. Partial failure remains `attention_required`, keeps affected search/dispatch denied, and is not presented as success.

## 14. API and UI boundaries

### Session tools

Only the sender-bound closures in section 4.2. Results expose opaque receipts, safe labels/status, and canonical Wayang handoff URLs when permitted. They do not enumerate raw filesystem paths, arbitrary sessions, private projects, provider details, quota internals, or peer bodies outside the exact actor’s mailbox relationship.

### Human inbox

Authenticated same-origin routes provide paginated inbox/sent/reply status and terminal errors. Browser auth/origin checks apply consistently. Inbox WebSocket/SSE uses the same auth and reloads authoritative DB state after gaps. Human actions carry the human actor and cannot be consumed as session-tool provenance. Branch visibility and projection/handoff actions are M2-only and remain absent from M1.

M1 UI shows only mailbox-backed source/target safe labels, request/reply kind, canonical server sequence/time, state, privacy warning, and non-sensitive failure. It does not expose a projection action or imply that a model was invoked. M2 may add runtime/wake eligibility and branch-projection state while keeping “stored in inbox,” “projected to model,” and “model dispatched” distinct.

### Logs and diagnostics

Ordinary logs include opaque operation/message/session prefixes, state transitions, durations, quota units, and sanitized reason codes only. No bodies, replies, frames, attachment names/bytes/paths, prompts, tool arguments/results, provider payloads, PINs, or private labels. Debug traces and database backups are private artifacts and never generated from production content for tests.

## 15. Rollout stages and gates

### M0 — protocol and dedicated DB foundation

**Entry gate:** both section 2 dependencies are complete and recorded, then Clemente explicitly approves M0 implementation. Dependency completion alone is not authorization.

- freeze `peer_request`/`peer_reply`, IDs, roots/depth, states, framing, size bounds, retention, and the approved privacy decision revision;
- implement dedicated private SQLite repository, migrations, WAL/permissions, consistent backup, startup recovery, integrity and logical validation, rollback tooling;
- specify and freeze the provider conversion/framing corpus and the pinned-Pi custom-message/branch/compaction/split-dispatch feasibility corpus for execution in M2;
- design protocol-owned transcript edit rejection and purge seams without installing projection behavior;
- no human inbox rollout, Pi projection, target/provider invocation, turn, wake, attachment, or cross-project operation.

**Exit gate:** DB crash corpus and canonical frame-vector tests pass; the M2 arbiter and pinned-Pi/provider feasibility corpus is reviewable. Provider-adapter execution remains M2. A failure can stop the project before mailbox rollout.

### M1 — peer SQLite/mailbox/inbox only

- add the authenticated human inbox/sent UI and authoritative events sourced only from peer SQLite;
- add same-project Standard mailbox admission and exact sender-bound target-list/send/reply closures only as approved by the privacy artifact;
- store and route canonical mailbox requests/replies without writing Pi JSONL or creating/resuming/invoking a target runtime;
- do **not** install manual or automatic Pi projection, provider dispatch, target turns, compaction hooks, or wake behavior;
- archived/Protected/quarantined/unresolved targets deny;
- implement retention and multi-session purge for peer SQLite/mailbox/inbox state only; attachments remain absent.

**Exit gate:** adversarial authority, mailbox ordering/state, deletion/recovery, retention, and UI-auth tests pass; M1 receives explicit review before any M2 work. The supported fallback remains M1 inbox-only.

### M2 — universal arbiter, split feasibility, then running-target projection/turn

M2 is ordered. Its first substage must complete and review both prerequisites **before any peer Pi projection or target turn exists**:

1. route browser messages/steering, connectors, peer ingress, compaction/branching, transcript mutation/purge, model/profile/provider switches, runtime transitions, and scheduled existing-session work through the one universal all-ingress arbiter; and
2. prove or add the downstream pinned-Pi split durable-append/provider-dispatch API, including branch/compaction preservation and authoritative dispatch-start/settled-range evidence, against the frozen corpus.

Only after that internal gate passes may M2 add versioned Pi projections and provider turns for already-running eligible targets. Then:

- add provider markers, settled ranges, exact cancellation/fencing, approval terminal handoff, conservative ambiguous failure, and no-auto-replay;
- require exact predispatch token/tool/root/day reservations;
- keep stopped/idle targets non-wakeable and attachments/cross-project delivery disabled.

**Exit gate:** crash-at-every-boundary matrix, universal all-ingress race tests, pinned provider-transport evidence, branch/compaction evidence, quota conservation, and tool-only/error/reply-crash semantics pass. If either prerequisite cannot be proven, do not project or invoke; remain at M1.

### M3 — idle auto-wake (separate approval)

- starts only after M2 evidence is reviewed and Clemente separately approves auto-wake;
- add bounded idle-target wake claims through the arbiter;
- enforce wakes/root/day and global/day reservations, loop/depth limits, runtime-generation fencing, stop/idle eligibility, and attention;
- keep archived targets denied and no Protected targets;
- opt-in rollout with synthetic then one low-risk Standard endpoint/session pair.

**Gate:** separate auto-wake approval, privacy disclosure accepted, ambiguity/restart/loop/load tests pass, operational pause switch and rollback rehearsed.

### M4 — attachments after durable catalog (separate approval)

- starts only after the general durable attachment object catalog has landed, passed review/evidence, and Clemente separately approves peer attachments;
- then add source-bound catalog choices, Standard read-only grants, digest/no-follow reopen, retention/refcounts, UI, quotas, and coordinated purge;
- no raw paths, process registry provenance, or inherited target write authority.

**Gate:** separate attachment approval plus privacy/security review and deletion/backup recovery evidence.

### M5 — cross-project Standard (separate approval)

- starts only after the final privacy artifact explicitly permits cross-project disclosure, earlier milestone evidence is reviewed, and Clemente separately approves cross-project rollout;
- target choice and every dispatch reauthorize immutable source/target Project/Profile IDs;
- validate target provider disclosure and attachment policy independently;
- roll out pair allowlists before any general Standard target listing.

Protected crossing remains out of scope unless separately redesigned and authorized.

## 16. Validation matrix

### Protocol/DB

- exact kinds/schema/unknown-field rejection and UTF-8 byte limits;
- dedupe collision, reply reversal/cardinality, root/depth/edge loops, 64-bit sequence order;
- WAL restart, torn operation, busy writer, migration interruption, backup restore, newer schema, corruption, FK/integrity/logical failure;
- quota reservation/settlement conservation and ambiguous full charge;
- retention/purge journals and reciprocal-session lock order.

### Authority/privacy

- forged sender/target/project/profile/runtime generation and copied/expired/replayed choice;
- human route cannot mint session provenance; session tool cannot claim human actor;
- Protected/quarantined/legacy/unresolved/archived/pending-switch/scheduled targets denied;
- policy/profile/project/model/runtime changes at every await;
- no PIN/approval/gate leakage; `continue_in_wayang` is terminal;
- logs, API errors, frames, backups, and UI snapshots contain no prohibited data.

### Pi projection/arbiter

- exact pinned artifact and every provider adapter conversion;
- malicious close markers/newlines/bidi/fake roles/tool syntax remain one escaped custom message;
- details absent/changed/copied never changes recovery or authority;
- active leaf, abandoned branch, explicit reprojection, compaction, branch summary, model switch;
- all cross-ingress pairwise races, priorities/fairness, exact cancellation, stale fencing;
- append crash, dispatch crash, disconnect, provider retry, overflow compaction, errors, tool-only settlement, reply commit crash;
- no automatic replay after ambiguity and no duplicate reply/projection occurrence.

### Purge/attachments

- source deletion, target deletion, reciprocal roots, active/queued/ambiguous work, off-branch projections, summaries, search rows;
- recovery after every purge step and truthful partial-failure UI;
- stable catalog ID, deleted/replaced/symlink/hardlink/inode/size/hash races, refcount, backup/restore;
- absence of raw path and process-registry attachment authority.

### Operational commands (implementation sessions only)

Run through the normal repository command surface after authorization:

```sh
make doctor
npm --prefix backend test -- <focused peer/arbiter/purge tests>
npm --prefix backend run build
npm --prefix frontend test -- <focused inbox tests>
make check
make test-e2e
```

No command execution is part of this planning revision.

## 17. Rollback and operational controls

A startup-immutable peer feature gate defaults off. Independent controls pause admission, projection, dispatch, and auto-wake denial-first; pausing never discards canonical queued/inbox rows. Revocation invalidates choices and claims, fences runtime work, and cannot undo provider calls, tools, files, or replies already committed.

Roll back a milestone by stopping new admissions, pausing dispatch/wake, allowing only bounded cancellation/reconciliation, backing up and validating the peer DB, and deploying code that understands its schema. Never restore an old DB over newer live work or delete WAL/SHM files manually. M3 rollback returns to inbox/M2 without replaying ambiguous requests. M4 rollback disables new attachment references but preserves catalog objects until reference/purge reconciliation.

## 18. Implementation ownership

- **Protocol/SQLite owner:** schema, migrations, validation, backup/recovery, retention, quotas.
- **Pi integration owner:** pinned artifact feasibility, versioned custom messages, append/dispatch split, settled ranges, compaction/branch tests.
- **Arbiter owner:** every ingress integration, priority, fencing, cancellation, model/mutation/compaction coordination.
- **Security/privacy owner:** actor/choice bindings, Standard/Protected policy, framing corpus, log/API review, approval handoff.
- **Purge/catalog owner:** ordered multi-session coordinator, search/index/transcript cleanup, later attachment catalog.
- **Frontend owner:** human inbox actor, authoritative reload, branch/projection/wake/ambiguity states.
- **Integrator:** owns cross-component state machines and crash/race test matrix; no component lands auto-run independently.

## 19. Decision record

| Decision | Resolution | Rationale / consequence |
|---|---|---|
| Canonical storage | Dedicated private `peer.db` SQLite; Pi/frontend are projections. | Avoids abusing `search.db`, `store.json`, and branch-local JSONL as mailbox authority. |
| Protocol kinds | `peer_request` and `peer_reply`; Pi custom types `wayang-peer-request-v1` / `wayang-peer-reply-v1`. | Exact versioning, migration, purge, and rendering behavior. |
| Provider provenance | Fixed one-line canonical-JSON escaped frame; minimal visible provenance; details untrusted. | Prevents role/framing injection and reliance on provider-hidden metadata. |
| Target authority | Target’s current exact Project/Profile/runtime policy only. | No borrowed sender identity, tools, approvals, provider, or capabilities. |
| Tool authority | Backend sender-bound closures plus expiring opaque choices; human actor separate. | No caller-supplied sender/target IDs or generic HTTP bridge. |
| Ordering | Peer DB server sequence for mailbox; Pi active-tree order only for context. | Branching cannot reorder/lose canonical mail. |
| Abandoned branches | Inbox persists; explicit non-dispatching reprojection permitted. | No duplicate execution while restoring context visibility. |
| Turn concurrency | One per-session arbiter for all ingress/mutation/model/compaction work. | Eliminates peer-only race fixes and hidden competing queues. |
| Dispatch retry | Split append/dispatch must be proven; ambiguous provider execution never auto-replays. | Prefers visible failure over duplicate tools/external effects. |
| Initial approval behavior | Terminal `continue_in_wayang`; sender never handles PIN. | Existing approval presence is human/browser-owned, not transferable. |
| Archived targets | Denied/non-wakeable initially. | Archive remains an explicit human state, not a hidden work queue. |
| Attachments | M4 after durable catalog; IDs only, read-only Standard, no paths. | Current process registry/raw prompt paths are not durable authority. |
| Metering | Exact predispatch reservations for tokens/tools/wakes/root/day; missing metadata denies auto-run. | Prevents unbounded loops and unaccounted provider use. |
| Cross-project | M5 only after an explicit separate approval, even if the privacy artifact permits it. | Keeps same-project rollout separable from broader disclosure and prevents policy approval from implicitly authorizing rollout. |
| Protected | Denied in this plan. | Requires a separate privacy/authority design and authorization. |

## 20. Definition of implementation readiness

This plan is ready to assign for M0 only when (1) the Standard interop successor fixes SI-1/SI-2, receives independent review, is merged, and has its exact final merged SHA plus focused/full/deployment/live evidence recorded; (2) the separate final revisioned privacy decision artifact is explicitly approved; (3) Clemente explicitly authorizes M0; and (4) owners agree on the state machine, lock order, and frozen pinned-Pi feasibility corpus. Implementation remains unauthorized now. This plan is not evidence that Pi split dispatch, compaction preservation, provider framing, durable attachment provenance, auto-wake, attachments, or cross-project delivery is feasible or approved. Those are executable and separately authorized gates, not assumptions.
