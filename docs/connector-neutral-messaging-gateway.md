# Connector-neutral messaging gateway and Matrix adapter

**Status:** architecture resolved; foundation implementation begun 2026-08-09
**Primary adapter:** Matrix Application Service (Element is the first client)
**Future adapters:** Slack first, then other chat systems where the same contract fits

## 1. Goal

Let reviewed Wayang Project–Agent Profile pairs appear as chat endpoints. A user can talk to an agent from Matrix, create a fresh Wayang session, list sessions belonging to that endpoint, select an earlier session, and inspect status without opening the Wayang web UI.

The feature belongs to Wayang, but Matrix must remain an adapter rather than becoming Wayang's conversation model. A future Slack adapter should reuse endpoint, participant, session-binding, idempotency, command, and delivery semantics without importing Matrix room or virtual-user concepts into the core.

Initial deployment targets:

- a Memoriki endpoint using the Wren profile;
- a Personal Finances endpoint using the Finance profile.

The endpoint configuration must reference immutable Project and Agent Profile IDs. Names are display metadata and never confer authority.

## 2. Decisions resolved in the requirements interview

- One stable virtual Matrix user per Wayang Agent Profile.
- A Matrix room represents one declared Project–Agent Profile endpoint.
- One active Wayang session is shared by all authorized human members of that room.
- Matrix is the first adapter; Slack compatibility is an architectural requirement, not a first-release implementation requirement.
- Connector adapters are optional modules in the Wayang backend and call a connector-neutral internal service.
- Rooms are automatically created or reconciled only for reviewed endpoint declarations.
- Arbitrary invites, aliases, room names, or user-authored room state cannot expose a new Wayang endpoint.
- Portable commands are canonical: `!new`, `!sessions`, `!use`, `!status`, and `!help`.
- The first adapter sends a typing indicator and then final answer messages; streaming edits are deferred.
- Privileged or secret-bearing interaction surfaces fail closed and tell the user to continue in Wayang. Messaging never accepts a password, PIN, MFA, CAPTCHA, payment detail, sudo approval, browser handoff, or external-action approval.
- The target homeserver is self-hosted Tuwunel with public registration and federation disabled.
- The operator explicitly accepts unencrypted, invite-only rooms for the initial Finance endpoint. This acceptance is endpoint-specific and must be visible in configuration/status; it must not silently become the default for other deployments.

## 3. Non-goals for v1

- Replacing the Wayang web UI.
- Exposing arbitrary Wayang projects or profiles through chat.
- Treating Matrix/Slack authentication as general Wayang authentication.
- Accepting chat-side Project/Profile provisioning.
- E2EE, attachments, audio, reactions as prompts, message edits as prompt rewrites, or redaction-driven transcript deletion.
- Full rendering of tools, thinking, questionnaires, approvals, browser state, or command-guard UI.
- Permanent session deletion from chat. `!new` changes the active binding but preserves the old session.
- Multi-tenant isolation. Wayang remains a privileged, cooperative single-OS-user workbench.
- Slack implementation in the Matrix milestone.

## 4. Vocabulary and invariants

### 4.1 Endpoint declaration

A reviewed declaration contains:

- stable endpoint ID;
- connector ID (`matrix`, later `slack`);
- connector-local provisioning key;
- immutable Wayang Project ID;
- immutable Agent Profile ID;
- display name;
- shared conversation mode;
- exact connector subject allowlist;
- explicit transport-security policy.

The declaration is authority. External room/channel metadata is not.

### 4.2 Provisioned conversation

A provisioned conversation binds an endpoint to one exact external conversation ID, such as a Matrix room ID or Slack channel ID. The adapter may create or find a canonical conversation using its provisioning key, but it must persist the exact returned ID before processing prompts.

A lookalike room name or alias never matches a durable binding.

### 4.3 Session binding

Each endpoint has at most one active Wayang session. `!new` atomically creates and activates a session for the endpoint's exact Project/Profile pair. `!use` atomically activates an existing eligible session after rechecking:

- session exists and is not archived/quarantined;
- session's exact immutable Project ID matches the endpoint (cwd is never sufficient authority; legacy rows must be uniquely resolved and backfilled first);
- session Agent Profile ID matches the endpoint;
- current project/profile policy still authorizes interactive execution.

