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

Remote passwordless requests may use ordinary Wayang features according to the deployment network boundary, but they cannot own operation-specific PIN confirmations unless the trusted proxy identity bridge above resolves an authenticated owner. An SSH tunnel to `127.0.0.1:WAYANG_PORT` provides the loopback administration path without treating the 8-digit command-guard PIN as a network-login password.

For a single-user private LAN without an existing reverse proxy, Wayang includes an optional generated **foreground Caddy** path using built-in auth, loopback upstream, an exact HTTPS origin on an unprivileged port, forwarding-header replacement, no request logs, and Caddy's local CA. See [Local HTTPS remote administration](local-https.md). It does not install Caddy, configure DNS/CA trust, change `.env`, enter a password, or install a service.

## Pi provider authentication

Wayang uses pi 0.84.1's standard authentication and model runtime. The coding-agent package is pinned to the repository-vendored `0.84.1-wayang.4f7d03ce` artifact (SHA-256 `c82956f058b7dc09a2206c8c9f9331f2971042a4fa9597a5ee017f58d5303da9`) so session-name writers and PIN-gated transcript event mutations share the reviewed physical-file transaction, lock, atomic multi-entry CAS, stale-runtime mutation epoch, optional fixed compaction threshold, optional complete-turn retention, and incremental resume-session loading.

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

### Wayang model catalog policy

Wayang projects a curated current Together serverless chat catalog from Together's authenticated `/v1/models` endpoint. Live metadata refreshes display names, context windows, and token prices, while a reviewed local allowlist supplies conservative reasoning, modality, and output-limit capabilities. Legacy priced Together endpoints remain usable by other clients but do not clutter Wayang's picker. If the live fetch fails, the pinned pi catalog remains available only for models in the same curated allowlist.

OpenRouter models are intentionally unavailable in Wayang's picker and model-switch API. The OpenRouter credential and pi provider are not deleted, so this is reversible and does not affect other pi clients. Wayang may still consult OpenRouter's public, unauthenticated model catalog to derive current direct Anthropic identifiers; no prompt, transcript, credential, or private content is sent in that metadata-only request.

Provider/model availability is deployment-global and does not depend on Project privacy, Agent Profile resource mode, or derived Project-Agent authority. Declarative pi providers are present in every fresh per-session model context. Exact extension-backed providers admitted to Wayang's reviewed external catalog are no-follow/hash-verified, copied from the verified descriptor into private temporary storage, and loaded through a provider-only bootstrap for restricted and Standard runtimes alike. That bootstrap retains only provider registrations; it does not attach the extension's tools, hooks, commands, prompts, skills, renderers, or resource paths. After model resolution, resource-extension provider mutations are ignored for that session. Static picker listing never executes provider extension code, and project-local extensions cannot pre-populate or overwrite another session's provider registry.

Credential resolution in pi prefers a CLI override, then pi `auth.json`, then environment variables, then a custom provider key. Wayang does not accept provider keys in browser storage or URLs.

### Memory-first traditional compaction

