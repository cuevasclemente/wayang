# Projects and agent profiles

Wayang has durable, editable Projects and reusable Agent Profiles. An agent profile is separate from its provider/model: it controls identity, loaded instructions/resources, memory permissions, and runtime defaults, while a session can still select another provider/model.

## Defaults

Fresh installations seed one restricted **Default** profile with a generated stable ID, project-only preferences, and no memory. Newly discovered projects use the workspace-default profile. Upgraded stores may retain a migration-seeded workspace default until the owner changes it in **Settings → Agents → Workspace default**, through authenticated `GET`/`PUT /api/workspace-settings`, or through the approved agent mutation. This fallback affects only future/default Project registration: changing it never switches current sessions, changes existing Project defaults/allowlists, or rewrites historical stable-ID attribution. The target must be enabled.

The Agents settings view also reports bounded redacted reference counts, separating persisted session attribution from active runtime use. Disable conflicts identify only actual blockers such as the workspace default, Project defaults, or a pending switch. An owner may therefore move active/configuration references, disable the old profile, and retain inert historical attribution without deleting or replacing the stable profile ID.

Names do not grant authority: the current Project privacy mode, profile enabled state, and Project allowlist do. Every enabled profile allowed by a Standard Project receives global resources, browser control, and host execution; every enabled profile allowlisted by a Protected Project receives its isolated browser and deterministic automation.

Project paths are canonical and immutable. Project name, description, color, defaults, allowed agents, privacy mode, and `AGENTS.md` are editable.

Every interactive Wayang runtime receives a short host-layer communication appendix: acknowledge substantive work before extended tool use and provide concise checkpoints around material findings, decisions, blockers, and useful steering points. It is appended without replacing profile, global, project, or `APPEND_SYSTEM.md` instructions. Scheduled runs do not receive it, and quick mechanical tasks should not add ceremonial updates. This is model guidance rather than a deterministic heartbeat; Wayang does not fabricate assistant messages or inject timer-based steering.

## Privacy/RBAC-derived runtime authority

Wayang has no per-pair capability association, activation, revocation, or PIN policy. Authority follows the current immutable Project ID, stable Agent Profile ID, Project privacy mode, profile enabled state, and Project allowlist:

- **Standard:** every enabled allowed profile receives reviewed global Pi instructions/skills/prompts/extensions, Standard browser tools, and same-user host execution.
- **Protected:** every enabled explicitly allowlisted profile receives Protected browser tools and deterministic Protected automation.
- Provider/model, names, prompts, profile resource preference, and legacy association/history rows do not confer or narrow authority.

A null Standard allowlist permits every enabled profile; Protected requires an explicit nonempty allowlist. Privacy changes, profile disable, allowlist exclusion, and Project/Profile deletion remove authority at current-state checks and rebuild affected runtimes through the normal runtime-impact lifecycle. There is no capability Settings tab or individual grant/revoke action.

These powers are broad. Standard host execution can reach same-user credentials, processes, memory stores, and Protected backing paths. Browser control can inspect or mutate authenticated sites. Protected automation can write the whole authorized Project and act through its exact browser realm. Login, MFA, CAPTCHA, payment, credential entry, Protected-automation purge, transcript mutation, and other operation-specific confirmations retain their separate human/PIN boundaries.

The internal selector IDs remain implementation vocabulary, not user-managed policy. Existing capability association/approval rows are inert rollback data for one compatibility release and are ignored by runtime resolution.

### Host-execution questionnaire submission projection

The owner-private agent-readable projection for an approved `wayang.host-execution.v1` Project–Agent pair uses root schema version 3. Its nested `questionnaire_submissions` object has its own schema version 1 and is intended for a trusted verifier that needs canonical persisted questionnaire answers without reading the broad Wayang store or transcript corpus.

Wayang joins each interview to its one durable owning session and releases it only when that session has the exact projected Standard Project ID and Agent Profile ID, exact-false quarantine/capability-ineligibility markers, and the interview is a submitted or delivered `questionnaire` record with the server-owned `WAYANG_WEBSOCKET` / `WAYANG_SINGLE_USER` provenance. Each record is rebuilt from a positive field allowlist: request/session IDs, origin tool and tool-call linkage, exact questions/options, status, creation/submission timestamps, canonical answers (including label, custom marker, and predefined-option index), submission ID/channel/principal, and delivery timestamp/mode/entry ID when delivered. Pi session files/IDs, transcript content, unrelated interview tools, open/cancelled forms, Project/Profile tuples, provider/model, instructions, defaults, approval history/digests/timestamps, and unrelated sessions are excluded from this nested projection.