An endpoint cannot adopt a session solely because a user knows its ID.

### 4.4 Participant policy

V1 is allowlist-only. Before every inbound operation—including read-only/help/error commands—and again before every outbound delivery, the adapter obtains a fresh, complete joined-membership and observed-confidentiality snapshot and projects only human participants to the gateway. The gateway binds that attestation to the exact normalized event sender and requires:

- event sender and attested sender are identical and joined;
- sender is allowlisted;
- every joined human is allowlisted;
- connector and external conversation match the durable endpoint binding;
- the snapshot is complete, boundedly fresh, and meets the endpoint transport-security policy.

If an unexpected human joins, the endpoint fails closed for everyone until membership is corrected. Managed Application Service users are excluded from the human snapshot by an adapter-owned exact namespace check, not by display name.

## 5. Architecture

```text
Matrix homeserver                    Future Slack API
       │ AS transactions / CS API           │ events / Web API
       ▼                                    ▼
┌─────────────────────────────────────────────────────────────┐
│ Optional connector adapters                                 │
│  MatrixAdapter                 SlackAdapter (future)         │
│  - token verification          - signature verification      │
│  - transaction ledger          - event retry ledger          │
│  - virtual users/rooms         - bot/channel/thread mapping  │
│  - membership snapshots        - membership snapshots        │
│  - typing/final sends          - typing/final sends          │
└──────────────────────────────┬──────────────────────────────┘
                               │ normalized events/commands
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ MessagingGatewayService                                     │
│  - endpoint declarations and durable bindings               │
│  - participant authorization                                │
│  - inbound idempotency and per-endpoint ordering            │
│  - semantic commands                                        │
│  - active Wayang session binding                            │
│  - safe outbound projection / Wayang handoff notices        │
└──────────────────────────────┬──────────────────────────────┘
                               │ internal typed port only
                               ▼
┌─────────────────────────────────────────────────────────────┐
│ WayangSessionPort                                            │
│  - resolve exact Project/Profile                             │
│  - create/list/select eligible sessions                     │
│  - create/attach Pi runtime under current policy             │
│  - submit one connector-originated turn                      │
│  - await authoritative settled/failure result                │
│  - never attach connector as a privileged approval client    │
└─────────────────────────────────────────────────────────────┘
```

### Why an internal port, not `/ws/chat`

`/ws/chat` is a browser transport with browser selection generations, history snapshots, queue acknowledgements, interviews, sudo, command-guard challenges, and external-action approval presence. A Matrix adapter must not impersonate that browser authority.

Refactor the smallest reusable session-turn lifecycle into an internal `WayangSessionPort`. Both `/ws/chat` and `MessagingGatewayService` may call it, but each transport retains its own authorization and projection. Do not have the adapter connect to Wayang over its passwordless loopback HTTP/WebSocket surface.

## 6. Core contracts

Initial source ownership:

```text
backend/src/messaging/
  contracts.ts              connector-neutral types
  commands.ts               portable command grammar
  endpoint-policy.ts        declaration and participant validation
  gateway-service.ts        orchestration and endpoint serialization
  session-port.ts           narrow Wayang lifecycle interface
  store.ts                  durable endpoint/binding/event repositories
  connectors/
    matrix/                  Matrix-only protocol and provisioning
```

The core must not import a Matrix SDK. Adapters depend inward on the core contracts.

Each adapter implements a connector-neutral `MessagingConnectorAttestationPort` that fetches a complete current human-membership and observed-confidentiality snapshot for one exact durable binding and normalized event. The gateway—not adapter event callbacks—owns when it is called: at admission, immediately before a queued/recovered operation executes, and immediately before every outbound delivery/retry. An unavailable, incomplete, stale, or mismatched attestation blocks the operation.

### 6.1 Normalized inbound event

Required fields:

- connector ID;
- connector event ID;
- exact external conversation ID;
- sender subject ID;
- plain-text body;
- connector timestamp (display/audit only, never ordering authority);
- optional reply metadata for presentation only.

