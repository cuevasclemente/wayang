# Security policy

## Supported versions

Until tagged releases begin, only the latest `main` branch is supported with security fixes. Older commits and private forks may not receive fixes.

## Report a vulnerability privately

Use GitHub's **Report a vulnerability** / private security advisory flow for this repository if it is enabled. Include the affected commit, impact, minimal reproduction, and suggested mitigation, but remove credentials, real transcripts, private paths, hostnames, cookies, and user data.

Do **not** open a public issue for an exploitable vulnerability. If GitHub private vulnerability reporting is not available, open only a minimal public issue asking the maintainers to establish a private channel—do not include vulnerability details. Maintainers must confirm a durable private reporting channel before public release if GitHub advisories are not enabled.

No response or remediation SLA is promised for v0.1. Please allow maintainers time to investigate before disclosure.

## Threat model

Wayang is a privileged control interface for one trusted user and the pi coding-agent harness. Depending on configured tools and extensions, an agent can read/write files, execute commands, manage sessions/jobs/apps, and control an authenticated browser. Provider credentials, OAuth state, transcripts, projects, browser profiles, and application data may all be reachable from the host process.

Wayang:

- is **not** a general same-user sandbox;
- is **not** a multi-user or multi-tenant service;
- enforces registered Protected-project boundaries and agent allowlists for participating path tools and bash; ordinary restricted runtimes in Standard projects remain project-scoped, while a restricted runtime inside its authorized Protected project may read ordinary/unregistered host paths and Standard projects but may write only its own project and cannot read any other Protected project or protected backing artifact; the exact migration-seeded Wren profile in a Standard project—including scheduled runs—may read and write ordinary host paths and use visible Unix IPC while every Protected root remains masked; an exact reviewed project+profile assignment may instead grant direct host execution that bypasses those masks; none of these modes isolates temporary files, arbitrary same-UID processes, visible same-user services, or trusted in-process extensions from the host user;
- deliberately allows every outbound TCP destination from sandboxed bash through HTTP/SOCKS proxies, including Internet, loopback, LAN, and VPN services; this is not a network isolation or data-loss-prevention boundary;
- removes bash when the required OS sandbox cannot prove its configured filesystem restrictions and, for socket-blocked profiles, Unix control-socket restrictions;
- does not make unreviewed pi extensions/packages safe;
- does not provide TLS or certificate management;
- cannot make public exposure safe solely by requiring a shared password.

Authentication controls who can reach Wayang. Project policy narrows participating tool, filesystem, memory, and workflow actions; it does not reduce the authority of the main Wayang/pi process, trusted in-process extensions, unrelated same-UID processes, or network-enabled shell commands after login. A shell can forge an HTTP `Origin` and reach passwordless loopback APIs. Memory `none`/`read` prevents participating memory tools and direct filesystem mutation, but cannot prevent deliberate disclosure to a reachable Memoriki/MemPalace or other network service.

PIN-backed capability authority is identity-neutral. Its sole live durable authority is an approved association between one immutable Project ID and one stable Agent Profile ID. Project privacy mode, profile enabled state, and the project's exact-profile allow decision are rechecked. Provider/model are fluid runtime choices and never confer, narrow, or revoke capability authority. Names, prompts, and legacy environment keys do not confer capability authority; copying a profile creates a different stable ID and does not transfer associations. Separately, for compatibility with pre-policy Wayang, only the exact migration-seeded Wren stable ID plus its non-user-settable historical kind receives global resources and broad ordinary-host filesystem/IPC access in Standard projects, including scheduled runs. Renames preserve that exact row; copies and lookalikes do not acquire it. Protected project roots and protected backing artifacts remain masked in this Wren mode, which is distinct from capability-granted direct host execution.

`wayang.host-execution.v1` is restricted to Standard projects. It bypasses the bash filesystem sandbox and runs cooperatively as the Wayang OS user. It does not itself elevate privileges, but it exposes every file, process, credential, capability, network service, memory store, Protected backing path, and pre-existing privilege mechanism available to that account. If Wayang is privileged, host execution is equally privileged.

`wayang.protected-browser.v1` is restricted to Protected projects. It grants broad control of a persistent authenticated browser: navigation, inspection, clicks, typing, downloads, and any site action reachable through the browser tools. It is not vendor-specific, read-only, or limited to export controls. A mistaken or compromised agent may disclose page data or make consequential account changes. Login, MFA, CAPTCHA, payment, and other secret-bearing steps remain human-only and must never enter chat or tool input.

