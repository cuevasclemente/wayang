# Projects and agent profiles

Wayang has durable, editable Projects and reusable Agent Profiles. An agent profile is separate from its provider/model: it controls identity, loaded instructions/resources, memory permissions, and runtime defaults, while a session can still select another provider/model.

## Defaults

Fresh installations seed one restricted **Default** profile with a generated stable ID, project-only resources, and no memory or privileged capability grants. Newly discovered projects use that profile. Existing Wren and Neutral rows may remain after migration under their stable IDs and labels. Neither name grants authority, and neither row receives a capability association automatically. One compatibility behavior remains: only the exact migration-seeded Wren stable ID together with its non-user-settable historical kind receives global Pi resources and broad ordinary-host filesystem/Unix-IPC access in Standard projects, including scheduled runs. Every registered Protected project and protected backing artifact remains masked. Renames preserve that exact row; copied profiles and lookalikes do not inherit it.

Project paths are canonical and immutable. Project name, description, color, defaults, allowed agents, privacy mode, and `AGENTS.md` are editable.

Every interactive Wayang runtime receives a short host-layer communication appendix: acknowledge substantive work before extended tool use and provide concise checkpoints around material findings, decisions, blockers, and useful steering points. It is appended without replacing profile, global, project, or `APPEND_SYSTEM.md` instructions. Scheduled runs do not receive it, and quick mechanical tasks should not add ceremonial updates. This is model guidance rather than a deterministic heartbeat; Wayang does not fabricate assistant messages or inject timer-based steering.

## Assign privileged capabilities

Privileged authority belongs to a PIN-approved capability association between one immutable Project ID and one stable Agent Profile ID, not to a profile name, seeded identity, provider, or model. Provider/model are fluid runtime choices for that agent. Cloning creates a different Agent Profile ID and copies no associations; renaming or editing the associated stable profile preserves them.

The current publicly listed and grantable capabilities are:

- `wayang.standard-resources.v1` for a Standard Project-Agent pair. It permits Pi global instructions, skills, prompts, and reviewed extensions for any provider/model used by that agent in the project.
- `wayang.host-execution.v1` for a Standard project/profile pair. It replaces sandboxed bash with direct execution as the Wayang OS user.
- `wayang.protected-browser.v1` for a Protected project/profile pair. Protected projects remain browser-denied by default; assigning this exception gives the runtime broad control of its persistent authenticated browser.
- `wayang.protected-automation.v1` for a Protected project/profile pair when the grantable build is deployed. It authorizes deterministic no-Pi automation for that exact pair.

The Protected-automation implementation is complete through Milestone 5 with `activationAvailable: true`. A service restart is needed only to deploy new code, not to initialize attempt/cooldown state or record an approval. The flow reuses the command guard's existing identity PIN, and PIN entry is the normal human action for approving an exact reviewed Project–Agent pair. Startup automatically creates missing non-secret attempt/cooldown state under `WAYANG_DATA_DIR` with owner-only permissions and preserves it across reboots. Missing or unsafe PIN metadata and unsafe or malformed existing state fail approval closed without replacement. `make setup-capability-approval` is optional manual preflight/migration, not required setup. Only a fresh eligible interactive runtime after approval receives the production `protected_automation` tool. No environment flag or provider/model choice bypasses approval. This documentation update does not deploy code or approve an association.

The source-session-bound tool operates only on its implicit immutable Project ID–Agent Profile ID and current association revision. It supports bounded reads; immutable source capture and compare-and-set update/tombstone/rebind; enable/pause; run-now/cancel; run history; and exact browser-profile preparation. The separate owner UI is status/attention plus denial-only emergency pause/cancel, preparation attachment, and PIN-approved purge of an already tombstoned, fully stopped job. It does not offer ordinary owner create/edit/enable/run controls.

“Broad control” means navigation, page inspection, clicks, typing, downloads, and consequential site actions; it is not a read-only or vendor-specific export adapter. Login, MFA, CAPTCHA, payment, and other secret-bearing steps remain human-only. Do not grant this capability merely because a project handles sensitive data.