Attachments and edits are rejected or ignored with explicit behavior in v1.

### 6.2 Normalized outbound delivery

The gateway emits semantic output:

- typing on/off;
- final assistant text;
- command result notice;
- non-sensitive error;
- `continue_in_wayang` handoff notice.

The adapter decides Matrix `m.room.message` or future Slack message formatting and deterministic transaction IDs.

### 6.3 Session port

The port should expose domain methods rather than Pi objects:

```ts
interface WayangMessagingSessionPort {
  createSession(binding, title): Promise<SessionSummary>;
  listEligibleSessions(binding, limit): Promise<SessionSummary[]>;
  resolveEligibleSession(binding, sessionId): Promise<SessionSummary>;
  getStatus(binding): Promise<EndpointStatus>;
  runTurn(binding, origin, input): Promise<SettledTurnResult>;
}
```

Every method re-resolves immutable Project/Profile rows and calls current interactive policy immediately before mutation/runtime creation. Connector callers never choose cwd, provider, model, tools, or capabilities. `resolveEligibleSession` validates and returns a candidate only; the endpoint repository remains the sole active-binding compare-and-set owner. `origin` carries the stable `(connector_id, connector_event_id, endpoint_id)` key into a durable non-user-visible Pi entry/turn marker so restart reconciliation can distinguish two legitimate identical prompts from a retried event.

## 7. Command contract

Commands are deterministic gateway operations and are not sent to the model.

- `!new` — create a new Wayang session for the endpoint pair and make it active. Preserve every older session.
- `!sessions` — list recent eligible sessions for this exact pair with stable selection handles and active marker.
- `!use <handle>` — activate one exact/uniquely resolved eligible session.
- `!status` — endpoint display name, connector, Project/Profile names, active session, running/queued state, participant policy status, and transport-security warning.
- `!help` — show supported commands.
- `!!text` — escape command interpretation and submit `!text` as an ordinary prompt.
- unknown `!commands` — return help; never pass them through to the agent accidentally.

V1 serializes every operation per endpoint. The gateway assigns a monotonic acceptance sequence transactionally when an event is durably admitted; connector timestamps and batch order are evidence but never the durable ordering authority. If a turn is active, ordinary messages queue by this acceptance sequence up to a small fixed bound; overflow fails explicitly. `!new` and `!use` do not race an active turn. A later milestone may add `!interrupt` after its multi-user authority semantics are reviewed.

## 8. Durable data model

A later milestone adds a versioned store migration. Suggested rows:

```ts
type MessagingEndpointRow = {
  endpoint_id: string;
  connector_id: string;
  provisioning_key: string;
  project_id: string;
  agent_profile_id: string;
  display_name: string;
  conversation_mode: "shared";
  declaration_sha256: string;       // exact current reviewed declaration revision
  external_conversation_id: string | null;
  active_session_id: string | null;
  revision: number;
  created_at: number;
  updated_at: number;
};

type MessagingInboundEventRow = {
  connector_id: string;
  connector_event_id: string;
  endpoint_id: string;
  external_conversation_id: string;
  sender_subject_id: string;
  body: string;                     // bounded recoverable work item; terminal-retention policy applies
  body_sha256: string;
  canonical_event_sha256: string;   // immutable identity/sender/room/body collision witness
  acceptance_sequence: number;
  state: "accepted" | "processing" | "completed" | "rejected" | "failed";
  wayang_session_id: string | null;
  outbound_delivery_id: string | null;
  accepted_at: number;
  completed_at: number | null;
};
```

Do not store Application Service tokens, Slack secrets, raw credentials, or private profile instructions in `store.json`. Secret configuration is loaded opaquely from an owner-only file/path and never returned by APIs. Current reviewed declarations are the sole endpoint authority; durable rows cache only their hash plus provisioning/session state. A missing or changed declaration disables the endpoint until reconciliation succeeds, so stale allowlists or transport policy cannot remain authoritative. Bounded raw prompt bodies are retained only because acknowledged queued work must survive restart; prune them under a documented terminal-retention policy and never copy them into connector diagnostics.

### Transaction boundaries