Protected-browser downloads save directly as ordinary project files under `.wayang/browser-downloads/`. Wayang does not arm, quarantine, scan, approve, open, import, or execute them. Agents with project read/write access may inspect, move, or delete them; any separately granted execution surface may also execute them. Treat downloaded files according to their source and intended downstream parser rather than assuming Wayang has established content safety.

Protected-automation downloads use a different bounded flow: Chromium stages at most 32 observed files per lease, each at most 32 MiB; a one-use handle atomically materializes a completed file under the run's `incoming/` directory, capped at 32 files and 64 MiB total. This establishes completion, ownership, origin, and storage bounds—not content safety. Job code must validate expected formats and never execute downloaded content.

`wayang.protected-automation.v1` has a completed Milestones 0–5 implementation and is compiled with `activationAvailable: true`. A deployment restart is needed only when putting new code into service; approval and state initialization do not require a restart. Capability approval reuses the command guard's existing identity PIN, and PIN entry is the normal human approval action for an exact reviewed Project–Agent pair. On startup, the deployed service automatically creates missing non-secret attempt/cooldown state under `WAYANG_DATA_DIR` with owner-only permissions and preserves it across reboots. Unsafe or missing PIN metadata and unsafe or malformed existing state fail capability approval closed without replacement. `make setup-capability-approval` is only an optional manual preflight/migration. Capability associations, deterministic jobs, and schedules persist in the service store. Until an exact association is approved, no production job, timer, browser realm, or credential-preparation path for that pair can run. Existing Protected Scheduled Agent Job denial is separate and remains unchanged.

For an exact eligible pair with PIN-approved authority, deterministic jobs run immutable Node snapshots through a shell-free Linux direct-Bubblewrap runner. Wayang constructs no Pi session or transcript and provides no model, provider, prompt, extension, MCP, shell, general executable view, Unix socket, or generic child TCP/UDP network. `@anthropic-ai/sandbox-runtime` remains a recorded **NO-GO** for this boundary because its shell/`socat` setup and compatibility writes do not satisfy it. macOS Protected automation is unavailable; there is no weaker runtime or host-execution fallback.

This is still a cooperative same-UID control, not hostile-code containment, DLP, or proof against daemonization and detached same-user processes. The child receives a read-only source snapshot but a writable mount of the **whole authorized Protected Project**, plus bounded private run and state roots. Completed or racing Project writes cannot be rolled back or hidden by cancellation/revocation. Project code and authenticated browser actions can disclose data or cause remote effects, and those effects cannot be undone.

Browser-enabled jobs receive only a bounded inherited RPC to a backend-owned, exact Project/Profile/Job Chromium realm—never raw CDP, cookies, storage, profile paths, screenshots, or arbitrary JavaScript. Stored navigation origins must be exact HTTPS origins. Wayang intercepts and attests top-level document requests, rejects disallowed top-level destinations and cross-origin redirect chains, and closes unexpected page targets. This interception is **not** a complete network allowlist: iframe documents and required page subresources are continued and may contact origins outside the job's top-level allowlist. Completed download source URLs must match an allowed exact origin before one-use handles can materialize bounded bytes into the run root.

Login, passwords, MFA, CAPTCHA, passkeys, and other secret-bearing steps remain human-only through an exact source-bound preparation viewer and the guarded credential broker; values must never enter chat, job source, argv, or tool input. Deterministic code reports a fixed `needs_user` outcome and exits rather than retrying ambiguous human or remote work. The persistent browser profile intentionally survives runs/preparation for reauthentication, but unlike snapshots, run state, diagnostics, incoming downloads, and run history, profile storage has no compiled byte quota and may grow on disk until PIN-confirmed job purge.

