# Configuration

`make configure` is the supported configuration path. It accepts API keys and the optional shared password only through hidden local-terminal input, preserves unknown `.env` keys, saves the previous file as `.env.backup`, and atomically writes `.env` with mode `0600`.

Wayang's launcher parses `.env` as data; it never shell-sources it. Shell substitutions, command substitutions, and variable expansion are not executed. Existing process environment variables take precedence over `.env`.

## Core server settings

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_HOST` | `127.0.0.1` | Backend bind host. Keep loopback unless the complete deployment is protected. |
| `WAYANG_PORT` | `8787` | Backend HTTP/WebSocket port, 1–65535. |
| `WAYANG_PUBLIC_ORIGIN` | none | Optional exact browser-facing `http(s)` origin for a reverse proxy or exposed bind. No path/query/fragment. Compiled loopback origins on `WAYANG_PORT` remain accepted for direct or SSH-tunneled administration. |
| `WAYANG_DATA_DIR` | `~/.wayang` | Private Wayang metadata/search/session-auth directory. Use an absolute path in `.env`; `~` is not expanded. |
| `WAYANG_URL` | unset; `make configure` recommends the public origin or selected loopback bind host on `WAYANG_PORT` | Optional convention for a companion pi-tool backend URL. Core Wayang does not consume it, and external tools use it only when they explicitly support `WAYANG_URL`. |

Companion tools are optional. The `make configure` wizard recommends the configured public origin or, when none exists, the selected loopback bind host on `WAYANG_PORT` (with IPv6 bracketed, such as `http://[::1]:8787`). An absent, unspecified, wildcard, invalid, or non-loopback host safely falls back to `http://127.0.0.1:<WAYANG_PORT>`. This is a wizard recommendation, not a core Wayang runtime fallback or a default shared by every external tool. An existing explicit `WAYANG_URL` remains the wizard prompt default even when it differs from the recommendation, so review it rather than expecting a silent rewrite. When built-in authentication is enabled, companion access requires an intentionally designed authenticated integration; do not copy browser credentials, shared passwords, or session cookies into companion configuration.

Deprecated compatibility aliases `PI_WEB_UI_HOST`, `PI_WEB_UI_PORT`, and `PI_WEB_UI_DATA_DIR` are still read when the corresponding `WAYANG_*` variable is absent. New installations should not use them.

## Connector-neutral messaging and Matrix Application Service

Messaging is disabled by default. Its first adapter uses the Matrix Application Service API, but no homeserver registration, virtual user, room, token, or route becomes active merely by building Wayang.

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_MESSAGING_ENABLED` | `0` | `1` enables the reviewed connector bootstrap; any other value fails configuration. |
| `WAYANG_MESSAGING_CONFIG_PATH` | empty | Absolute canonical path to the owner-private versioned messaging JSON. Required when enabled. |

Disabled startup does not open or validate the path and performs no Matrix network, provisioning, worker, or session action. Enabled startup requires a no-symlink regular file owned by the current uid, exact mode `0600`, bounded bytes, strict JSON with no unknown fields, an exact Matrix homeserver origin/server name/Application Service namespace, an exact Wayang base URL for `/sessions/<id>` handoffs, opaque `hs_token`/`as_token` values, and reviewed immutable Project/Profile endpoint declarations. Homeserver and handoff origins must use HTTPS except for exact loopback HTTP. More than one endpoint for the same exact Project/Profile pair is rejected across connectors.

Keep Matrix tokens only in that private file. Do not place them in `.env`, command arguments, URLs, logs, fixtures, screenshots, or chat. The inbound Application Service route accepts only the homeserver's exact bearer `hs_token`; browser sessions and the outbound `as_token` confer no inbound authority.

Completed transaction/event/delivery graphs retain a seven-day deduplication horizon and are pruned atomically only after all related deliveries are terminal. High-water capacity is reported as connector attention.

If messaging is explicitly enabled with malformed or unsafe configuration, Wayang fails before listening. Once configuration is valid, a temporarily unavailable homeserver does not take down the Wayang browser workbench: Matrix remains blocked/retrying with bounded attention state. E2EE is not implemented; encrypted events are never treated as prompts and the adapter never claims end-to-end confidentiality merely because room encryption state exists.

Real Tuwunel registration, token provisioning, room/user creation, and service activation require the separate M4 deployment review. Do not point this development configuration at a live homeserver during tests.

## Built-in shared-password login

Wayang's optional built-in login is one password for one trusted instance. It has no username, accounts, roles, per-project authorization, or tenant isolation.

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_AUTH_ENABLED` | `0` | `1` enables authentication; `0` preserves passwordless behavior. |
| `WAYANG_AUTH_PASSWORD_HASH` | none | Versioned scrypt record generated by `make configure`. Required when enabled. |
| `WAYANG_AUTH_SESSION_SECRET` | none | Random secret of at least 32 bytes generated by the wizard. Required when enabled. |
| `WAYANG_AUTH_SESSION_DAYS` | `30` | Persistent session lifetime, integer 1–365. |
| `WAYANG_TRUST_PROXY` | `loopback` | `loopback` trusts forwarded protocol/client IP only from a loopback proxy; `0` trusts none. |
| `WAYANG_AUTH_PROXY_IDENTITY_HEADER` | unset | Optional stable identity header injected by an authenticated loopback reverse proxy. Enables proxy-owned Settings and Protected-browser controls without built-in auth. Requires an exact remote HTTPS public origin and is mutually exclusive with built-in auth. |
| `WAYANG_AUTH_COOKIE_SECURE` | `auto` | `auto` marks the cookie Secure when the trusted request origin is HTTPS; `1` always; `0` never. |

The password itself is never stored. The browser receives a random opaque token in an `HttpOnly`, `SameSite=Strict` cookie; the server stores only a keyed hash in `WAYANG_DATA_DIR/auth-sessions.json` (mode `0600`). Password or session-secret rotation invalidates existing sessions. Login attempts have an in-memory bounded rate limit and failure delay.