- Deduplication key is `(connector_id, connector_event_id)`.
- The first accepted immutable event fields are committed as a canonical digest; reuse of an event or transaction ID with different room, sender, or body fails closed and raises operator attention rather than being treated as an ordinary retry.
- Matrix transaction IDs are also recorded with a canonical batch digest so a retried transaction can return `200` without duplicating events.
- A transaction is acknowledged only after all contained events are durably classified/queued, not after model completion.
- Event processing is resumable after restart. A row stuck in `processing` is reconciled against the Wayang transcript/delivery ledger before retry.
- Outbound durable envelopes carry delivery ID, endpoint/conversation identity, and chunk ordinal/count. Adapter sends use deterministic transaction IDs derived from these fields, making retry idempotent. Typing is an ephemeral effect and is never confused with a durable delivery.

Completed transaction/event/delivery graphs remain collision-authoritative for seven days and are then pruned atomically only when every delivery is terminal and no retained transaction references the event. Automatic startup/high-water compaction prevents append-only capacity from becoming a permanent outage; `history_high_water` is exposed as bounded connector attention. Never log raw prompt or response bodies solely for connector diagnostics.

## 9. Matrix adapter

### 9.1 Protocol

Implement the stable Matrix Application Service API used by the configured homeserver:

- authenticate homeserver pushes with exact `Authorization: Bearer <hs_token>`;
- `PUT /_matrix/app/v1/transactions/:txnId`;
- `GET /_matrix/app/v1/users/:userId` for declared virtual personas only;
- `GET /_matrix/app/v1/rooms/:roomAlias` only for a declared alias with a durable room binding;
- do **not** expose `/_matrix/app/v1/ping` inbound: Matrix v1.19 defines ping in the opposite direction, from an Application Service to its homeserver;
- unsupported routes return the specified `M_UNRECOGNIZED` response;
- use the Application Service token in an Authorization header for Client-Server API calls;
- masquerade only as exact virtual users inside the exclusive namespace.

A narrow implementation using `fetch` is preferable initially to a broad bridge framework if it covers the required endpoints cleanly. If a Matrix SDK is adopted, pin and audit it, keep it below the adapter boundary, and do not let SDK stores become competing authority for endpoint/session mappings.

### 9.2 Virtual persona namespace

Reserve an exclusive namespaced localpart such as `@_wayang_<opaque-profile-key>:<server>`. Never derive authority from a mutable profile name. Maintain a stable mapping from Agent Profile ID to localpart and set display name/avatar separately.

The Application Service sender/bot user is operational only; normal replies are sent as the endpoint's persona virtual user.

### 9.3 Declarative room provisioning

At startup or explicit reconcile:

1. Load and validate endpoint declarations.
2. Resolve exact Project/Profile IDs and current authorization.
3. If no durable room ID exists, create one invite-only room as the persona using the adapter-owned canonical alias/provisioning key.
4. Only after an ambiguous/conflicting create, resolve that exact alias for idempotent recovery; resolving an absent exclusive alias first can recursively callback into provisioning.
5. Persist the exact room ID before inviting users or accepting prompts.
6. Invite configured allowlisted local users.
7. Set presentation state (name/topic) with a non-authoritative endpoint label.
8. Fetch joined membership and fail closed on any unexpected human.

Do not automatically kick users in v1; report attention and stop prompt processing. Membership mutation is consequential and should be an explicit operator action until reviewed.

### 9.4 Event filtering

Accept only unencrypted `m.room.message` events with `msgtype=m.text` from joined allowlisted humans in a bound room. Ignore:

- the Application Service sender and all managed virtual users;
- events sent by the adapter itself;
- redacted events;
- edits (`m.replace`) in v1;
- reactions, notices, emotes, state events as prompts;
- messages in unknown/lookalike rooms;
- messages older than a bounded startup horizon unless already present in the durable ledger.

A redaction or edit after acceptance cannot rewrite a Pi transcript. The adapter may post a notice explaining this when useful.

### 9.5 Typing and final output