The integration is disabled by default. It keeps one physical Pi `AgentSession` and uses repeated traditional Pi compaction; it does not create capsules, logical episodes, replacement sessions, or a second content telemetry ledger.

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_MEMORY_FIRST_ENABLED` | `0` | Master gate. Alone it enables nothing; at least one independently explicit component flag is also required. |
| `WAYANG_MEMORY_FIRST_GUIDANCE_ENABLED` | `0` | Together with the master gate, inject stable memory/compaction guidance. |
| `WAYANG_MEMORY_FIRST_REVIEW_ENABLED` | `0` | Together with the master gate, queue one memory-review continuation per traditional compaction cycle after the review threshold. |
| `WAYANG_MEMORY_FIRST_COMPACTION_CONTROLS_ENABLED` | `0` | Together with the master gate, apply compaction settings only to the runtime's in-memory `SettingsManager` snapshot. Never writes Pi settings files. |
| `WAYANG_MEMORY_FIRST_LEDGER_ENABLED` | `0` | Together with the master gate, emit bounded anonymous lifecycle aggregates on the reviewed event-bus/sink contract and leave any content ledger with its owning memory extension. |
| `WAYANG_MEMORY_FIRST_STANDARD_INTERACTIVE_ENABLED` | `0` | Admit Standard interactive sessions to explicitly enabled components. |
| `WAYANG_MEMORY_FIRST_STANDARD_SCHEDULED_ENABLED` | `0` | Independently admit Standard scheduled sessions. |
| `WAYANG_MEMORY_FIRST_PROTECTED_INTERACTIVE_ENABLED` | `0` | Independently admit Protected interactive sessions to the project-local route. |
| `WAYANG_MEMORY_FIRST_PROTECTED_SCHEDULED_ENABLED` | `0` | Independently admit Protected scheduled sessions. |
| `WAYANG_MEMORY_FIRST_SUBAGENT_ENABLED` | `0` | Independently admit runtimes explicitly classified as subagents. |
| `WAYANG_MEMORY_FIRST_REVIEW_TOKENS` | `96000` | Memory-review threshold; must be below the compaction trigger. |
| `WAYANG_MEMORY_FIRST_COMPACTION_TRIGGER_TOKENS` | `128000` | Absolute traditional-compaction target. The selected model must also provide at least 16,384 tokens of headroom. |
| `WAYANG_MEMORY_FIRST_KEEP_RECENT_TOKENS` | `20000` | Recent context tail retained by Pi compaction; must be below the review threshold. |
| `WAYANG_MEMORY_FIRST_KEEP_COMPLETE_TURNS` | `0` | Independently requests complete-turn retention through the narrow forward-compatibility field; has effect only when compaction controls are also explicit. |
| `WAYANG_MEMORY_FIRST_STANDARD_ROUTE` | `memoriki` | Fixed Standard-project durable-memory route. Other values fail configuration. |
| `WAYANG_MEMORY_FIRST_PROTECTED_ROUTE` | `project-local` | Fixed Protected-project route. Other values fail configuration. |
| `WAYANG_MEMORY_FIRST_PROTECTED_PROJECT_PATH` | `.wayang/memory.md` | Relative traversal-free durable-memory path inside the owning Protected project. |

The master, every component flag, and every cohort flag accept only `0` or `1` and default off. The policy remains inert unless at least one component and one cohort are both explicit. Standard interactive, Standard scheduled, Protected interactive, Protected scheduled, and subagent runtimes are scoped independently before prompt injection, tool registration, model validation, settings snapshots, or compaction overrides. Thresholds are independently range/order validated. When compaction controls are explicit, Wayang validates the selected model before runtime publication, creates an in-memory settings snapshot even for Standard resources, and applies `enabled`, a current-SDK `reserveTokens` fallback, and `keepRecentTokens`. Optional `triggerTokens` is isolated behind one compatibility helper; `keepCompleteTurns` is omitted unless its own flag is also explicit. Wayang-owned `/reload` waits for Pi's SDK reload, then validates the current model/config and reapplies these in-memory overrides before reporting success; reload, reapply, or validation failure destroys the runtime rather than continuing with partially refreshed or silently reverted settings. Disabling the master restores existing resource loading and settings behavior.

The inline extension factory is injected through Standard or restricted resource loaders only when guidance, review, or aggregate lifecycle reporting is explicit **and** that exact runtime's privacy/execution cohort is enabled. Standard guidance uses the Memoriki wiki only according to the active profile's memory authority. Protected guidance names only the configured project-local wiki and never suggests global/personal/cross-project memory access. Guidance distinguishes future-value short-term knowledge (active commitments, current state, near-term decisions) from selective long-term knowledge (stable facts, preferences, constraints, reusable decisions). Scheduled guidance requires a best-effort review without waiting for human input; the exported subagent seam requires a bounded handoff.

At the review threshold, `agent_end` queues a `followUp` custom reminder with `triggerTurn: true`. Because Pi emits `before_agent_start` before marking the run active, reload/high-context recovery returns the reminder directly in that pending run's `{ message }` result and never calls `sendMessage` from the pre-run hook. The enum-only `memory_review_complete` tool records only `outcome`, `short_term`, and `long_term` values in a typed extension entry—never memory content, paths, or raw identifiers. An exact repeated completion returns the canonical stored outcome without another entry/event; conflicting retries are rejected. Review completion, the enum-only queued marker, a delivered reminder, and the single threshold-deferral marker are reconstructed from the active branch after the latest compaction. A delivered reminder counts only when its strict enum details match the current privacy mode, memory route, and execution mode, so a policy transition reissues correctly specialized guidance. Manual and overflow compaction always pass through. Threshold compaction may be cancelled once to allow review: an ordinary reminder still in Pi's queue is reused as that continuation, while a delivered-but-incomplete reminder receives one retry turn. The next threshold attempt passes even when review remains blocked. No broad Wayang mutation lease is taken.

Lifecycle events contain only a fixed event type, privacy/route/execution classifications, timestamp, and optional token count/reason. They contain no session or Project identity, prompts, summaries, tool data, memory content, paths, or transcript bytes; they are capped at 64 emissions per runtime, and consumer failure never affects the session. Wayang publishes the same frozen aggregate contract on Pi's `wayang:memory-first-lifecycle:v1` event bus and through the optional exported sink; it does not persist the events itself. A reviewed mypi extension may consume that interface and remain the sole owner of any richer content ledger.

### Canonical Ruminant KV-prefix warming

This integration is disabled by default. It targets one exact authorized Standard interactive Project/Profile plus one exact provider/model routed through the configured Ruminant origin. Protected, scheduled, subagent, restricted-resource, other-project/profile, other-model, and direct-to-Narwhal requests never install the capture hook.

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_CANONICAL_KV_WARMUP_ENABLED` | `0` | Master gate. `1` requires every exact selector and private key path below. |
| `WAYANG_CANONICAL_KV_WARMUP_PROJECT_ID` | empty | Exact authorized Standard Project ID whose stable prefix may be captured. |
| `WAYANG_CANONICAL_KV_WARMUP_AGENT_PROFILE_ID` | empty | Exact enabled Agent Profile ID authorized for that Project. |
| `WAYANG_CANONICAL_KV_WARMUP_PROVIDER` | empty | Exact Pi provider ID, normally `narwhal-horn`. |
| `WAYANG_CANONICAL_KV_WARMUP_MODEL` | empty | Exact Pi model ID, normally `qwen3.8-flash-next`. |
| `WAYANG_CANONICAL_KV_WARMUP_FAMILY` | empty | Bounded opaque family label shared with Ruminant. |
| `WAYANG_CANONICAL_KV_WARMUP_RUMINANT_BASE_URL` | empty | Exact HTTP(S) Ruminant origin without `/v1`, credentials, path, query, fragment, or trailing slash. The selected model's base URL must be this origin plus `/v1`. |
| `WAYANG_CANONICAL_KV_WARMUP_API_KEY_FILE` | empty | Absolute private regular non-symlink mode-0600 file containing the Ruminant client bearer. |
| `WAYANG_CANONICAL_KV_WARMUP_POLL_MS` | `2000` | Content-free Ruminant warm-status poll/retry interval, integer 250–300000. |
| `WAYANG_CANONICAL_KV_WARMUP_STATUS_TIMEOUT_MS` | `2000` | Status request/body timeout, integer 250–30000. |
| `WAYANG_CANONICAL_KV_WARMUP_REQUEST_TIMEOUT_MS` | `180000` | End-to-end warm request/response timeout, integer 1000–600000. |
| `WAYANG_CANONICAL_KV_WARMUP_MAX_TEMPLATE_BYTES` | `8388608` | Maximum sanitized in-memory template, integer 1024–33554432. |