When authentication is enabled, `/healthz`, the login shell/static assets, `GET /api/auth/status`, and `POST /api/auth/login` remain public. Other API routes, the app proxy, chat WebSocket, browser CDP WebSocket, and browser VNC WebSocket require a session. State-changing requests and every WebSocket upgrade are checked against the request origin even when password authentication is disabled, so loopback service access is not granted to arbitrary webpages.

For HTTPS behind a proxy on the same host, the defaults `WAYANG_TRUST_PROXY=loopback` and `WAYANG_AUTH_COOKIE_SECURE=auto` allow a correct `X-Forwarded-Proto: https` header to produce a Secure cookie. The proxy must set the upstream `Host` header to the exact `WAYANG_PUBLIC_ORIGIN` authority and replace, not append to or preserve, client-supplied `Forwarded` and `X-Forwarded-*` headers. Wayang ignores `X-Forwarded-Host` for authorization; only the actual `Host` authority is accepted. If the proxy is not on loopback, v0.1 intentionally does not trust its forwarded headers; redesign the topology rather than enabling broad header trust. Never use `WAYANG_AUTH_COOKIE_SECURE=0` for remote login.

When `WAYANG_AUTH_PROXY_IDENTITY_HEADER` is configured, the proxy must additionally authenticate **every** Wayang HTTP and WebSocket path, remove any client-supplied value for that header, and inject exactly one non-empty stable identity value from its authenticated session. Prefer an immutable subject ID (for Authentik, commonly `X-Authentik-UID`) over a mutable display name or email. Wayang accepts it only when the direct peer is loopback, the effective authority and browser `Origin` exactly equal the configured remote HTTPS origin, and built-in auth is disabled. The raw identity is never returned or stored as the owner handle; a process-private HMAC binds it to the exact origin. Restarting Wayang invalidates pending owner-bound approval challenges.

Rerun `make configure` to rotate the password. Do not hand-edit or paste a plaintext password into `.env`.

Remote passwordless requests may use ordinary Wayang features according to the deployment network boundary, but they cannot own PIN-backed capability approvals unless the trusted proxy identity bridge above resolves an authenticated owner. Capability Settings requires a built-in authenticated session, a configured trusted-proxy identity, or a direct loopback peer with a loopback browser origin. An SSH tunnel to `127.0.0.1:WAYANG_PORT` provides the loopback administration path without treating the 8-digit command-guard PIN as a network-login password.

For a single-user private LAN without an existing reverse proxy, Wayang includes an optional generated **foreground Caddy** path using built-in auth, loopback upstream, an exact HTTPS origin on an unprivileged port, forwarding-header replacement, no request logs, and Caddy's local CA. See [Local HTTPS remote administration](local-https.md). It does not install Caddy, configure DNS/CA trust, change `.env`, enter a password, or install a service.

## Pi provider authentication

Wayang uses pi 0.84.1's standard authentication and model runtime.

### OAuth or pi-managed API key

Run:

```sh
make pi-login
```

Inside the pinned local pi CLI, run `/login`, choose the provider, complete the human/browser handoff, then `/quit`. Pi stores credentials in `~/.pi/agent/auth.json` with private permissions and refreshes OAuth credentials when supported. Wayang scripts never read or copy that file's contents.

### API-key environment variables

`make configure` supports hidden entry for the providers Wayang can automatically detect as defaults:

| Provider | Variable |
|---|---|
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| Google Gemini | `GEMINI_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |
| Mistral | `MISTRAL_API_KEY` |
| Groq | `GROQ_API_KEY` |
| Cerebras | `CEREBRAS_API_KEY` |
| xAI | `XAI_API_KEY` |
| Fireworks | `FIREWORKS_API_KEY` |

The bundled pi release also supports additional providers, including Azure OpenAI (`AZURE_OPENAI_API_KEY` plus endpoint/resource settings), Cloudflare, Vercel AI Gateway, ZAI, OpenCode, Hugging Face, Kimi, MiniMax, Xiaomi MiMo, Amazon Bedrock/AWS credentials, and Google Vertex application-default credentials. Configure specialized providers through pi `/login`, pi's provider documentation, and model settings rather than extending the wizard with unreviewed cloud fields. Do not use CLI `--api-key` arguments.

Credential resolution in pi prefers a CLI override, then pi `auth.json`, then environment variables, then a custom provider key. Wayang does not accept provider keys in browser storage or URLs.

### Pi paths and settings

| Variable/path | Meaning |
|---|---|
| `~/.pi/agent/settings.json` | Global pi settings and default provider/model. |
| `<project>/.pi/settings.json` | Project settings overriding global settings. |
| `PI_CODING_AGENT_DIR` | Override pi's config root (default `~/.pi/agent`). |
| `PI_CODING_AGENT_SESSION_DIR` | Override session storage when explicitly supported by the pi session path. |
| `PI_OFFLINE=1` | Disable pi startup network operations, including update checks and telemetry. Provider calls will consequently be unavailable. |
| `PI_SKIP_VERSION_CHECK=1` | Disable only pi's version check. |
| `PI_TELEMETRY=0` | Disable pi install/update telemetry. |

Unlike the interactive Pi CLI, Wayang treats every registered project folder as trusted for project-local `.pi` settings, extensions, skills, prompts, themes, system prompts, and packages. These resources may install dependencies or execute code as the Wayang host user for any agent profile. Register only reviewed projects inside the same single-user trust boundary. Restricted agent tool policies do not sandbox project-local Pi code.

Pi session JSONL files, authentication state, trust decisions, and chat attachments are sensitive. New uploads live under private `WAYANG_DATA_DIR/attachments/<full-session-id>/` directories; participating agent tools deny cross-session attachments and the deprecated shared `/tmp/wayang-attachments` root. Do not point test runs at a real Pi or Wayang data directory.

## Networking and reverse proxies

Default loopback use needs no proxy. Wayang authorizes browser origins from explicit configuration rather than trusting arbitrary request hosts, which prevents DNS-rebinding pages from becoming a localhost origin. The compiled origins `http://127.0.0.1:<port>`, `http://localhost:<port>`, and `http://[::1]:<port>` are always accepted for direct or SSH-tunneled administration. When `WAYANG_PUBLIC_ORIGIN` is set, that one exact remote origin is accepted in addition to—not instead of—those loopback origins. For access from another device, set the exact HTTPS browser-facing origin and make an explicit deployment decision:

1. prefer a private VPN or equivalent trusted network;
2. use HTTPS for any built-in-password login outside the local machine;
3. optionally use an authenticated reverse proxy in front of a passwordless Wayang;
4. ensure the proxy supports WebSocket upgrades and protects **all** paths, including `/api/*`, `/ws/*`, app proxy routes, static UI routes, and browser transports;
5. set the upstream `Host` header to the exact public-origin authority, and replace client-supplied `Forwarded` and `X-Forwarded-*` headers rather than appending or passing them through;
6. prevent direct access to an unprotected alternate bind/port.

Built-in auth and external forward auth can protect the deployment independently or together. The optional proxy identity bridge is narrower: it is mutually exclusive with built-in auth and converts one explicitly configured, sanitized header into an owner identity only at the loopback-proxy/exact-origin boundary described above. VPN membership alone grants network reachability; it does not sandbox what the agent can do. `make local-https-check` and `make local-https` implement the foreground Caddy/built-in-auth reference path documented in [Local HTTPS remote administration](local-https.md); they accept no identity header and never daemonize the proxy.

The configuration wizard requires the exact acknowledgement `I UNDERSTAND` before saving a non-loopback, passwordless bind. This is a warning, not proof that the proxy is correct.

## Workspace privileged capabilities

Listed workspace capabilities are assigned through a PIN-approved association between one immutable Project ID, one stable Agent Profile ID, and one compiled capability ID—not through a deployment identity or environment flag. The association is the sole live durable authority for those capabilities. Project privacy mode, profile enabled state, and the project's exact-profile allow decision must match. Provider/model are fluid runtime choices and never participate in capability authority. Renaming or editing a stable profile preserves its associations; copying creates a new ID and transfers none. The legacy Wren Standard-project compatibility described below is not a capability grant and never selects direct host execution.

The current publicly listed and grantable privileged capabilities are:

- `wayang.standard-resources.v1`, available only to Standard projects, loads reviewed global Pi instructions, skills, prompts, settings, and extensions.
- `wayang.host-execution.v1`, available only to Standard projects, bypasses the per-command bash filesystem sandbox and executes with the Wayang OS user's ambient authority.
- `wayang.standard-browser.v1`, available only to Standard projects, and `wayang.protected-browser.v1`, available only to Protected projects, give fresh interactive runtimes backend-owned explicit `browser_*` tools over an exact Project-Agent persistent browser. This is broad browser authority: it can navigate, inspect, click, type public non-secret text, download bounded files, and perform actions accepted by sites already authenticated in that profile. It is not limited to a particular vendor, export workflow, or read-only operation. Scheduled/background sessions never receive these tools.
- `wayang.protected-automation.v1`, available only to Protected projects when the grantable build is deployed, authorizes deterministic no-Pi automation for one exact Project–Agent pair.

`wayang.protected-automation.v1` is compiled with `activationAvailable: true`; production status, catalog, approval, and tool reporting are implemented. A service restart is needed only to deploy new code, not to initialize state or record an approval. There is no environment-variable bypass: the normal human approval action is entering the existing command-guard identity PIN for the exact reviewed Project–Agent pair. Startup automatically creates missing non-secret attempt/cooldown state under `WAYANG_DATA_DIR` with owner-only permissions and preserves it across reboots. Unsafe or missing PIN metadata and unsafe or malformed existing state fail approval closed without replacement. `make setup-capability-approval` is optional manual preflight/migration, not required setup or build-time configuration. Protected Scheduled Agent Jobs remain a separate model-driven path and remain denied.

After exact eligible-pair approval, a fresh eligible runtime receives the source-session-bound `protected_automation` tool. It can capture/update/tombstone/rebind, enable/pause, run now/cancel, list jobs/runs, and request exact job-browser preparation for its implicit Project–Agent pair. Owner HTTP/UI surfaces are metadata-only except denial-oriented emergency pause/cancel, exact preparation attachment, and a one-use PIN-confirmed purge of an already tombstoned and fully stopped job. Purge removes the job row, run history, immutable snapshots, private runtime state/diagnostics, and persistent browser realm; it explicitly preserves every Project output.

These capabilities are cooperative same-UID controls, not containment. Host execution may reach files, processes, credentials, memory stores, Protected backing paths, and network services available to the Wayang account. Protected browser authority may disclose page content or make consequential account changes. Human-only login, MFA, CAPTCHA, payment, and other secret-bearing handoffs remain required; credentials must not enter chat or tool parameters. While a live Protected browser is in `user` or `paused` control, automatic five-minute agent-runtime idle cleanup retains its exact source lease so the human can explicitly resume across chat turns; explicit stop, model/agent change, capability denial, and service shutdown still revoke it. A later prompt never revives a revoked lease: Wayang destroys the stale handle and lazily constructs fresh authority.

Explicit revocation, exact-profile allowlist exclusion, incompatible privacy, or Project/Profile deletion tombstones the association and requires fresh PIN approval to restore it. Profile definition edits—including instructions, tools, resource/memory modes, defaults, and disable/re-enable of the same stable ID—and project instruction/default edits preserve it. Disabled profiles cannot run. Provider/model changes preserve authority while invalidating stale runtime objects and rebuilding lazily. Denial terminates affected direct-host command and Protected-automation process groups with bounded TERM/KILL, but cannot undo commands, Project writes, disclosures, downloads, browser actions, or external side effects already completed. Use a separate OS identity, container, or VM where cooperative project policy is insufficient.

The configuration wizard does not create privileged assignments. Legacy identity-specific keys left in an existing private `.env` may remain physically present because the wizard preserves unknown keys, but Wayang does not use them for authorization. Do not inspect or rewrite `.env` merely to remove them.