- Send bounded typing refreshes while a turn is active and always clear typing in `finally`.
- Wait for Wayang's authoritative settled outcome, not intermediate `turn_end`/`agent_end` events.
- Immediately before each final/notice/error chunk or retry, fetch a new complete membership/confidentiality snapshot and rerun endpoint authorization. Withhold delivery and raise operator attention on drift.
- Project only final assistant text. Do not expose thinking, raw tool inputs/results, local paths, or hidden control messages.
- Split long messages on paragraph boundaries within the homeserver/client limit and send ordered chunks with deterministic delivery IDs.
- On accepted-turn failure, send a final non-sensitive failure notice; never leave only a typing indicator.

## 10. Slack compatibility contract

A future Slack adapter should map:

- Slack workspace + channel (or configured thread) → external conversation ID;
- Slack user ID → connector subject ID;
- Slack event ID/retry headers → inbound idempotency key;
- bot identity → persona presentation where Slack permits;
- `!` commands → the same semantic command parser;
- typing limitation → a connector-specific progress projection (Slack has no direct equivalent in all modes);
- final text/chunks → Web API sends with deterministic delivery metadata.

Slack signing secrets, OAuth scopes, installations, and workspace authorization stay inside the Slack adapter. Slack must not add fields to the core session row or command semantics.

## 11. Security model

### 11.1 Authority

Messaging access is a new narrow interactive transport authority, not Wayang UI ownership. It permits only:

- prompt the exact declared Project/Profile pair;
- create/list/select sessions for that same pair;
- read the projected final response/status.

It does not permit project/profile settings, model changes, session deletion, apps, browser control, schedules, privacy/RBAC changes, workspace mutation, or arbitrary session lookup.

### 11.2 Wren warning

The migration-seeded Wren profile in a Standard project has broad ordinary-host filesystem and visible Unix-IPC authority. Allowlisting another Matrix user for a Wren endpoint lets that person steer that privileged agent. The configuration/status UI must say this explicitly. The connector does not make Wren safe for mutually untrusted users.

### 11.3 Protected/Finance warning

Protected project policy narrows participating tools and data flows; it does not make an unencrypted Matrix transport confidential. For an endpoint marked `unencrypted_accepted`, prompts and replies exist in plaintext homeserver/client storage and backups. Federation being disabled reduces distribution but does not create E2EE.

Default policy for new Protected endpoints should be `encrypted_required`. An explicit endpoint-level override is required for unencrypted transport, with a startup/status warning.

### 11.4 Interactive surfaces

The connector must never attach to:

- external-action approval client presence;
- command-guard identity/PIN bridge;
- sudo approval bridge;
- browser user-control handoff;
- workspace settings approval;
- secret input.

When a run requests one of these, cancel/deny the pending interaction according to its existing lifecycle and send `Continue this session in Wayang: <canonical session URL>` without embedding credentials or sensitive summaries.

### 11.5 HTTP exposure

Application Service callbacks are mounted separately from browser `/api` routes and authenticate only with the homeserver token. They should bind/restrict network reachability to the local homeserver topology where possible. The normal browser auth cookie and Origin model do not apply to homeserver server-to-server requests.

Every new route and parser gets strict body, event-count, string-byte, and timeout bounds. Secret comparisons are timing-safe. Logs include opaque IDs and outcomes, never token values or message content.

## 12. Configuration

Stable configuration should include paths/booleans only; secrets remain in an owner-only external file. Suggested shape:

```text
WAYANG_MESSAGING_ENABLED=0
WAYANG_MESSAGING_CONFIG_PATH=/absolute/owner-private/messaging.json
```

The private JSON contains connector credentials and reviewed endpoint declarations. The loader must require:

- canonical absolute regular file;
- no symlink;
- current owner;
- mode `0600`;
- bounded size and exact schema;
- no duplicate endpoint/provisioning/subject IDs;
- exact Project/Profile IDs that currently exist and are allowed.

`make configure` support can be added after the schema stabilizes. Never place tokens in examples, command arguments, logs, test fixtures, or committed registration files.

The Tuwunel Application Service registration is a separate homeserver-side secret artifact. Preview it with placeholders/hashes, install it only after operator review, and restart/reload Tuwunel through its supported procedure. Wayang must start safely when the homeserver or adapter is unavailable.

## 13. Milestones

### M0 — Plan and connector-neutral foundation (this session)

