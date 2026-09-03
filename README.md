# Wayang

Wayang is a browser-based, chat-first workbench for the [pi coding-agent harness](https://github.com/earendil-works/pi-mono). It brings agent sessions, projects, session artifacts, models, scheduled work, project-local apps, and an optional managed browser into one interface.

**Status:** v0.1 is early-stage software for one trusted user. Linux and macOS source checkouts are supported.

## Why “Wayang”?

Wayang takes its name from Indonesia's [wayang puppet-theatre traditions](https://ich.unesco.org/en/RL/wayang-puppet-theatre-00063). A performance is guided by a *dalang*, who brings figures, voices, and story together for an audience. The name is an analogy for this workbench: it gives one human a visible place to coordinate agents, tools, projects, and long-running work while keeping the machinery inspectable.

The project borrows the name with respect; it is not an attempt to reproduce or represent those living traditions.

## Security first

> **Wayang controls a powerful local agent. It can expose project files, command execution, browser profiles, provider access, and transcripts. Project allowlist/protected-mode guards and per-exec filesystem sandboxing are targeted controls, not a general same-user or network sandbox. On Linux, sandboxed bash retains the host network namespace with unrestricted TCP/UDP reachability and local binding; macOS retains proxy-mediated egress until a filesystem-only host-network sandbox is supported. Protected mode is not a network-isolation or data-loss-prevention boundary. Every enabled profile allowed by a Standard project receives global Pi resources, Standard browser control, and same-user host execution; every enabled profile explicitly allowlisted by a Protected project receives its isolated browser and deterministic automation. These privacy/RBAC-derived powers are broad cooperative authority of the Wayang OS user, not containment. Wayang is not safe for mutually untrusted users or public Internet exposure.**

Wayang binds to `127.0.0.1:8787` by default. Keep that default, or place the entire service behind a trusted VPN and/or an HTTPS authenticated reverse proxy. Optional built-in authentication provides one shared instance password; it does not create users, roles, or OS-user isolation. A reverse proxy must protect every HTTP and WebSocket path.

Read [SECURITY.md](SECURITY.md) before changing the bind address or exposing Wayang remotely.

## Features

- pi SDK chat with persistent project/session navigation and model selection
- editable Projects with reusable, deployment-defined Agent Profiles
- project defaults, agent allowlists, memory modes, in-session agent switching, and Protected privacy policy
- session-scoped Artifacts with deliberate agent presentation, completed-upload discovery, safe previews, and bounded original-byte downloads
- guarded Project/Profile settings and root `AGENTS.md` editing without a global host filesystem browser
- scheduled agent jobs, session history search, and PIN-gated canonical transcript event editing/deletion
- project-local apps rendered in an Apps pane
- optional Chromium browser workbench with capability-gated backend-owned interactive agent tools
- optional text-to-speech integration
- optional shared-password login using an HttpOnly session cookie
- optional foreground Caddy local-HTTPS path for authenticated non-localhost administration
- responsive desktop and mobile web UI
- Android companion app (`mobile/`, React Native): native session list, streaming chat, approvals/interviews/sudo surfaces, offline transcript cache, and a WebView fallback for the full web UI — see `docs/mobile-app.md` and `mobile/README.md`

Some agent-side conveniences, such as tools that create or focus apps, require optional pi extensions. Core chat and the web UI do not require a global pi installation; the checkout includes pi through the backend dependency.

## Requirements

- Linux or macOS
- Node.js `>=22.19.0` and npm; `.nvmrc` selects the preferred Node 26.4.0 runtime
- Git and Make
- pi OAuth subscription login or a supported provider API key
- Python 3 and a C/C++ toolchain if a native dependency cannot use a prebuilt binary
- optional: Chromium/Chrome for the browser workbench

## Quick start

```sh
git clone https://github.com/cuevasclemente/wayang.git
cd wayang
make doctor
make bootstrap
make start
```

Open <http://127.0.0.1:8787>. `make bootstrap` performs deterministic installs and builds, then hands secret entry and OAuth login to you in the local terminal. It never runs `sudo`, installs system packages, or creates a service.

Detailed platform and troubleshooting notes are in [docs/installation.md](docs/installation.md). Coding agents should follow [docs/agent-install.md](docs/agent-install.md).

## Authentication and configuration

For pi provider access, choose one of these supported human-local flows:

- **Subscription OAuth:** `make pi-login`, then run `/login` inside pi.
- **Provider API key:** run `make configure` and enter it at the hidden prompt.

OAuth state remains in pi's private `~/.pi/agent/auth.json`. API keys entered through the wizard are stored in the checkout's ignored `.env`, written atomically with mode `0600`. Wayang treats registered project folders as trusted Pi projects and may load their `.pi/settings.json`, packages, and extensions as the host user. Register only projects whose local Pi code you trust. Never paste credentials into issues or agent chat.

The same wizard can enable Wayang's optional shared-password login. It stores a salted scrypt hash and a random session secret, never the password. Project privacy, profile enabled state, and project allowlists directly derive runtime authority: every enabled profile allowed by a Standard project receives global Pi resources, Standard browser control, and host execution; every enabled profile allowlisted by a Protected project receives its isolated browser and deterministic automation. Provider/model are fluid runtime choices and never confer or narrow that authority. Human-only credential entry and operation-specific PIN confirmations remain separate. See [docs/configuration.md](docs/configuration.md) for the complete environment contract, HTTPS/cookie behavior, data paths, browser setup, TTS, and reverse-proxy requirements, and [docs/agents-and-project-settings.md](docs/agents-and-project-settings.md) for the privacy/RBAC model. No global browser-control extension is required.

### Protected automation milestone status

Milestones 0–5 of the deterministic Protected-automation implementation are complete. Every enabled profile allowlisted by a Protected project derives this authority directly from Project privacy/RBAC; no per-pair activation exists. Deterministic automation jobs and schedules persist in the service store across service restarts and host reboots. Model-driven Scheduled Agent Jobs may run in Protected projects only with a persisted non-null exact allowed Agent Profile; their linked sessions retain Protected transcript/output isolation, scheduled memory mutation is denied, and shared session/run projections remain content-free.

The completed Linux-only path runs immutable Node snapshots without Pi, a provider/model, an agent session, or generic child networking. Wayang owns host-local scheduling and recovery, bounded browser RPC/downloads, human credential preparation, status/attention, emergency pause/cancel, and PIN-confirmed purge. The child can write the whole authorized Project, and browser actions can affect authenticated sites at configured exact HTTPS top-level origins; these are cooperative same-user controls, not hostile-code containment. Top-level document requests are intercepted, but required iframe and subresource traffic is not destination-allowlisted. Private snapshots, state, diagnostics, incoming downloads, and histories are bounded; the persistent Chromium profile is not and can grow until explicitly purged. Linux direct Bubblewrap is the supported runner, sandbox-runtime is a recorded NO-GO for this boundary, and macOS Protected automation is unavailable. Implementation and tests used synthetic data only—no private project data, real credentials, or live website workflow. Focused/build gates passed, E2E passed 7/7, and `make test` remains 467/470 because of three pre-existing Chromium-start failures in the sandboxed harness.

## Common commands

```text
make                 Show help; does not change the machine
make doctor          Check prerequisites and configuration metadata only
make bootstrap       Install, build, configure, and smoke-test
make install         Run npm ci in backend, frontend, and e2e
make configure       Update private configuration interactively
make local-https-check  Validate optional Caddy HTTPS proxy settings
make local-https     Run optional Caddy HTTPS proxy in the foreground
make setup-owner-pin-confirmations  Optional shared owner-PIN cooldown preflight
make pi-login        Open the checkout's pi CLI for /login
make build           Build backend and frontend
make start           Build and run production in the foreground
make dev             Run backend and frontend development servers
make test            Run unit tests, lint, builds, and script tests
make test-e2e        Run isolated Playwright tests
make check           Run the release unit/lint/build gate
```

No daemon or machine-wide installer is shipped in v0.1. Use a terminal multiplexer or a process manager you understand if foreground operation is not suitable.

## Architecture

```text
Browser
  │ HTTP + WebSocket
  ▼
Express/WS backend (backend/)
  ├── pi SDK agent sessions and provider auth
  ├── project/session/artifact/job/app APIs
  ├── optional browser and TTS bridges
  └── production static assets
             ▲
             │ built by Vite
       React frontend (frontend/)
```

The development frontend runs on port 5173 and proxies `/api`, `/ws`, and `/healthz` to the backend. Production serves `frontend/dist` from the backend on one origin.

## Private data and backups

By default Wayang metadata, private per-session chat attachments, and the shared browser workbench profile are under `~/.wayang/`, while pi configuration and transcripts are under `~/.pi/agent/`. Explicit isolated browser scopes may still live inside a project at `.pi/browser-workbench/`. Project files remain in their original locations. These paths can contain sensitive content; protect backups and do not publish them.

See [docs/configuration.md](docs/configuration.md#data-locations) for exact files and overrides.

## Development and support

- Installation: [docs/installation.md](docs/installation.md)
- Configuration: [docs/configuration.md](docs/configuration.md)
- Local HTTPS remote administration: [docs/local-https.md](docs/local-https.md)
- Agent-assisted installation: [docs/agent-install.md](docs/agent-install.md)
- Projects and agent profiles: [docs/agents-and-project-settings.md](docs/agents-and-project-settings.md)
- Project-local apps: [docs/apps-framework.md](docs/apps-framework.md)
- Session search: [docs/session-history-search.md](docs/session-history-search.md)
- Long-session transcript pagination: [docs/session-transcript-pagination.md](docs/session-transcript-pagination.md)
- Transcript event editing/deletion: [docs/transcript-event-mutations.md](docs/transcript-event-mutations.md)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Vulnerability reporting: [SECURITY.md](SECURITY.md)

Copyright 2026 Wayang contributors. Licensed under the [Mozilla Public License 2.0](LICENSE).