### Capability approval cooldown state

Capability activation reuses the human's existing command-guard identity PIN; Wayang does not create, copy, print, or migrate that PIN. Entering it in the approval flow is the normal human authorization action. On service startup, Wayang checks PIN authority metadata and automatically creates missing non-secret `workspace-capability-approval/pin-attempt-state.json` beneath `WAYANG_DATA_DIR`. Created directories are canonical owner-only mode `0700`; the initial state is published as a complete mode-`0600` regular file with a same-directory temporary and atomic no-overwrite link. Valid cooldown state, including attempt counts or a live reservation, is preserved across service restarts and host reboots.

Unsafe or missing PIN metadata, symlinked or non-private paths, hard-linked or incorrectly permissioned files, relative configured data directories, and malformed or unsupported existing cooldown state fail capability approval closed. Startup never repairs or replaces questionable existing authority or state.

For an optional manual preflight or migration, run from the Wayang checkout in the same local account:

```sh
make setup-capability-approval
```

The command checks only owner/type/link/mode/size metadata for the existing PIN authority. It never opens or creates the PIN, never asks for it, and never places it in arguments, environment settings, output, or logs. It applies the same owner-only state creation and fail-closed existing-state rules as startup. It is not required setup or build-time configuration and does not grant or activate a capability, configure workspace tuples, start/restart Wayang, or create a runtime/browser.

`make doctor` reports PIN and cooldown **metadata** readiness without inspecting either file's contents. Doctor uses the active process environment (or the default data path); it intentionally does not parse private `.env`. The optional setup command runs through Wayang's secret-safe launcher so a custom `WAYANG_DATA_DIR` already stored by `make configure` is honored without displaying configuration values.

## Protected projects and bash sandboxing

Unless the exact runtime has an active `wayang.host-execution.v1` assignment, Wayang replaces Pi's local bash backend with a fresh per-execution `@anthropic-ai/sandbox-runtime` helper. On Linux this requires `bwrap`, `socat`, and `rg` plus x64/arm64 seccomp support; on macOS it requires the system `sandbox-exec`. `make doctor` reports sandbox prerequisite readiness; it does not report workspace capability assignments. If the required boundary is unsupported or degraded, Wayang removes sandboxed bash from the session rather than falling back to shell-command inspection.

Protected automation does not reuse this interactive bash sandbox. Sandbox-runtime 0.0.65 is a recorded **NO-GO** because it requires shell/`socat` setup and broader compatibility writes. The completed automation runner is a separate shell-free direct-Bubblewrap path on Linux: an immutable Node snapshot and exact Node ELF startup closure, structured argv, no shell/general host executable view, blocked Unix sockets, an unshared network namespace with no child TCP/UDP delivery, bounded supervision, and no fallback. It deliberately mounts the whole authorized Protected Project writable at `/workspace`, plus bounded run and persistent-state roots. Same-UID interference remains possible, and writes completed or racing before revocation cannot be rolled back. macOS Protected automation is unavailable.

Browser-enabled jobs use an inherited bounded framed RPC to a backend-owned persistent job realm, not child networking, raw CDP, or a profile mount. Exact HTTPS origins constrain top-level documents and completed download sources. The backend intercepts top-level Document requests and rejects cross-origin redirect chains, but it deliberately continues iframe and subresource traffic required by the page; the configured origin list is therefore not a complete browser network/DLP allowlist.

Ordinary restricted profiles in Standard projects can persist writes only in their current project and shared temporary storage. A restricted profile running inside its authorized Protected project may read ordinary/unregistered host paths and Standard projects, including Standard projects whose run allowlist excludes that profile, but it can persist writes only inside its own Protected project. Restricted direct tools and sandboxed bash cannot mutate project-local `.pi` control-plane files. Every other Protected project and protected backing artifact remains read/write masked. The exact migration-seeded Wren stable ID plus historical kind keeps pre-policy Standard-project behavior for both interactive and scheduled runs: global Pi resources load, ordinary host paths are readable and writable as the Wayang OS user, Git configuration is available, and visible Unix sockets may be used. Renaming that exact row preserves compatibility; copied/lookalike profiles and Wren running inside a Protected project do not receive it. A profile switch receives the target policy only after its durable transition completes.

The sandbox masks every other registered Protected project, Pi session storage and known transcript files, `WAYANG_DATA_DIR`, the Wayang checkout's `.env`/`.env.backup`, the legacy `/tmp/wayang-attachments` root, browser-workbench roots, and the command-guard identity PIN. For Standard-source runtimes it also masks projects whose non-null allowlist excludes the source profile; a Protected-source runtime may read Standard projects despite those run allowlists, while its allow-only write policy still confines persistence to its own project. It enforces profile memory mode and passes only non-secret process mechanics such as `PATH`, locale, home, shell, terminal, and temporary-directory metadata; provider keys, OAuth/AWS credentials, proxy credentials, loader hooks, and arbitrary deployment variables are not forwarded. Standard restricted profiles can write the current project and shared host temporary directory; Protected runtimes can write only their current project; exact Wren Standard compatibility can write ordinary host paths except masked Protected/control-plane roots. Shared host temporary storage available to Standard restricted and Wren runtimes is neither private nor durable, so do not place secrets there. The sandbox runtime's deny-then-allow read semantics re-open only `WAYANG_DATA_DIR/attachments/<current-full-session-id>/`; writes to that re-opened attachment subtree never reach host attachment data. Direct path tools use live canonical-path authorization: other Protected projects and Wayang/Pi/PIN artifacts are denied; Standard-source agents also honor target project allowlists; restricted mutations of project-local `.pi` control-plane files are denied; broad `grep`/`find`/`ls` ancestor scans that intersect any denied root fail closed; and only the exact source session's attachment subtree is readable. All profiles deny the Wayang launcher configuration, documented project secret files, Pi auth/config files, managed browser profiles, and `/proc`, `/sys`, and `/dev` control roots.