- Add this plan.
- Add connector-neutral contracts.
- Add strict endpoint/participant validation.
- Add portable command parsing.
- Add focused pure unit tests.
- No store migration, live route, dependency, secret config, or homeserver mutation.

### M1 — Durable store and session port

- Add versioned store rows/migration/backup for endpoints, inbound events, transactions, and deliveries.
- Implement repositories and compare-and-set active-session binding.
- Extract `WayangMessagingSessionPort` from browser WebSocket-specific orchestration.
- Add synthetic tests proving exact Project/Profile authorization and cross-endpoint session denial.
- Make the endpoint repository the sole active-session CAS owner (`expectedRevision`); the lifecycle port validates/creates a candidate session and returns it for activation. If creation succeeds but activation loses a race, retain the ordinary session but do not adopt it, and report/reconcile the orphan explicitly.
- Add per-endpoint serial queue with bounded backpressure and restart recovery.

**Implemented 2026-08-09:** schema v4 carries connector-neutral endpoint, event, transaction, and delivery collections; admission atomically preserves fresh participant/confidentiality attestation evidence; endpoint binding and event claims use revision/generation CAS; queues are FIFO, bounded, and startup-recoverable; origin sessions and custom-message provenance prevent uncertain replay; candidate creation is crash-idempotent; and the production session port enforces exact Project/Profile eligibility. Connector turns run with an empty Pi tool set under a headless approval lease, reject all browser/PIN/interview response races, and durably hand ambiguous settled turns back to Wayang. Session rows now retain immutable `project_id`; uniquely provable schema 0–3 rows are backfilled and unresolved rows remain ineligible.

### M2 — Matrix protocol adapter, disabled by default

- Implement private config loader and Application Service token verification.
- Implement required AS endpoints and bounded transaction ingestion.
- Implement Client-Server API client with deterministic transactions.
- Implement virtual persona provisioning and declared-room reconciliation.
- Add Tuwunel-compatible synthetic integration tests.
- Keep production adapter disabled.

**Implemented 2026-08-10, code-only:** strict owner-private configuration, opaque split token authority, Matrix v1.19 AS routes, bounded strict transaction parsing, injected-fetch Client-Server calls, stable personas/aliases, recursion-free provisioning, event filtering, membership/encryption attestation, atomic transaction acknowledgement, and recovery-first production composition. The route is mounted before browser auth/body parsing and remains unavailable when disabled. No registration, token, room, user, service, or homeserver change was made.

### M3 — Matrix conversation UX

- Wire messages to the session port.
- Implement `!new`, `!sessions`, `!use`, `!status`, `!help`, and `!!` escape.
- Implement typing/final delivery, long-message chunking, and failure notices.
- Implement membership fail-closed behavior and operator attention state.
- Implement Wayang handoff for unsupported interactive surfaces.

**Implemented 2026-08-10, code-only:** portable commands and escaping, shared-session CAS, typing lifecycle, final/error/handoff projection, deterministic grapheme-safe chunking, fresh authorization immediately before every subchunk, durable per-subchunk remote progress, ambiguity-safe retries, quiescing awaited shutdown, bounded status attention, and seven-day graph-aware terminal retention. Matrix is still disabled and undeployed.

### M4 — Deployment rehearsal and opt-in activation

- Generate a registration artifact outside Git with opaque tokens.
- Rehearse Tuwunel registration/restart and rollback using a synthetic endpoint first.
- Provision a synthetic room and verify retries, restarts, duplicate transactions, membership drift, and disabled federation.
- Activate the Memoriki endpoint after review.
- Activate the Finance endpoint only after the operator re-confirms the unencrypted warning in the deployment review.

### M5 — Slack adapter

- Verify current Slack Events/API and app-distribution requirements from official docs.
- Implement signing/retry verification and adapter-specific provisioning.
- Reuse core endpoint/session/command/idempotency services unchanged.
- Add contract tests proving Matrix and Slack adapters produce equivalent normalized operations.

## 14. Validation matrix

### Pure core tests