The final hidden inline provider hook sees the payload only after ordinary extension payload handlers. It creates a new positive-field template containing contiguous leading `system`/`developer` messages, exact tool schemas, selected chat-template fields, and one fixed public synthetic user message. It drops every real user, assistant, tool-result, session/account metadata, cache key, and conversation-history message. The copy is forced to non-streaming, one output token, and `tool_choice=none`; the original foreground payload is not changed. A SHA-256 bundle identifier and family label are the only metadata added to later canonical Ruminant requests, and Ruminant consumes rather than forwards them.

The template is process-memory-only in the initial implementation. It is not written to Wayang's database, Pi JSONL, search index, browser state, logs, or Ruminant's durable queue. After a simultaneous Wayang/template loss and cold model cache, the first eligible foreground request remains cold but reseeds the template; later Narwhal or Ruminant generations can then be restored while Wayang remains running. Persisting the derived rendered template is not implied by enabling this gate and requires a separate privacy/reliability decision.

The controller never creates an AgentSession and never owns a tool dispatcher. It sends the sanitized payload directly to Ruminant's authenticated internal warm endpoint, where foreground traffic revokes the idle lease before dispatch. Polling, capture rejection, Ruminant outage, timeout, or warm failure cannot block ordinary session creation or provider calls. Disable and restart Wayang to stop capture/tagging/network work; disable the matching Ruminant gate separately to remove the warm endpoint. No llama.cpp service change or cache-file deletion is required.