Explicit revocation, exact-profile allowlist exclusion, an incompatible project privacy change, or Project/Profile deletion tombstones the association denial-first. Profile definition edits—including instructions, tools, resource/memory modes, defaults, and disable/re-enable of the same stable ID—and project instruction/default edits preserve it by design. A disabled profile cannot run; re-enabling restores authority only through fresh runtime handles. Provider/model changes destroy stale runtime surfaces and rebuild them lazily under the same association without another PIN. Denial synchronously blocks future tool dispatch and terminates affected direct-host and Protected-automation process groups with bounded TERM/KILL. It cannot undo filesystem changes, browser actions, downloads, disclosures, credential use, or external side effects already completed. Use separate OS identities or stronger isolation when cross-project, memory, or browser-profile non-readability is required. `make doctor` checks prerequisites, not effective workspace associations.

Legacy identity-specific private environment keys may remain physically present because configuration updates preserve unknown keys, but current authorization ignores them. Do not inspect or rewrite `.env` merely to clean them up. `make doctor` checks capability approval authority metadata, not file contents or effective workspace assignments.

## Safe deployment requirements

1. Keep the default `127.0.0.1:8787` bind whenever possible.
2. For remote access, use a trusted VPN/private network and HTTPS, and set `WAYANG_PUBLIC_ORIGIN` to the exact browser-facing HTTPS origin. Compiled loopback origins remain available for direct/SSH-tunneled administration. Remote passwordless owner controls are denied unless the explicit trusted-proxy identity bridge is configured. Consider both built-in shared-password login and an authenticated reverse proxy according to your risk.
3. A proxy must protect and forward **every** path and WebSocket upgrade, including frontend assets, `/api/*`, `/ws/*`, app proxy routes, chat, browser CDP, and browser VNC. Block direct access to the backend that bypasses the proxy.
4. Treat every person/device with network access and credentials as able to control a host-level agent. VPN membership is not authorization isolation.
5. Use `WAYANG_TRUST_PROXY=loopback` only when the reverse proxy connects from loopback. Configure it to set the upstream `Host` header to the exact `WAYANG_PUBLIC_ORIGIN` authority and to replace—not append to or preserve—client-supplied `Forwarded` and `X-Forwarded-*` headers. `X-Forwarded-Host` is never used for authorization. There is no broad forwarded-header trust mode.
6. If `WAYANG_AUTH_PROXY_IDENTITY_HEADER` is enabled, the proxy must authenticate every Wayang path, strip every client-supplied value for that header, inject exactly one stable authenticated subject ID, and block direct backend access. Wayang accepts this identity only from a loopback peer at the exact configured remote HTTPS origin. Misconfigured header sanitization is an administrator-authentication bypass.
7. Use Secure cookies over HTTPS. Never disable Secure-cookie behavior for remote login.
8. Run Wayang as an unprivileged dedicated user when practical. Do not run it as root. This is especially important for any runtime granted host execution because it inherits the Wayang process's full OS authority.
9. Review third-party pi packages/extensions before installation; they execute with the host user's authority. Preserve pi's project-trust gate and approve project `.pi` resources only after source review.

When built-in authentication is enabled, `/healthz`, login/static assets, `GET /api/auth/status`, and `POST /api/auth/login` remain public by design. Other APIs and all WebSocket transports must share the same session checks. Browser origin checks for state-changing requests and every WebSocket upgrade apply even when password authentication is disabled. Report any bypass privately.

## Sensitive data

Protect at least:

- root `.env` and `.env.backup`;
- `~/.pi/agent/auth.json`, settings, extensions, and session JSONL;
- the command-guard identity PIN under the XDG config root (normally `~/.config/pi/command-guard-identity-pin`);
- `WAYANG_DATA_DIR/workspace-capability-approval/pin-attempt-state.json`, the private non-secret capability-approval attempt/cooldown record, created automatically with owner-only permissions when missing and preserved across reboots;
- `~/.wayang/store.json`, `search.db`, `auth-sessions.json`, private policy projections, and session-scoped `attachments/`;
- Protected-automation job/run metadata, immutable snapshots, bounded state/diagnostics/download staging, and persistent job browser realms under `WAYANG_DATA_DIR/protected-automation/`;
- projects and files Wayang can access;
- shared `WAYANG_DATA_DIR/browser-workbench/` and explicit project `.pi/browser-workbench/` profiles, cookies, downloads, and artifacts;
- the ephemeral browser-credential unlock socket and in-memory Bitwarden session;
- proxy/VPN configuration and logs;
- screenshots, debug output, browser traces, database copies, and backups.