Records use deterministic timestamp/request/submission ordering. The complete subsection is capped at 256 records, 1 MiB total JSON, 32 questions per submission, 64 options per question, and 128 KiB per submission, with additional per-field byte ceilings. Wayang never silently truncates: malformed provenance or answer linkage, an oversized eligible record, or either aggregate ceiling produces `{ available: false, records: [] }`.

Projection publication is denial-first. Before any store mutation can become durable, every affected host-execution pair is removed or replaced with an owner-private unavailable root. Only after the store rename and directory fsync does Wayang publish fresh positive projections for currently derived Standard Project-Agent pairs; a post-commit projection failure leaves denial in place. Consumers must require the documented schema versions, expected current derived-authority revision, active/available root, and available questionnaire subsection; missing, malformed, unknown-version, unavailable, stale, or partial data is not evidence of a submission.

## Memory modes

Agent profiles support:

- **None:** cannot read or write registered personal-memory roots.
- **Read only:** can read registered memory files but cannot edit/write them.
- **Read and write:** normal authorized memory access.

Memory path checks are canonical and symlink-aware. Restricted profiles in Standard projects are confined by participating path tools and sandboxed filesystem access to their project, permitted memory roots, and their own read-only attachment subtree. Exact catalogued Standard-session transcripts and attachment files are an intentional direct-tool exception: any eligible interactive session may inspect them read-only regardless of target Project agent allowlists. Protected, quarantined, and unknown session artifacts remain unreadable; all cross-session writes and broad storage scans remain denied. A restricted profile running inside its authorized Protected project may additionally read ordinary/unregistered host paths and Standard projects—even when a Standard project's run allowlist does not include that profile—but writes remain confined to its own project and permitted memory roots. Project-local `.pi` control-plane files remain mutation-denied. Other Protected projects, protected backing artifacts, global Pi/control-plane storage, the Wayang checkout's launcher configuration, documented project secret files, and disallowed memory roots remain unreadable. Broad recursive scans that intersect a denied root fail closed. This is not a network egress restriction.