### Automatic Terra session titles

Automatic titles are disabled unless explicitly enabled:

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_AUTO_SESSION_TITLE` | `off` | Exact value `on` enables one-time automatic naming as soon as the first eligible browser message is physically accepted into Pi. |
| `WAYANG_AUTO_SESSION_TITLE_PROTECTED` | `off` | Exact value `on`, together with the general flag, permits the same disclosure for eligible Protected Projects. |

The fixed model is `openai-codex/gpt-5.6-terra`; there is no provider fallback. The immediate request contains only deterministically bounded raw browser text from the first physically persisted user message, captured before Wayang goal/attachment decoration; it does not wait for assistant settlement. If that attempt fails, a later eligible browser interaction may retry using bounded prose from the first one to three completed exchanges, including assistant text blocks. Wayang does not inject tools, tool results, reasoning, images, attachment metadata/bytes, host paths, project files, profile/system instructions, later-turn prose, or source-session IDs. Conversation prose can itself contain sensitive facts, paths, or credentials written by the human or repeated by the assistant. Enabling either scope authorizes disclosure of that prose to the provider; the Protected flag is a separate explicit decision.

Generation runs on a deferred task and does not delay source-message admission. Rejected, unpersisted, cancelled-before-start, attachment-only, non-browser, scheduled, connector/headless, subagent, interview-continuation, resend, and ambiguous decorated legacy turns cannot become first-message title provenance. Before disclosure and commit, Wayang requires either the exact live accepted-turn ledger entry or its exact marker in a freshly reopened physical transcript, then rechecks Project/Profile/privacy policy and the canonical Pi name revision. A later eligible interaction may retry a failed attempt, but cannot replace the physical first user message as title provenance. Human titles and deliberate clears use the shared Pi lock and win races. Disable promptly by setting the flags to `off` and restarting through the normal reviewed deployment procedure; already persisted titles are not removed or regenerated.

The session-row **Generate title** action uses the same configured Terra disclosure scope and is unavailable when the corresponding flag is off. After confirmation, it may replace any existing title using bounded prose from the first one to three completed active-branch exchanges. A request made while the session is busy is queued in backend memory, survives browser navigation/disconnect, and runs once the session is idle; it is intentionally lost on a Wayang restart. A newer manual or physical Pi rename wins instead of being overwritten. Archive, delete, or manual rename cancels pending work.

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

Pi authentication state, trust decisions, Protected/unclassified session JSONL, and Protected/unclassified chat attachments are private. Exact catalogued Standard-session JSONL and attachments are intentionally cross-session readable through bounded `session_*` tools or exact-file `read`, regardless of target Project agent allowlists; all cross-session writes and broad Pi/Wayang storage scans remain denied. New uploads live under owner-private `WAYANG_DATA_DIR/attachments/<full-session-id>/` directories, and the deprecated shared `/tmp/wayang-attachments` root always remains denied. Do not point test runs at a real Pi or Wayang data directory.

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

## Project-derived runtime authority

Wayang has no per-pair capability association or activation policy. Runtime authority is derived directly from the current registered Project, stable Agent Profile, profile enabled state, and Project allowlist:

- Every enabled profile allowed by a **Standard** Project receives reviewed global Pi resources, Standard browser control, and same-user host execution.
- Every enabled profile explicitly allowlisted by a **Protected** Project receives its isolated Protected browser and deterministic Protected automation.
- Provider/model, profile names, prompts, and legacy capability rows/history are not authority inputs.

A null Standard allowlist permits every enabled profile. Protected Projects require a nonempty explicit allowlist. Privacy changes, profile disable, allowlist exclusion, and Project/Profile deletion remove derived authority at current-state checks and rebuild affected runtimes through the normal runtime-impact lifecycle. There is no individual grant/revoke UI or PIN flow.

These powers are cooperative same-UID authority, not containment. Standard host execution may reach files, processes, credentials, memory stores, Protected backing paths, and network services available to the Wayang account. Browser authority may disclose page content or make consequential account changes. Human-only login, MFA, CAPTCHA, payment, credential entry, and other operation-specific confirmation flows remain separate.

The internal selectors `wayang.standard-resources.v1`, `wayang.standard-browser.v1`, `wayang.host-execution.v1`, `wayang.protected-browser.v1`, and `wayang.protected-automation.v1` remain implementation identifiers only. Legacy association and approval-history rows are inert rollback data and are ignored by the resolver.

Protected Scheduled Agent Jobs remain a separate model-driven path. They require a persisted non-null exact profile allowed by the Protected project and are reauthorized at create/update, manual/timer dispatch, and immediately before Pi runtime creation. Their session transcripts/attachments retain Protected classification; global body indexing, legacy whole-transcript scanning, shared assistant result summaries/raw failure details, and scheduled memory mutation remain denied. Output is written inside the Protected project and opened through the linked Protected session.

The existing command-guard identity PIN remains external and is used only by operation-specific confirmation paths such as transcript mutation, external actions, and Protected-automation purge. The legacy-named owner-only cooldown file under `workspace-capability-approval/` is shared confirmation plumbing, not Project-Agent authority.

## Protected projects and bash sandboxing

Eligible Standard Project-Agent pairs derive `wayang.host-execution.v1` and use same-user host execution. Protected pairs do not derive host execution, so Wayang replaces Pi's local bash backend there with a fresh per-execution `@anthropic-ai/sandbox-runtime` helper. On Linux this requires `bwrap`, `socat`, and `rg` plus x64/arm64 seccomp support; on macOS it requires the system `sandbox-exec`. `make doctor` reports sandbox prerequisite readiness; it does not manage Project-derived authority. If the required boundary is unsupported or degraded, Wayang removes sandboxed bash from the session rather than falling back to shell-command inspection.

Protected automation does not reuse this interactive bash sandbox. Sandbox-runtime 0.0.65 is a recorded **NO-GO** because it requires shell/`socat` setup and broader compatibility writes. The completed automation runner is a separate shell-free direct-Bubblewrap path on Linux: an immutable Node snapshot and exact Node ELF startup closure, structured argv, no shell/general host executable view, blocked Unix sockets, an unshared network namespace with no child TCP/UDP delivery, bounded supervision, and no fallback. It deliberately mounts the whole authorized Protected Project writable at `/workspace`, plus bounded run and persistent-state roots. Same-UID interference remains possible, and writes completed or racing before revocation cannot be rolled back. macOS Protected automation is unavailable.

Browser-enabled jobs use an inherited bounded framed RPC to a backend-owned persistent job realm, not child networking, raw CDP, or a profile mount. Exact HTTPS origins constrain top-level documents and completed download sources. The backend intercepts top-level Document requests and rejects cross-origin redirect chains, but it deliberately continues iframe and subresource traffic required by the page; the configured origin list is therefore not a complete browser network/DLP allowlist.

Standard profiles use same-user host execution, so the filesystem sandbox described below does not constrain their shell commands. Participating direct tools still apply their own live path and Project policy checks, but host execution can reach ordinary and Protected backing paths available to the Wayang account. A restricted profile running inside its authorized Protected project instead uses sandboxed bash: it may read ordinary/unregistered host paths and Standard projects, including Standard projects whose run allowlist excludes that profile, but it can persist writes only inside its own Protected project. Restricted direct tools and sandboxed bash cannot mutate project-local `.pi` control-plane files. Every other Protected project and protected backing artifact remains read/write masked. A profile switch receives the target policy only after its durable transition completes.

For Protected runtimes, the sandbox masks every other registered Protected project, all Pi session storage and `WAYANG_DATA_DIR` except the source session's existing read-only attachment allowance, the Wayang checkout's `.env`/`.env.backup`, the legacy `/tmp/wayang-attachments` root, browser-workbench roots, and the command-guard identity PIN. Sandboxed bash receives no cross-session artifact exception. A Protected runtime may read Standard projects despite their run allowlists, while its allow-only write policy confines persistence to its own project. It enforces profile memory mode and passes only non-secret process mechanics such as `PATH`, locale, home, shell, terminal, and temporary-directory metadata; provider keys, OAuth/AWS credentials, proxy credentials, loader hooks, and arbitrary deployment variables are not forwarded. Direct path tools separately use live canonical-path authorization: exact catalogued Standard transcripts and regular Standard attachment files may be opened read-only regardless of target Project allowlists; Protected/quarantined/unknown artifacts, writes, and broad `grep`/`find`/`ls` scans remain denied. The exact source session's own attachment subtree retains its existing read behavior. Participating tools deny the Wayang launcher configuration, documented project secret files, Pi auth/config files, managed browser profiles, and `/proc`, `/sys`, and `/dev` control roots; Standard host-execution commands are broader and must not be treated as constrained by those tool-level path rules.

On Linux, sandboxed bash intentionally retains the host network namespace. Commands may use raw TCP/UDP sockets, public Internet, loopback, LAN and VPN services, non-proxy-aware protocols such as IMAP, and local listeners available to the Wayang OS user. SRT 0.0.65 has no typed host-network switch, so Wayang uses an exact-version compatibility path and verifies each wrapped command contains neither `--unshare-net` nor proxy settings before execution; drift fails that command closed. macOS retains proxy-mediated egress because disabling its network profile would also reopen ordinary Unix sockets; a supported filesystem-only host-network implementation is required before parity. The strict child environment still withholds ambient provider keys, OAuth/AWS credentials, proxy credentials, loader hooks, and arbitrary deployment variables. Unix-domain sockets remain blocked except for exact eligible Wren Standard-project compatibility, so host networking does not by itself expose the user bus, Docker socket, or other Unix IPC. Project policy constrains participating tools, filesystem writes, Protected-root visibility, memory, and connector credentials; it is not network isolation or data-loss prevention against deliberate disclosure to a reachable service. These controls are not isolation from arbitrary same-UID processes or trusted extension code already executing inside the backend.

## Restricted-profile MCP grants

Wayang can install a backend-owned, source-session-bound `mcp` proxy in an eligible restricted runtime when `WAYANG_RESTRICTED_MCP_CONFIG_PATH` points to a reviewed private grant file. This is not Pi's global `pi-mcp-adapter`: it does not merge global or project MCP configuration, load extension factories, expose direct tools, or inherit future servers automatically.

| Variable | Default | Meaning |
|---|---:|---|
| `WAYANG_RESTRICTED_MCP_CONFIG_PATH` | empty | Absolute path to an owner-only mode-`0600` JSON policy containing exact profile/project bindings, reviewed launcher paths, and positive server/tool allowlists. The file must not contain credential values. |

The current compiled ceiling recognizes only reviewed `exasearch`, `mempalace`, and `public-readonly` aliases. A private grant may narrow that ceiling but cannot add servers or tools. The proxy revalidates its source session, runtime generation, current profile/project authorization, private grant, exact backend-issued tool object, and underlying MCP tool name before dispatch. Interactive and scheduled sessions may use the same exact Project–Agent grant; scheduled access additionally requires complete backend-issued job/run identity. Subagents, non-Protected projects, memory-write profiles, Report Publisher, global/project MCP configs, auth/UI/resources/sampling/elicitation, regex search, and unreviewed future tools fail closed.

MCP children run lazily with exact reviewed launchers, `shell:false`, a fixed working directory, a strict environment allowlist, discarded stderr, bounded JSON-RPC framing, timeouts, and teardown on revocation/session close. Launchers must use `exec`, fixed absolute binaries/modules/credential paths, and private isolated homes where needed. Credentials are loaded only inside those child launchers and never placed in the JSON grant. Public and MemPalace results are bounded; oversized protected results may be stored as private artifacts under the authorized project rather than shared temporary storage.

Changing this path or its grant affects only eligible restricted runtimes. Grant removal/tightening blocks calls immediately; use a fresh runtime after adding or widening a grant. The policy is not isolation from arbitrary same-UID processes or deliberate network access through sandboxed bash; authenticate sensitive local services when that boundary matters.

## Protected automation runtime and storage

There are no stable environment variables that enable, weaken, or configure Protected automation. Deploying a build that changes the automation runtime requires a normal service restart. Every enabled profile explicitly allowlisted by a Protected Project derives automation authority automatically; there is no pair activation or PIN step. Operation-specific human confirmation remains required for preparation handoff, login/MFA/CAPTCHA, and destructive purge.

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
| `WAYANG_STANDARD_BROWSER_PROFILE_HOSTS` | `0` | Startup-immutable integration gate. Accepts only unset/`0` or `1`. When `1`, production requires the complete schema-6 named-profile host, exact session-workspace tools, authenticated owner routes, and viewer composition before listening; custom/incomplete app composition still fails closed. Leave `0` until the schema-6 migration and deployment are separately reviewed. |
| `WAYANG_CHROMIUM_PATH` | auto-detect | Absolute path to Chromium/Chrome. `CHROME_PATH` and `CHROMIUM_PATH` are fallback aliases. |
| `WAYANG_BROWSER_TRANSPORT` | `auto` | Viewer selection: `auto` prefers Full browser (VNC) when Xvfb/x11vnc are available; `vnc` requires them; `cdp` selects Fast page screencasting. Both viewers control the same headed Chromium when VNC support is installed. |
| `WAYANG_BITWARDEN_CLI_PATH` | auto-detect | Optional absolute path to the official `bw` executable. It is invoked from a neutral temporary cwd with exact argv, `shell: false`, and a strict environment allowlist; vault output is never returned by credential routes. |
| `WAYANG_BROWSER_CREDENTIALS_IDLE_MINUTES` | `15` | In-memory Bitwarden session-key idle timeout, integer 1–1440 minutes. |

`auto` is the standard deployment setting. Leave `WAYANG_BROWSER_TRANSPORT` unset or set it explicitly to `auto`; use `cdp` only as an intentional Fast-page override or rollback. On Linux, `auto` selects Full browser when executable Xvfb and x11vnc dependencies are present. macOS and Linux hosts without both dependencies select the CDP fallback. An explicit `vnc` requirement fails before Wayang listens when those dependencies are unavailable. Startup reports only the requested transport, selected transport, Full-browser selection, and Chromium resolution class—never executable paths or environment values. Existing systemd deployments can use the transport-only reference `deploy/60-browser-transport.auto.conf`; see the supervised-deployment migration in [Installation](installation.md#normalize-an-existing-supervised-browser-deployment).

The default ordinary-browser scope is one Wayang-wide `shared` profile under `WAYANG_DATA_DIR/browser-workbench/`. Explicit ordinary `project` and `session` API scopes remain available for isolation and tests under the project's ignored `.pi/browser-workbench/`. Protected browser persistence is always backend-issued; protected HTTP and CDP requests reject every caller-supplied persistence or scope selector. Existing project profiles are not migrated or deleted automatically, and a project registration cannot be removed while its project-local managed browser root still exists. Profiles, downloads, runtime metadata, and artifacts can contain authenticated sessions and private browsing data; do not commit, share, or include them in ordinary logs.

Named Standard Full browser provides an explicit human-only **Paste text** control while the agent is paused. The user must first click the destination field in the Full-browser canvas. Clipboard text is bounded, read from an uncontrolled capture target or a user-initiated Clipboard API request, cleared immediately, and sent once through the authenticated RFB viewer before one remote Ctrl+V chord. A one-shot capture generation invalidates duplicate paste/input events, concurrent Clipboard API reads, disconnects, cancel, and control-mode changes. The value is not sent through an HTTP route, agent tool, model context, operational log, persisted browser metadata, React state, or browser storage. Clipboard permission denial leaves a clear manual Ctrl+V/middle-click fallback. Paste never changes browser control mode or clears credential-fill inspection protection.

RFB paste necessarily places the value on the remote profile-wide X/VNC clipboard before issuing Ctrl+V; that remote clipboard may retain it according to x11vnc and application behavior. “Not stored by the Wayang UI” does not mean the remote clipboard is erased. Full browser remains the existing cooperative owner viewer: the explicit button is unavailable in the UI during agent control, but it is not a new authorization boundary against an authenticated owner or same-UID process capable of sending ordinary native RFB input.

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

## Transcript background maintenance

Automatic session-search backfill and changed-session indexing are enabled by default. Set `WAYANG_SEARCH_BACKGROUND_INDEXING=0` only as a reversible maintenance measure when background indexing is harming service availability. After a restart, existing `search.db` results remain readable, but new or changed transcripts are not indexed automatically and search health reports the paused state. The policy-projection heartbeat remains active without scanning transcript files; actual policy changes still purge denied entries, and query-time authorization continues filtering stale entries fail-closed. Explicit authenticated manual reindex requests remain available.

Automatic discovery and metadata refresh for externally created or changed Pi sessions are also enabled by default. Set `WAYANG_SESSION_CATALOG_BACKGROUND_SYNC=0` to pause the startup scan, filesystem-watch/safety scans, and request-triggered background scans. Existing Wayang catalog rows and Wayang-created sessions remain available, but external Pi/TUI session changes remain stale until an authenticated `POST /api/sessions/import` is requested or the pause is removed. One-shot manual import does not install watchers while paused. `GET /api/sessions/catalog/health` reports the effective mode, scan state, watcher count, last completion, and a fixed bounded error code. Remove either override and restart Wayang to resume its corresponding background work; neither switch changes canonical Pi transcripts. Canonical-mutation recovery still runs before these background services and is not disabled by either maintenance switch.

## Data locations

| Location | Contents |
|---|---|
| root `.env` | Private launcher configuration/API keys, mode `0600`. |
| root `.env.backup` | Immediately previous wizard configuration, mode `0600`. |
| `~/.wayang/store.json` | Persistent Wayang session metadata, jobs and schedules, apps, UI state, and inert legacy capability rows/history retained for rollback compatibility. Runtime authority ignores those legacy rows. |
| `~/.wayang/protected-automation/snapshots/` | Owner-only immutable source snapshots bound to exact Project/Profile/Job/revision identities and compiled quotas. |
| `~/.wayang/protected-automation/runtime/` | Owner-bound bounded run scratch, stdout/stderr diagnostics, and published job-state generations. |
| `~/.wayang/protected-automation/browser-realms/` | Persistent exact Project/Profile/Job Chromium profiles, download staging, and runtime metadata. Profile storage is private but not byte-quota-bounded. |
| `~/.wayang/search.db` | Search index derived from pi sessions. |
| `~/.wayang/transcript-index.db` | Private, rebuildable content-free topology/source-offset index used for branch-aware transcript windows. Canonical transcript content remains in Pi JSONL. |
| `~/.wayang/auth-sessions.json` | Hashed built-in-login session records when enabled. |
| `~/.wayang/workspace-capability-approval/pin-attempt-state.json` | Legacy-named owner-only non-secret attempt/cooldown state shared by remaining operation-specific PIN confirmations; never the PIN. |
| `~/.wayang/attachments/<full-session-id>/` | Owner-private chat uploads (`0700` directories, `0600` files). Exact files from catalogued Standard sessions are cross-session readable through bounded tools/direct `read`; Protected/unclassified subtrees remain private and all writes remain denied. |
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