Outbound TCP networking is intentionally unrestricted by destination through sandbox-runtime's HTTP/SOCKS proxy callback. Proxy-aware commands can reach public Internet, loopback, LAN, and VPN services; raw network sockets, inbound TCP listeners, UDP-dependent protocols, and programs that ignore proxy settings are not supported. Unix-domain sockets are blocked except for exact eligible Wren Standard-project compatibility. This means shell commands can call passwordless Wayang and other local HTTP APIs, and eligible Wren commands can also reach visible IPC services such as the user bus. Project policy constrains participating tools and filesystem access; it is not data-loss prevention against deliberate network or IPC disclosure to a reachable service. These controls are not isolation from arbitrary same-UID processes or trusted extension code already executing inside the backend.

## Restricted-profile MCP grants

Wayang can install a backend-owned, source-session-bound `mcp` proxy in an eligible restricted runtime when `WAYANG_RESTRICTED_MCP_CONFIG_PATH` points to a reviewed private grant file. This is not Pi's global `pi-mcp-adapter`: it does not merge global or project MCP configuration, load extension factories, expose direct tools, or inherit future servers automatically.

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_RESTRICTED_MCP_CONFIG_PATH` | empty | Absolute path to an owner-only mode-`0600` JSON policy containing exact profile/project bindings, reviewed launcher paths, and positive server/tool allowlists. The file must not contain credential values. |

The current compiled ceiling recognizes only reviewed `exasearch`, `mempalace`, and `public-readonly` aliases. A private grant may narrow that ceiling but cannot add servers or tools. The proxy revalidates its source session, runtime generation, current profile/project authorization, private grant, exact backend-issued tool object, and underlying MCP tool name before dispatch. Scheduled sessions, subagents, non-Protected projects, memory-write profiles, Report Publisher, global/project MCP configs, auth/UI/resources/sampling/elicitation, regex search, and unreviewed future tools fail closed.

MCP children run lazily with exact reviewed launchers, `shell:false`, a fixed working directory, a strict environment allowlist, discarded stderr, bounded JSON-RPC framing, timeouts, and teardown on revocation/session close. Launchers must use `exec`, fixed absolute binaries/modules/credential paths, and private isolated homes where needed. Credentials are loaded only inside those child launchers and never placed in the JSON grant. Public and MemPalace results are bounded; oversized protected results may be stored as private artifacts under the authorized project rather than shared temporary storage.

Changing this path or its grant affects only eligible restricted runtimes. Grant removal/tightening blocks calls immediately; use a fresh runtime after adding or widening a grant. The policy is not isolation from arbitrary same-UID processes or deliberate network access through sandboxed bash; authenticate sensitive local services when that boundary matters.

## Protected automation runtime and storage

There are no stable environment variables that enable, weaken, or configure Protected automation. When deploying a build that includes the grantable capability, restart the service as part of that code deployment; no restart is required for automatic cooldown initialization or later approval changes. Use the normal one-use flow to enter the existing command-guard PIN and approve only the exact reviewed Project–Agent pair, then start a fresh eligible session. This documentation update does not deploy code or approve an association.

Implemented scheduling is canonical host-local five-field cron. Each job persists a cursor and local wall-minute occurrence key: the repeated fall-back minute is deduplicated, a nonexistent spring-forward minute does not run, `skip` advances without catch-up, and `run_once` collapses any number of missed never-started occurrences to the latest one. Cursor advancement and the scheduled queued claim are durable together. Startup dispatches recovered queued claims once, marks recovered running claims `interrupted` without retry, then evaluates the downtime interval. Overlap is skipped and there is no automatic retry/backoff. Schedule edits reset the cursor to commit time.

The no-Pi runner supports Node snapshots only and is Linux-only. It does not construct a Pi session/transcript or expose a model/provider/prompt surface. The child receives `/snapshot` read-only, the whole Protected Project at writable `/workspace`, ephemeral `/run/wayang-automation/run`, persistent staged `/run/wayang-automation/state`, and optional bounded FD 3 browser RPC. It receives no arbitrary environment, generic network, Unix socket, raw browser profile, or raw CDP.

Compiled major bounds include:

- snapshots: 1,024 files, 512 directories, 4 MiB/file, 32 MiB/revision, 32 revisions/job, 64 MiB/exact pair, 256 MiB/global;
- histories: 4,096 jobs globally and 500 runs/job;
- persisted state: 256 files and 16 MiB/job generation;
- diagnostics: 1 MiB stdout and 1 MiB stderr/run;
- private runtime storage: 64 MiB/job, 128 MiB/exact pair, and 512 MiB/global;
- browser protocol: 64 requests/run with 16 KiB frames;
- downloads: 32 observed files/lease and 32 MiB/file; materialized `incoming/` is capped at 32 files and 64 MiB/run.

These bounds do **not** bound ordinary files the child writes into the Project. The persistent Chromium job profile also has no compiled byte quota and can retain cookies/cache/site data and grow between runs until an owner purges the tombstoned job. Monitor private data-disk use and treat that profile as bearer-sensitive.

## Comparative file-audio experiment

The comparative file-audio tool is disabled by default and remains absent unless all of these conditions hold: the deployment flag is enabled, a reviewed backend media/adapter/DSP composition is installed, the source is an interactive (not scheduled or replayed) session, the exact migration-seeded Wren profile is active, and the project is Standard. Profile names, lookalikes, Protected projects, scheduled jobs, stale runtimes, and old turns confer no eligibility.

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_FILE_AUDIO_EXPERIMENT_ENABLED` | `0` | `1` permits eligible runtimes to receive the experiment tool when its injected implementation is installed. The flag alone performs no provider call and creates no authority. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_PERMIT_TTL_MS` | `60000` | Process-local preview-permit lifetime, integer 1000–120000 ms. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_WREN_CAPSULE_PATH` | empty | Absolute path to the reviewed owner-private Wren capsule. The file is opened no-follow only inside a valid arm-A execute. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_WREN_CAPSULE_SHA256` | empty | Frozen lowercase SHA-256 of the exact reviewed capsule bytes. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_SHARED_TASK_PATH` | empty | Absolute path to the owner-private task shared byte-for-byte by A and B. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_SHARED_TASK_SHA256` | empty | Frozen lowercase SHA-256 of the exact shared-task bytes. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_NEUTRAL_ADAPTER_PATH` | empty | Absolute path to the owner-private neutral adapter used only by B. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_NEUTRAL_ADAPTER_SHA256` | empty | Frozen lowercase SHA-256 of the exact neutral-adapter bytes. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_RESPONSE_SCHEMA_PATH` | empty | Absolute path to the owner-private strict response schema used by A/B and the isolated synthesis adapter; it is never released to the outer session. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_RESPONSE_SCHEMA_SHA256` | empty | Frozen lowercase SHA-256 of the exact response-schema bytes. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_SOL_SYNTHESIS_PROMPT_PATH` | empty | Absolute path to the owner-private isolated-Sol synthesis developer instructions, read only after A, B, and DSP succeed. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_SOL_SYNTHESIS_PROMPT_SHA256` | empty | Frozen lowercase SHA-256 of the exact Sol-synthesis instruction bytes. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_MEDIA_TEMP_ROOT` | `WAYANG_DATA_DIR/audio-experiment/tmp` | Private disposable ffmpeg/ffprobe workspace created only during execute. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_FFMPEG_PATH` | `/usr/bin/ffmpeg` | Canonical absolute Linux ffmpeg executable used only during execute. Relative or symlinked selectors fail closed. |
| `WAYANG_FILE_AUDIO_EXPERIMENT_FFPROBE_PATH` | `/usr/bin/ffprobe` | Canonical absolute Linux ffprobe executable used only during execute. Relative or symlinked selectors fail closed. |

The built-in media executor is Linux-only and requires canonical `/usr/bin/prlimit` and `/usr/bin/bwrap`. ffmpeg/ffprobe run through a shell-free `prlimit → bwrap` chain with explicit address-space, file-size, CPU, descriptor, core-dump, and task ceilings; unshared network/PID/IPC/user namespaces; dropped capabilities; a minimal environment; read-only system runtime libraries/font data; an isolated `/tmp`; and only the exact owner-private media workspace writable. Home, general `/etc`, the project tree, Wayang data outside that workspace, host `/tmp`, and host loopback are not mounted/reachable. Custom injected test executors do not inherit this containment.

Uploads are addressed only by backend-issued attachment IDs bound to the full source session. Preview accepts only declared MP3 or RIFF/WAVE MIME types and always binds the complete A/B/C topology, exact attachment digest, current persisted browser user entry, runtime generation, project/profile, and provider/model. The tool accepts no arm-selection field. `execute` must atomically claim the short-lived permit in that exact same current user turn; it is single-use, reopens the upload no-follow with inode, size, and SHA-256 checks, structurally validates actual MP3/WAVE bytes, and sanitizes once. `revoke` also requires proof of that exact same current turn before it can cancel an unused or in-flight permit. There is no questionnaire or durable consent record, and permits do not survive runtime teardown or service restart.

All five prompt/schema paths must be absolute, owner-private, and distinct. Before either direct provider use, the Wren capsule, shared task, neutral adapter, and response schema are opened no-follow and checked against frozen hashes. A receives the Wren capsule as developer instructions. B receives the neutral adapter as developer instructions and no capsule. Both receive the exact same shared task, response schema, and sanitized audio as user content, use fixed `gpt-audio-1.5` at the official HTTPS Chat Completions endpoint with text-only output and `store: false`, and must return the strict validated direct-response object rather than free text. The key is resolved only immediately before each provider use and is never returned or logged.

Only after A and B validate does local deterministic DSP analyze the same still-hash-matching sanitized buffer. DSP produces bounded numeric text and exactly three bounded PNG artifacts for synthesis; it is not returned as the outer model's Arm C response. Two distinct cryptographically random 128-bit lowercase-hex labels blind A/B, and candidate order is randomized. After A, B, and DSP all succeed, the backend re-opens and hash-checks the Sol synthesis instructions and response schema, resolves the key immediately before use, and invokes the isolated fixed `gpt-5.6-sol` Chat Completions adapter. The adapter alone receives those private instructions/schema, the two already-validated direct responses under opaque labels, bounded DSP numeric text, and the three PNG byte artifacts. Its response must pass strict synthesis validation for arms A/B/C plus the response module's 64-character contiguous and whitespace-normalized private-prompt echo guard.

The current outer model is **not** the synthesizer. Its ordinary execute result deliberately contains the two validated direct provider outputs under opaque labels, the validated synthesis response, bounded synthesis-provider metadata, and nonbinary DSP metadata/digests. Direct provider-output release is part of the accepted experiment design. Candidate response IDs and token usage are withheld because they could become arm-mapping side channels. Before reveal the result contains no arm-to-label mapping, A/B implementation identifier, private synthesis prompt, response schema, raw audio/base64, configured host path, OpenAI key, or DSP PNG/image block. Prompt-echo checks and public-output filtering are defense-in-depth, not a blocking confidentiality claim; transformed, inferred, or deliberately fragmented output can evade them.

Preview and execute are model-callable operations. Clemente has accepted same-current-user-turn model-call consent for this experiment. The binding ensures execute cannot cross to another browser turn, attachment, session, or runtime, but it is not a separate human click or PIN approval. Deployments requiring deterministic per-run human approval need an additional UI-owned, model-inaccessible authorization step.

A successful complete execute also returns a fresh random 128-bit lowercase-hex `run_id` and retains its blind record only inside that exact live runtime. The record binds the source attachment and SHA-256, the two opaque labels, a frozen private label-to-arm mapping, creation/expiry, optional immutable score and SHA-256 commitment, and reveal state. The ledger holds at most eight records, evicts deterministically oldest-first, and expires records after 60 minutes. Runtime close/replacement and service restart clear it; there is no disk persistence or cross-runtime recovery.

The `score` operation accepts the exact `run_id`, exactly one entry for each candidate label, integer 0–4 ratings for `temporal_grounding`, `perceptual_specificity`, `structural_coherence`, `affective_usefulness`, `evidence_uncertainty_calibration`, and `source_honesty`, a 1–2000-character rationale per candidate, a preferred label or `tie`, and one `wren`/`neutral`/`unsure` condition guess per label. Up to eight 1–500-character `blind_breaks` strings are optional. Objects are exact and accessor/unknown fields fail closed. The first valid score is canonicalized in candidate order, deeply frozen, and committed as lowercase SHA-256 over its UTF-8 JSON representation without any mapping. It cannot be replaced. Scoring may happen in a later persisted browser turn while the same runtime/binding remains current.

The model must finish its blind comparison and submit `score` before calling `reveal`; tool guidance explicitly forbids inferring the mapping from labels, order, provider metadata, or implementation side channels. A successful score returns only `run_id`, `commitment`, and `reveal_ready`. Reveal accepts only the exact `run_id`, fails before score, and returns the same commitment, original preference and condition guesses, and the opaque label mapping to public conditions `bounded_wren` and `neutral_specialist`. Repeated reveal is idempotent while the record is live. Unknown, expired, evicted, stale-runtime, closed-runtime, and post-restart IDs fail closed. This is a cooperative score-before-reveal protocol with a 60-minute/process-lifetime limitation, not durable audit storage or a hard barrier against deliberate model inference.

Startup installs only inert closures. Disabled startup, preview, and invalid/stale/replayed/cross-session/cross-turn execution perform no prompt/capsule/key/file read, ffmpeg/ffprobe/DSP work, or provider transport. Sol artifacts are never read during startup or preview and no partial execution object is released after a failed stage. Enabling the experiment is a deliberate audio disclosure decision for both direct A/B providers.

## Embedded browser

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_CHROMIUM_PATH` | auto-detect | Absolute path to Chromium/Chrome. `CHROME_PATH` and `CHROMIUM_PATH` are fallback aliases. |
| `WAYANG_BROWSER_TRANSPORT` | `auto` | Viewer selection: `auto` prefers Full browser (VNC) when Xvfb/x11vnc are available; `vnc` requires them; `cdp` selects Fast page screencasting. Both viewers control the same headed Chromium when VNC support is installed. |
| `WAYANG_BITWARDEN_CLI_PATH` | auto-detect | Optional absolute path to the official `bw` executable. It is invoked from a neutral temporary cwd with exact argv, `shell: false`, and a strict environment allowlist; vault output is never returned by credential routes. |
| `WAYANG_BROWSER_CREDENTIALS_IDLE_MINUTES` | `15` | In-memory Bitwarden session-key idle timeout, integer 1–1440 minutes. |