An eligible Protected restricted profile may also receive Wayang's backend-owned restricted `mcp` proxy when an administrator installs an exact private grant. This does not load Pi's global MCP extension or configuration. The compiled reviewed ceiling exposes only explicitly granted read/query tools; mutations, Report Publisher, scheduled/subagent use, and unreviewed future servers remain unavailable. See [Configuration](configuration.md#restricted-profile-mcp-grants).

## Agent-programmatic workspace control

Standard interactive Wayang runtimes receive two backend-owned, source-session-bound tools:

- `wayang_workspace_read` provides bounded workspace-default, project/profile, redacted profile-reference, and project-instruction metadata or content reads. Detail content enters the session transcript, so metadata reads are preferred.
- `wayang_workspace_change` previews one canonical workspace-default, CRUD, or `AGENTS.md` mutation, then commits it only after the exact one-question approval is submitted in the originating Wayang chat with the predefined **APPROVE** option. `workspace_default_agent_profile_update` changes only the future/default Project fallback and explicitly preserves existing Project/session/schedule attribution.

Restricted profiles and scheduled/background sessions receive neither tool. Approval is bound to the source session, server-owned WebSocket provenance, complete current-state hash, exact operation digest, and a ten-minute expiry. The backend also retains the exact issued preview in process memory; the approval record must be created and submitted at or after that issuance, and fabricated, pre-preview, altered-expiry, or pre-restart questionnaires fail closed. Issuance is consumed only at the successful durable mutation/file-replacement boundary, so a transient runtime conflict can be retried while the preview remains valid. Approval prompts/results expose hashes and byte counts rather than profile instruction or `AGENTS.md` text. Authenticated Settings REST operations retain their existing UI authority and do not require this agent approval flow.

Runtime streaming conflicts remain strict: a tool call cannot mutate its own affected active project/profile. A separate Standard management session can manage other projects/restricted profiles; updating the active profile itself remains an authenticated Settings/UI operation for now.

Deleting a project registration through the authenticated API or approved agent tool deletes only Wayang's registration. It is refused while sessions (including archived sessions), scheduled jobs/runs, apps/state/events, active runtime impact, or project-local managed browser profile data still exist, and it never deletes project files or other user data.

## Project instruction editing

Project settings edit the real:

```text
<project>/AGENTS.md
```

This may change a Git-tracked file. Wayang displays that warning and uses a SHA-256 optimistic-concurrency check so stale browser content cannot overwrite a newer edit. Existing-file commits reopen with `O_NOFOLLOW`, recheck inode and approved content hash, revalidate the registered root, and atomically replace the directory entry; creates use an atomic no-overwrite link. The parent directory is fsynced best-effort after commit.

These checks reject stale/cooperative races and narrow same-UID races, but they are not isolation from a hostile process running as the Wayang OS user. Such a process can race after the final check or modify the file after commit. Use a separate OS account/container/VM when mutually untrusted writers must be isolated, consistent with Wayang's general same-user threat model.

Neutral/project-only agents receive only this exact root file; parent/global context is filtered before Pi constructs the agent.

## Provider/model precedence

For a new session:

1. Explicit Advanced session selection.
2. Project default.
3. Agent profile default.
4. Pi's normal default.

When switching agents inside a session, the target agent's default takes priority, then the project/Pi fallback. The model can be changed again afterward with the normal session model selector.

## Changing the session model

The model picker and the `/model` command work while the agent is streaming or has queued work. A busy runtime switches models live: the current turn finishes on the old model (pi captures the model once per run), and the next turn — a queued follow-up or the next prompt — uses the new model. The switch is validated first (model exists, auth configured, memory-first context-window requirements), appends a durable `model_change` transcript entry, and never rebuilds the runtime, so tools, approvals, browser leases, and queues stay intact. Pi's model switch also writes pi settings defaults; Wayang restores the prior values so a session choice never becomes the project or deployment default.

Idle sessions keep the stronger behavior: the runtime stops and the next use rebuilds fresh surfaces from the unchanged Project privacy/RBAC decision.

## Switching agents

The agent pill in the chat header previews a switch before applying it. The confirmation shows:

- current and target agents;
- resolved provider/model change;
- target memory mode;
- a warning that the existing transcript remains visible.

Switching is allowed only while the session is idle. Wayang preserves the same Pi transcript, appends a non-context audit divider, durably records the model change, and rebuilds the runtime with the target profile. A pending-switch record makes crash recovery idempotent.

Profile, project-policy, default, or `AGENTS.md` edits refuse to interrupt streaming/queued work. Affected idle runtimes stop and rebuild on the next prompt; current-state tool checks reject stale privacy/RBAC authority.

## Protected projects

Protected is one fixed v1 policy, not a label whose name implies isolation. Its defaults enforce:

- explicit agent allowlist for interactive and scheduled runs;
- no host execution or global Standard resources;
- an isolated Protected browser and deterministic automation for every enabled allowlisted profile;
- scheduled agents run only as an exact allowed profile, with Protected session/output handling;
- no Dream transcript processing;
- no subagents in that project;
- no global transcript search/catalog body indexing.

Non-null allowlists are also enforced for Standard projects. The source profile must be allowed before participating direct tools, sandboxed bash, Browser, Apps, Dream, or Agent Teams operations may target that project.

Protection is prospective. It cannot erase information that Dream, search, an agent, or another process derived before the project was protected.

### Deterministic Protected automation

Every enabled profile explicitly allowlisted by a Protected Project derives deterministic automation authority without a pair activation or PIN step. Protected automation runs immutable Node snapshots through a Linux-only, shell-free direct-Bubblewrap runtime. Wayang creates no Pi/model/provider/session/transcript for a run. The child has no generic TCP/UDP/Unix-socket network, shell, general executable view, raw CDP, profile mount, credential API, or arbitrary environment. Sandbox-runtime is a recorded NO-GO for this boundary, macOS has no available runtime, and there is no weaker fallback.

The runtime mounts the immutable code at `/snapshot`, the **whole authorized Project writable** at `/workspace`, and bounded run/state roots. This supports deterministic import and atomic-replace designs but is broad Project write authority. It is not hostile-code containment or same-UID isolation; cancellation/revocation cannot undo completed/racing Project writes or authenticated-site effects.

Browser-enabled jobs use a persistent exact Project/Profile/Job realm through bounded framed backend RPC. Exact HTTPS origins apply to top-level documents and completed download sources. Wayang intercepts/attests top-level document requests and denies cross-origin redirects, but iframe and subresource traffic is continued and is not destination-allowlisted. Login, MFA, CAPTCHA, passkeys, and credential filling remain human-only in the exact preparation viewer/guarded broker. Deterministic code reports `needs_user` and exits without automatic retry.

## Scheduler, Dream, and Agent Teams

Scheduled Agent Jobs may run in a Protected project only with a persisted non-null exact allowed Agent Profile; they never follow a later project-default profile change implicitly. Backend policy is checked during create/update, manual run, timer fire, and immediately before Pi runtime creation, and the executor uses the freshly reloaded job prompt/model/timeout/guard fields. The resulting session, transcript, and attachments retain Protected classification; global body indexing and legacy whole-transcript scanning remain denied. Assistant result summaries, raw Protected failure details, and memory mutations are withheld from shared surfaces, so output is written inside the project and opened through the linked Protected session. Scheduled sessions receive no interactive browser tools. Protected Automation Jobs remain a separate deterministic no-Pi domain with their own snapshot, browser, and lifecycle rules. Profile disable, allowlist exclusion, incompatible project privacy, or source revision change durably blocks affected deterministic automation work and terminates active runs/leases; restored RBAC requires explicit `rebind_job` and a separate enable and never adopts or resumes an old run.

Protected automation uses a Wayang-owned host-local five-field-cron scheduler. It persists a cursor and local wall-minute occurrence key, deduplicates the repeated DST fall-back minute, skips nonexistent spring-forward minutes, atomically pairs cursor advancement with a queued scheduled claim, and implements explicit `skip | run_once` downtime behavior. Startup dispatches recovered queued claims once, marks recovered running claims `interrupted` without retry, and then evaluates missed work. Overlap is skipped; no automatic retry/backoff is performed.

Dream uses a private, atomic Wayang policy projection and an authorization runner. Missing, stale, malformed, unknown, protected, or changing policy fails closed before transcript bytes are returned.

Wayang-integrated Agent Teams children:

- cannot enter Protected projects;
- must match every Standard project allowlist;
- always omit bash, sudo, arbitrary extensions, and unknown/custom tools;
- keep only guarded `read`, `edit`, `write`, `grep`, `find`, and `ls` when requested and allowed;
- recheck the live projection before path-tool calls.

This applies to participating Wayang/mypi children, not arbitrary independently launched Pi processes.

## Bash and control-plane restrictions

Every enabled profile allowed by a Standard Project derives same-user host execution; provider/model changes preserve that privacy/RBAC decision while rebuilding stale runtime handles. Those shell commands are not constrained by Wayang's filesystem sandbox or tool-level path rules. Protected profiles do not receive host execution and use a fresh per-command OS sandbox instead. A restricted profile in its authorized Protected project receives asymmetric access: ordinary and Standard paths are readable, its own project is writable, and every other Protected/control-plane root remains masked. The Protected sandbox:

- masks unauthorized projects plus all Pi session/Wayang storage from sandboxed bash except the source session's existing attachment allowance, browser profiles, and the command-guard identity PIN; direct tools separately allow exact read-only Standard transcripts/attachments while denying Protected/unclassified artifacts and broad scans;
- enforces profile memory write mode;
- persists writes only inside the current Protected project;
- gives sandboxed shells a strict non-secret process environment rather than forwarding provider keys, OAuth/AWS credentials, proxy credentials, loader hooks, or arbitrary deployment variables;
- blocks Unix-domain sockets and raw `sudo`;
- on Linux, retains the host network namespace, including unrestricted TCP/UDP destinations, public Internet, loopback, LAN and VPN services, non-proxy-aware protocols, and local listeners available to the Wayang OS user; macOS retains proxy-mediated egress pending a supported filesystem-only host-network implementation.

Unix-domain sockets remain a separate Protected boundary: sandboxed Protected profiles cannot reach the user bus, Docker socket, or other Unix IPC merely because Linux host TCP/UDP networking is enabled. Standard host execution retains same-user Unix-socket reachability. Protected mode constrains filesystem, memory, credential, and reviewed connector access; it is not a network-isolation or data-loss-prevention mode.

If sandbox prerequisites are unavailable, bash is removed rather than replaced with command-string parsing. Run `make doctor` to check prerequisites.

Full destination access is an explicit operator tradeoff. A shell can forge HTTP origins and call passwordless Wayang or other local APIs, so source-attributed companion-tool authorization is not a network sandbox. Memory modes prevent participating memory tools and filesystem writes; they cannot prevent an agent from deliberately sending text to any reachable network service. Provider calls made by the host agent runtime are unaffected.

Interactive browser access is backend-owned and derived from the exact current Project privacy mode plus enabled/allowed Agent Profile. New eligible interactive runtimes receive explicit `browser_*` tools; scheduled/background sessions receive none. Each operation reauthorizes the exact source Project, Agent Profile, derived-authority revision, runtime generation, and process generation. Once granted, browser authority is broad and may mutate authenticated sites; the capability check is not an operation-level read-only policy. Apps companion calls retain their separate source-session-attributed integration. App manifest commands remain same-user unsandboxed processes, so agent start/restart fails closed whenever any Protected project exists; manual authenticated launch remains available after human review.

## Security boundary

These controls protect participating Wayang tools, scheduler/search/catalog code, Dream, and reviewed companion integrations. They do not isolate or prevent disclosure through:

- arbitrary processes running as the same OS user;
- trusted extension code already executing inside the Wayang process;
- manually launched project applications;
- another independently launched Pi instance that does not use the companion policy;
- network-enabled bash deliberately posting data to any reachable Internet, LAN, VPN, or loopback service.

Use a separate OS account, container, or VM when those actors must be mutually isolated. See [SECURITY.md](../SECURITY.md) and [configuration.md](configuration.md#protected-projects-and-bash-sandboxing).

## Data and rollback

Project/profile/session policy, Protected-automation jobs, and their schedules are stored persistently in private `WAYANG_DATA_DIR/store.json` and survive service restarts and host reboots. Legacy capability rows/history may remain inert for rollback compatibility but are ignored by runtime authority. Store schema 3 adds `protectedAutomationJobs` and `protectedAutomationRuns`; fresh and migrated stores initialize both as empty and create no capability authority. Rows support queued/running and terminal completed/failed/skipped/cancelled/needs-user/interrupted/denied lifecycle states. Owner-bound immutable snapshots, bounded private runtime state/diagnostics, and persistent exact-job browser realms live beneath `WAYANG_DATA_DIR/protected-automation/`; a successful human Save & close writes only a versioned last-saved timestamp beside that private browser realm. Public projections expose metadata, hashes, counts, fixed outcomes, attention, and this non-secret saved marker—not source, stdout/stderr, page, profile, credential, or downloaded-file contents. The first schema migration creates a mode-`0600` backup and aborts rather than overwriting malformed or unsupported data.

Compiled bounds include 4,096 jobs globally and 500 run rows per job. Job listing defaults to and is capped at 50 rows, with an exact-owner `after_job_id` cursor; run listing defaults to 100 and is capped at 500. A snapshot is capped at 1,024 files, 512 directories, 4 MiB per file, 32 MiB total, depth 32, and 1,024 bytes per relative path. Snapshot storage is capped at 32 revisions per job, 64 MiB per exact Project–Agent pair, and 256 MiB globally. Published state is capped at 256 files/16 MiB; stdout and stderr at 1 MiB each; private runtime storage at 64 MiB/job, 128 MiB/pair, and 512 MiB/global. Downloads are capped at 32 observed files/lease and 32 MiB/file, with materialized incoming data capped at 32 files/64 MiB/run.

The deterministic Node child can write anywhere in the whole authorized Project; those ordinary Project outputs are not covered by the private runtime quotas and cannot be rolled back on revoke/cancel. Persistent Chromium profile data is also not byte-quota-bounded and can grow between runs. A one-use identity-PIN purge is available only for a tombstoned, fully stopped job; it removes job/run metadata, snapshots, private runtime state/diagnostics, and the browser realm while preserving Project outputs. Snapshot and browser-realm artifacts are staged before the durable row commit; startup reconciliation restores them if the row survived or removes them when the row is absent. Wayang reports purge success only after private cleanup is verified; otherwise it reports committed-but-pending cleanup and retries during startup without requiring another PIN. Binary rollback still requires stopping Wayang and restoring the pre-schema private store backup before starting an older binary.

New chat uploads use private per-session directories:

```text
WAYANG_DATA_DIR/attachments/<full-session-id>/
```

Pi transcripts remain under Pi's session storage. Participating direct tools and bounded `session_*` tools may inspect exact catalogued Standard transcripts read-only; Protected, quarantined, unknown, recursive, and mutation access remains denied. Sandboxed bash receives no cross-session transcript access. The private Dream policy projection is under `WAYANG_DATA_DIR` and contains metadata/decisions, not transcript text.

Do not run an older Wayang binary against the migrated store: older code may discard unknown fields. For rollback, stop Wayang and restore the pre-migration private store backup before starting the older binary.