The configuration wizard writes `.env`, its backup, and generated authentication material with mode `0600`. It stores only a salted scrypt password record, not the shared password. Browser sessions use opaque HttpOnly, SameSite cookies; stored session records contain keyed token hashes. Rotate provider credentials and the Wayang password/session secret if exposure is suspected.

Do not attach `.env`, auth files, transcripts, profiles, traces, or raw logs to issues. Before sharing diagnostics, reproduce with a synthetic HOME, pi directory, Wayang data directory, project, and credentials.

## Browser, apps, and TTS

The managed browser may contain active sessions to unrelated services. A compromised Wayang session can potentially act through that browser. Use a dedicated profile, minimize logged-in accounts, and keep profile directories private. The default ordinary-browser profile is shared across Wayang projects, so ordinary project boundaries do not isolate authenticated browser state. A Protected project is denied browser authority by default; associating `wayang.protected-browser.v1` with an exact Project-Agent pair gives any model currently implementing that agent the broad browser authority described above, not a narrowed read/export surface. Protected persistence remains isolated by immutable Project and Agent Profile IDs.

Guarded Bitwarden fills are designed to prevent accidental credential values from entering UI state, agent results, persisted metadata, logs, or the clipboard. Credential choices are one-use and exact-origin/document-bound. Successful fill keeps user mode and blocks all agent inspection; sequential fills in the same top-level document union known redaction values. Only the exact-Origin UI-only allow route can enable read-only text/DOM inspection. Agent-visible outputs are redacted against raw known values and deterministic reversible URI/component, URL-form, standard-base64, and base64url representations; percent-hex matching is case-tolerant. Screenshots and every agent mutation remain blocked until a confirmed new CDP main-frame loader/document identity. URL-only changes (`pushState`, `replaceState`, hash) and failed/uncommitted navigation do not clear protection. General Resume Agent cannot bypass that state. Wayang does not click Submit or explicitly submit a form, but sites may react to the input/change events emitted by fill.

This is not a strong boundary against another process running as the same OS user, which may be able to inspect Wayang/Chromium process memory or attach to CDP. A same-UID process that also has the normal UI session can send an untagged exact-Origin request that is classified as UI traffic; this is an explicitly accepted guarded-boundary limitation, not a hard-isolation claim. Unlock only from the provided local-terminal helper; never pass a master password or session key through chat, command arguments, HTTP, or environment configuration.

Project-local apps are executable code managed by the backend and displayed in the trusted Wayang origin. Review app manifests and source before launching them. Do not treat an iframe as a security sandbox for hostile code. Agent Apps requests use a loopback, route-scoped, in-process capability bound to the exact source Wayang session; central policy reauthorizes that source profile against the target project on every operation, and a forgeable loopback `Origin` is not agent authorization. Registration, listing, state, logs/events, and stop cannot launch app code. Because manifest commands remain unsandboxed same-user shell commands, agent start/restart fails closed whenever any protected project is registered; authenticated manual launch remains available after human review. Managed app children and proxy upstreams do not receive Wayang's internal capabilities, but app processes still run as the Wayang OS user.

Project-root `AGENTS.md` writes use optimistic hashes, no-follow reopening, inode/content revalidation, registered-root revalidation, and atomic no-overwrite creation. These controls reject stale/cooperative races; they do not isolate Wayang from a hostile same-UID writer, which can race after the final check or modify the file after commit.

The optional restricted-profile MCP proxy is a backend-owned positive allowlist, not the global Pi MCP adapter. It binds one private mode-`0600` policy to an exact live session/profile/Protected project and only compiled reviewed server/tool ceilings. Children receive a strict environment, bounded stdio framing, sanitized errors, and teardown on revocation; protected oversized results never intentionally use shared temporary storage. Review launcher source and require fixed paths plus `exec`. The boundary does not stop arbitrary same-UID launcher replacement, a deliberately network-enabled bash command from contacting reachable services, or all pathname races against a cooperating same-UID writer. Use separate OS isolation and service authentication where those threats matter.

Configured TTS sends assistant text to the selected service. A remote broker/provider is a separate disclosure boundary and must be secured independently.

## Dependency and update practice

Use committed lockfiles and `npm ci`. Review dependency advisories for actual reachability rather than suppressing or blindly accepting them. Update from a reviewed source, rerun `make check` and relevant E2E/auth tests, and back up private data before migrations.