The default ordinary-browser scope is one Wayang-wide `shared` profile under `WAYANG_DATA_DIR/browser-workbench/`. Explicit ordinary `project` and `session` API scopes remain available for isolation and tests under the project's ignored `.pi/browser-workbench/`. Protected browser persistence is always backend-issued; protected HTTP and CDP requests reject every caller-supplied persistence or scope selector. Existing project profiles are not migrated or deleted automatically, and a project registration cannot be removed while its project-local managed browser root still exists. Profiles, downloads, runtime metadata, and artifacts can contain authenticated sessions and private browsing data; do not commit, share, or include them in ordinary logs.

Interactive capability-browser downloads use Chromium GUID-named private staging. Each capability browser realm observes at most 32 downloads across runtime replacement, accepts at most 32 MiB per file, and keeps the publication directory at no more than 32 files and 64 MiB. Startup revalidates existing publications before accepting more. After completion and fresh authority validation, Wayang reopens one regular single-link staging file without following symlinks and exclusively publishes it under `<project>/.wayang/browser-downloads/` with a safe collision-resistant name. Unsafe, oversized, partial, racing, or unauthorized downloads are canceled or discarded. Published files are ordinary untrusted project files and may be inspected, moved, or deleted through normal project tools and the Files pane. Downloading bytes does not execute them; Wayang does not automatically open, import, parse, or run downloaded files.