Choose the Project privacy mode and allowed-agent list first, then review and associate only the intended capability and Project-Agent pair. Provider/model defaults remain runtime preferences, not authority. Capability associations persist in the service store; the normal human approval action is entering the existing command-guard identity PIN for the exact reviewed association. Explicit revocation, exact-profile allowlist exclusion, incompatible privacy, or subject deletion tombstones the association. Profile definition edits, project instructions/defaults, and provider/model changes preserve it; stale runtime objects are still destroyed and rebuilt. Revocation terminates affected direct-host command and Protected-automation process groups with bounded TERM/KILL, but cannot undo host commands, Project writes, browser actions, downloads, disclosures, or remote side effects already completed.

## Memory modes

Agent profiles support:

- **None:** cannot read or write registered personal-memory roots.
- **Read only:** can read registered memory files but cannot edit/write them.
- **Read and write:** normal authorized memory access.

Memory path checks are canonical and symlink-aware. Restricted profiles are confined by participating path tools and sandboxed filesystem access to their project, permitted memory roots, and their own read-only attachment subtree. This is not a network egress restriction.

An eligible Protected restricted profile may also receive Wayang's backend-owned restricted `mcp` proxy when an administrator installs an exact private grant. This does not load Pi's global MCP extension or configuration. The compiled reviewed ceiling exposes only explicitly granted read/query tools; mutations, Report Publisher, scheduled/subagent use, and unreviewed future servers remain unavailable. See [Configuration](configuration.md#restricted-profile-mcp-grants).

## Agent-programmatic workspace control

Standard interactive Wayang runtimes receive two backend-owned, source-session-bound tools:

- `wayang_workspace_read` provides bounded project/profile reads and project-instruction metadata or content. Detail content enters the session transcript, so metadata reads are preferred.
- `wayang_workspace_change` previews one canonical CRUD or `AGENTS.md` mutation, then commits it only after the exact one-question approval is submitted in the originating Wayang chat with the predefined **APPROVE** option.

Restricted profiles and scheduled/background sessions receive neither tool. Approval is bound to the source session, server-owned WebSocket provenance, complete current-state hash, exact operation digest, and a ten-minute expiry. The backend also retains the exact issued preview in process memory; the approval record must be created and submitted at or after that issuance, and fabricated, pre-preview, altered-expiry, or pre-restart questionnaires fail closed. Issuance is consumed only at the successful durable mutation/file-replacement boundary, so a transient runtime conflict can be retried while the preview remains valid. Approval prompts/results expose hashes and byte counts rather than profile instruction or `AGENTS.md` text. Authenticated Settings REST operations retain their existing UI authority and do not require this agent approval flow.

Runtime streaming conflicts remain strict: a tool call cannot mutate its own affected active project/profile. A separate Standard management session can manage other projects/restricted profiles; updating the active profile itself remains an authenticated Settings/UI operation for now.

Deleting a project registration through the authenticated API or approved agent tool deletes only Wayang's registration. It is refused while sessions (including archived sessions), scheduled jobs/runs, apps/state/events, or active runtime impact still reference the project, and it never deletes project files or other user data.

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

## Switching agents

The agent pill in the chat header previews a switch before applying it. The confirmation shows:

- current and target agents;
- resolved provider/model change;
- target memory mode;
- a warning that the existing transcript remains visible.

Switching is allowed only while the session is idle. Wayang preserves the same Pi transcript, appends a non-context audit divider, durably records the model change, and rebuilds the runtime with the target profile. A pending-switch record makes crash recovery idempotent.

Profile, project-policy, default, or `AGENTS.md` edits similarly refuse to interrupt streaming/queued work. Affected idle runtimes stop and rebuild on the next prompt.

## Protected projects

Protected is one fixed v1 policy with explicit capability exceptions, not a label whose name implies isolation. Its defaults enforce:

- explicit interactive-agent allowlist;
- no host execution;
- no generic browser authority unless the exact pair receives `wayang.protected-browser.v1`;
- no Wayang scheduled/background agent runs;
- no Dream transcript processing;
- no subagents in that project;
- no global transcript search/catalog body indexing.

Non-null allowlists are also enforced for Standard projects. The source profile must be allowed before participating direct tools, sandboxed bash, Browser, Apps, Dream, or Agent Teams operations may target that project.

Protection is prospective. It cannot erase information that Dream, search, an agent, or another process derived before the project was protected.

### Deterministic Protected automation

When the grantable build is deployed and an exact eligible pair receives human PIN approval, Protected automation runs immutable Node snapshots through a Linux-only, shell-free direct-Bubblewrap runtime. Wayang creates no Pi/model/provider/session/transcript for a run. The child has no generic TCP/UDP/Unix-socket network, shell, general executable view, raw CDP, profile mount, credential API, or arbitrary environment. Sandbox-runtime is a recorded NO-GO for this boundary, macOS has no available runtime, and there is no weaker fallback.

The runtime mounts the immutable code at `/snapshot`, the **whole authorized Project writable** at `/workspace`, and bounded run/state roots. This supports deterministic import and atomic-replace designs but is broad Project write authority. It is not hostile-code containment or same-UID isolation; cancellation/revocation cannot undo completed/racing Project writes or authenticated-site effects.

Browser-enabled jobs use a persistent exact Project/Profile/Job realm through bounded framed backend RPC. Exact HTTPS origins apply to top-level documents and completed download sources. Wayang intercepts/attests top-level document requests and denies cross-origin redirects, but iframe and subresource traffic is continued and is not destination-allowlisted. Login, MFA, CAPTCHA, passkeys, and credential filling remain human-only in the exact preparation viewer/guarded broker. Deterministic code reports `needs_user` and exits without automatic retry.

## Scheduler, Dream, and Agent Teams

Scheduled Agent Jobs store an optional agent profile and are retained—but visibly blocked—when their project becomes Protected. Backend policy is checked during create/update, manual run, timer fire, and immediately before Pi runtime creation. Protected Automation Jobs are a separate deterministic domain and do not weaken or reuse this model-driven scheduled-agent path. Capability revocation, profile disable, allowlist exclusion, incompatible project privacy, or source revision change durably blocks affected automation work and terminates active runs/leases; regrant requires explicit `rebind_job` and a separate enable and never adopts or resumes an old run.

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

Wayang sessions replace Pi's bash backend with a fresh per-command OS sandbox unless the exact Standard Project-Agent pair has an active `wayang.host-execution.v1` association. Provider/model changes preserve that association but destroy stale runtime handles before rebuilding. Ordinary restricted profiles remain project-scoped. The exact seeded Wren row in a Standard project—including scheduled runs—uses a broader sandbox view with ordinary host reads/writes, global Pi resources, Git configuration, and Unix IPC, while all registered Protected projects and protected backing artifacts remain masked. This compatibility mode is not direct host execution. The sandbox:

- masks unauthorized projects plus Pi sessions/transcripts, Wayang data, attachments from other sessions, browser profiles, and the command-guard identity PIN; exact Wren Standard compatibility masks every Protected project regardless of allowlist;
- enforces memory write mode for ordinary restricted profiles;
- permits ordinary Standard restricted writes inside the current project and shared host temporary storage; Protected runtimes persist writes only inside their current project; exact Wren Standard compatibility permits ordinary host writes while protected host backing remains hidden and unmodifiable;
- strips internal capabilities and PIN-like environment variables;
- blocks Unix-domain sockets for ordinary restricted profiles, permits them for exact eligible Wren Standard-project compatibility, and blocks raw `sudo` for all profiles;
- allows every outbound TCP destination through sandbox-runtime's HTTP/SOCKS proxies, including public Internet, loopback, LAN, and VPN services.

This networking supports proxy-aware tools such as `curl`, package managers, Git HTTPS/SSH, and most web/API clients. It does not provide raw sockets, inbound listeners, UDP-dependent protocols, or transparent networking for programs that ignore proxy settings.

If sandbox prerequisites are unavailable, bash is removed rather than replaced with command-string parsing. Run `make doctor` to check prerequisites.

Full destination access is an explicit operator tradeoff. A shell can forge HTTP origins and call passwordless Wayang or other local APIs, so source-attributed companion-tool authorization is not a network sandbox. Memory modes prevent participating memory tools and filesystem writes; they cannot prevent an agent from deliberately sending text to any reachable network service. Provider calls made by the host agent runtime are unaffected.

Browser and Apps companion calls use source-session-attributed in-process capabilities and reauthorize the source profile against the target project. Protected browser access additionally requires the exact active `wayang.protected-browser.v1` assignment. Once granted, browser authority is broad and may mutate authenticated sites; the capability check is not an operation-level read-only policy. App manifest commands remain same-user unsandboxed processes, so agent start/restart fails closed whenever any Protected project exists; manual authenticated launch remains available after human review.

## Security boundary

These controls protect participating Wayang tools, scheduler/search/catalog code, Dream, and reviewed companion integrations. They do not isolate or prevent disclosure through:

- arbitrary processes running as the same OS user;
- trusted extension code already executing inside the Wayang process;
- manually launched project applications;
- another independently launched Pi instance that does not use the companion policy;
- network-enabled bash deliberately posting data to any reachable Internet, LAN, VPN, or loopback service.

Use a separate OS account, container, or VM when those actors must be mutually isolated. See [SECURITY.md](../SECURITY.md) and [configuration.md](configuration.md#protected-projects-and-bash-sandboxing).

## Data and rollback

Project/profile/session policy, capability associations, Protected-automation jobs, and their schedules are stored persistently in private `WAYANG_DATA_DIR/store.json` and survive service restarts and host reboots. Store schema 3 adds `protectedAutomationJobs` and `protectedAutomationRuns`; fresh and migrated stores initialize both as empty and create no capability authority. Rows support queued/running and terminal completed/failed/skipped/cancelled/needs-user/interrupted/denied lifecycle states. Owner-bound immutable snapshots, bounded private runtime state/diagnostics, and persistent exact-job browser realms live beneath `WAYANG_DATA_DIR/protected-automation/`; public projections expose metadata, hashes, counts, fixed outcomes, and attention—not source, stdout/stderr, page, profile, credential, or downloaded-file contents. The first schema migration creates a mode-`0600` backup and aborts rather than overwriting malformed or unsupported data.

Compiled bounds include 4,096 jobs globally and 500 run rows per job. Job listing defaults to and is capped at 50 rows, with an exact-owner `after_job_id` cursor; run listing defaults to 100 and is capped at 500. A snapshot is capped at 1,024 files, 512 directories, 4 MiB per file, 32 MiB total, depth 32, and 1,024 bytes per relative path. Snapshot storage is capped at 32 revisions per job, 64 MiB per exact Project–Agent pair, and 256 MiB globally. Published state is capped at 256 files/16 MiB; stdout and stderr at 1 MiB each; private runtime storage at 64 MiB/job, 128 MiB/pair, and 512 MiB/global. Downloads are capped at 32 observed files/lease and 32 MiB/file, with materialized incoming data capped at 32 files/64 MiB/run.

The deterministic Node child can write anywhere in the whole authorized Project; those ordinary Project outputs are not covered by the private runtime quotas and cannot be rolled back on revoke/cancel. Persistent Chromium profile data is also not byte-quota-bounded and can grow between runs. A one-use identity-PIN purge is available only for a tombstoned, fully stopped job; it removes job/run metadata, snapshots, private runtime state/diagnostics, and the browser realm while preserving Project outputs. Binary rollback still requires stopping Wayang and restoring the pre-schema private store backup before starting an older binary.

New chat uploads use private per-session directories:

```text
WAYANG_DATA_DIR/attachments/<full-session-id>/
```

Pi transcripts remain under Pi's session storage and are denied to participating agent path tools. The private Dream policy projection is under `WAYANG_DATA_DIR` and contains metadata/decisions, not transcript text.

Do not run an older Wayang binary against the migrated store: older code may discard unknown fields. For rollback, stop Wayang and restore the pre-migration private store backup before starting the older binary.