- declaration bounds, normalization, uniqueness, and immutable ID handling;
- nonempty exact allowlists;
- duplicate endpoint/provisioning keys rejected;
- unexpected joined human fails closed;
- sender must be both joined and allowlisted;
- command grammar, escaping, unknown commands, missing/extraneous arguments;
- connector-neutral types contain no Matrix/Slack fields.

### Store/session tests

- migration backup and idempotence;
- transaction/event retry produces one prompt;
- active binding compare-and-set rejects races;
- cross-project/profile/session selection denied;
- policy tightening blocks the next command/turn;
- restart reconciliation does not duplicate a user turn or final delivery;
- endpoint queues preserve accepted order and enforce bounds.

### Matrix tests

- wrong/missing/multiple auth token sources denied;
- transaction/event/body limits;
- duplicate transaction/event idempotence;
- virtual-user namespace cannot escape;
- unknown room and alias lookalikes ignored;
- unexpected member blocks commands and prompts;
- managed virtual users never loop messages;
- edits/redactions/reactions do not become prompts;
- typing always clears;
- long replies preserve order and are retry-idempotent;
- encrypted rooms fail closed until E2EE support exists;
- unencrypted Protected endpoint requires explicit override.

### Required repository checks

```sh
make doctor
npm --prefix backend test -- src/messaging/*.test.ts
npm --prefix backend run build
make check
```

Run broader E2E only after live HTTP/UI surfaces are added. All tests use synthetic homeserver URLs, tokens, subjects, projects, profiles, sessions, and transcripts.

## 15. Rollout and rollback

1. Keep messaging disabled by default.
2. Back up the private Wayang store before the first messaging schema migration.
3. Land M0/M1 without a live adapter.
4. Run M2/M3 against a synthetic homeserver fixture and synthetic project/profile.
5. Review generated homeserver registration namespaces and callback reachability.
6. Register the Application Service and restart Tuwunel only with an explicit deployment confirmation.
7. Activate one low-risk endpoint first and observe duplicate/recovery/membership behavior.
8. Activate sensitive endpoints separately.
9. Rollback: disable the adapter, stop accepting transactions, allow in-flight work to settle/cancel, remove or disable the homeserver registration, restore the pre-migration store only if reverting to a binary that does not understand the new schema. Existing Matrix room history is not removed by rollback.

## 16. Deferred work

- Matrix E2EE and crypto-device recovery.
- Attachments and media scanning/publication.
- Thread-per-session or per-user isolated session modes.
- Collaborative attribution injected into agent context beyond a minimal sender label.
- Chat-side interrupt/abort.
- Safe questionnaire transport with durable answer provenance.
- Admin provisioning commands in chat.
- Streaming message edits and tool-progress projections.
- Automatic kicking/banning of unexpected room members.
- Cross-host connector sidecars and a capability-scoped internal protocol.

## 17. Suggested execution team

- **Core owner:** messaging contracts, store, gateway service, queues, commands.
- **Wayang lifecycle owner:** session port extraction, current policy rechecks, settled-turn and handoff behavior.
- **Matrix owner:** Application Service routes, Tuwunel compatibility, virtual users, provisioning, delivery.
- **Security reviewer:** token/namespace/membership/idempotency/adversarial tests and log review.
- **Operations owner:** private configuration, registration generation, Tuwunel deployment and rollback docs.
- **Slack design reviewer (M5):** ensures no Matrix assumptions leaked into the core.

One integrator owns final store/runtime consistency. Connector protocol code and session authority code should not be merged independently without the cross-surface tests.

## 18. Acceptance criteria

- A declared endpoint automatically provisions exactly one canonical Matrix room and stable persona identity.
- Every joined human is explicitly allowlisted; membership drift blocks the endpoint.
- `!new`, `!sessions`, `!use`, and `!status` operate only on sessions matching the endpoint's exact Project/Profile pair.
- A retried Matrix transaction/event or outbound send never creates duplicate Pi turns or duplicate visible answers.
- Ordinary prompts receive typing followed by a final answer or explicit failure.
- Messaging cannot approve privileged actions or collect secrets and provides a safe Wayang handoff instead.
- Finance plaintext exposure is explicit and endpoint-specific, not an accidental global default.
- Slack can be added as an adapter without changing the core session/command/idempotency model.