### Guarded Bitwarden fills

With the official Bitwarden CLI installed, run this only in a local terminal while Wayang is running:

```sh
make browser-credentials-unlock
```

The helper runs interactive `bw unlock --raw`; the master password is handled by `bw`, never Wayang or chat. It sends the resulting session key to a mode-`0600` Unix socket under `WAYANG_DATA_DIR/browser-credentials/`. The backend keeps the key only in memory until idle timeout, explicit Lock, browser stop/restart/reset, or shutdown. Credential choices are short-lived, one-use, and bound to the exact current page origin and browser target. Login/TOTP values are filled directly through CDP and are never returned to browser UI/API state or the clipboard.

A successful fill stores the exact username/password/TOTP used only in backend memory, remains in user mode, and blocks all agent inspection. Sequential login and TOTP fills in the same top-level document union those known redaction values. General Resume Agent is rejected while this block exists. `POST /api/browser/credentials/allow-agent-inspection` is the explicit, one-use, UI-only action that resumes the agent in **non-screenshot, read-only text/DOM inspection** mode; every result, persisted metadata value, and agent-visible title/URL path is post-redacted against raw known values plus deterministic reversible representations: URI/component encoding with percent-hex case tolerance, URL form encoding, standard base64, and base64url. Screenshots and every agent mutation remain blocked. `pushState`, `replaceState`, hash changes, and failed/uncommitted navigation do not clear protection. Only a confirmed new CDP main-frame loader/document identity (or browser stop) resets it. The allow response is `{ allowedInspection: "text-only", screenshotsAllowed: false, mutationsAllowed: false, state: BrowserPublicState }`.

Wayang does not click a Submit control or dispatch an explicit form submit during credential fill. Sites may nevertheless react immediately to the emitted input/change events, so filling is not a guarantee that no server-side action occurs.

Credential routes require the normal Wayang UI session plus an exact non-empty allowed `Origin`; the in-process, source-session-attributed browser-agent capability is rejected. Agent browser calls carry both an opaque per-source capability and source session ID, and the backend centrally reauthorizes that source profile against the requested target project on every operation. The capability is not exported through process environment. Every credential operation, including `/api/browser/credentials/status`, uses POST intentionally because browsers do not reliably include `Origin` on same-origin GET requests. The non-empty exact-Origin requirement therefore remains enforceable without making status unreachable from the real UI. The broker is an accidental/non-exposure boundary for a trusted single OS user, not a same-user sandbox: another process running as that user may be able to inspect process memory, browser state, or CDP. An explicitly accepted limitation is that same-UID code with the normal UI session can send an untagged, exact-Origin request that is classified as UI traffic; this guarded design does not claim hard isolation from same-UID processes. Use a separate OS identity/container if strong non-readability is required. Browser automation and the broker are optional; core chat works without Chromium or `bw`.

## Text-to-speech

TTS is disabled unless a service URL is configured.

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_TTS_BROKER_URL` | empty | Preferred shared streaming/job broker base URL. |
| `WAYANG_TTS_BASE_URL` | empty | Legacy direct Chatterbox fallback URL. |
| `WAYANG_TTS_VOICE` | `Ava.mp3` | Provider voice identifier. |
| `WAYANG_TTS_MODEL` | `chatterbox-turbo` | Provider model identifier. |
| `WAYANG_TTS_FORMAT` | `mp3` | Requested audio format. |
| `WAYANG_TTS_SPEED` | `1.0` | Playback/synthesis speed. |
| `WAYANG_TTS_MAX_CHARS` | `500` | Per-request character limit. |

Treat remote TTS as a data disclosure boundary: assistant text is sent to the configured service. Keep local URLs loopback-only unless the service has its own reviewed transport security.

## Data locations

| Location | Contents |
|---|---|
| root `.env` | Private launcher configuration/API keys, mode `0600`. |
| root `.env.backup` | Immediately previous wizard configuration, mode `0600`. |
| `~/.wayang/store.json` | Persistent Wayang session metadata, capability associations, jobs and schedules, apps, and UI state. Schema 3 includes private Protected-automation job/run rows; migrations create none and confer no authority. |
| `~/.wayang/protected-automation/snapshots/` | Owner-only immutable source snapshots bound to exact Project/Profile/Job/revision identities and compiled quotas. |
| `~/.wayang/protected-automation/runtime/` | Owner-bound bounded run scratch, stdout/stderr diagnostics, and published job-state generations. |
| `~/.wayang/protected-automation/browser-realms/` | Persistent exact Project/Profile/Job Chromium profiles, download staging, and runtime metadata. Profile storage is private but not byte-quota-bounded. |
| `~/.wayang/search.db` | Search index derived from pi sessions. |
| `~/.wayang/auth-sessions.json` | Hashed built-in-login session records when enabled. |
| `~/.wayang/workspace-capability-approval/pin-attempt-state.json` | Owner-only non-secret capability approval attempt count, cooldown timestamp, and optional reservation metadata; never the PIN. Service startup creates it automatically when safely absent and preserves valid state; `make setup-capability-approval` is optional preflight/migration. |
| `~/.wayang/attachments/<full-session-id>/` | Private chat uploads for one Wayang source session (`0700` directories, `0600` files); only that session's direct path tools and sandboxed bash can read them. |
| `~/.wayang/audio-experiment/tmp/` | Disposable owner-private sanitize/DSP workspaces created only during a valid execute and removed by the media modules. |
| `~/.wayang/tts/` | Ephemeral generated TTS audio cache, private directory/files. |
| `~/.wayang/browser-workbench/` | Default shared browser profile, downloads, artifacts, and private runtime metadata. |
| `~/.wayang/browser-credentials/unlock.sock` | Ephemeral private Unix socket for local-terminal Bitwarden unlock handoff. |
| `~/.pi/agent/auth.json` | pi-managed provider credentials/OAuth state. |
| `~/.pi/agent/sessions/` | Canonical pi transcript/session JSONL. |
| `<project>/.pi/browser-workbench/` | Explicit project/session-scoped browser profiles, downloads, and artifacts. |
| `<project>/.wayang/browser-downloads/` | Successfully published bounded interactive capability-browser downloads. These are ordinary private project files and appear in the Files pane when hidden files are shown. |

`WAYANG_DATA_DIR` moves Wayang metadata, Protected-automation snapshots/runtime/browser realms, session-scoped attachments, the `tts/` cache, the shared browser workbench, and the ephemeral credential socket together. The `~/.wayang/` paths above follow the default and move under the configured absolute data root. New uploads are never written to the deprecated shared `/tmp/wayang-attachments` root, and agent tools deny that legacy root fail-closed; Wayang does not automatically migrate or inspect old files there. Back up persistent locations only into encrypted/private storage; do not back up a live unlock socket. Stopping Wayang and restoring `.env.backup` is a configuration rollback; never delete user data as a troubleshooting shortcut.

## Development frontend

Vite uses `VITE_WAYANG_BACKEND_URL` (default `http://127.0.0.1:8787`) as its development/preview HTTP and WebSocket proxy target. `make dev` normally needs no override. `VITE_WAYANG_LATENCY_PROFILE=1` enables frontend latency instrumentation for focused development/E2E work; it is not a production setting.

## Advanced diagnostic variables

The source contains performance/test tuning variables such as `WAYANG_LATENCY_PROFILE_VERBOSE`, `WAYANG_HISTORY_CACHE_FILES`, `WAYANG_HISTORY_CACHE_BYTES`, `WAYANG_SESSION_CATALOG_SCAN_MS`, `WAYANG_SESSION_CATALOG_COOLDOWN_MS`, `WAYANG_SESSION_CATALOG_WORKERS`, and `WAYANG_LEGACY_SESSION_SCAN`. They are internal diagnostics/compatibility controls, not stable v0.1 configuration API. Leave them unset unless working on the corresponding source and tests.
