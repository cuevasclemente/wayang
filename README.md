# Wayang

Wayang is a browser-based, chat-first workbench for the [pi coding-agent harness](https://github.com/earendil-works/pi-mono). It brings agent sessions, projects, files, models, scheduled work, project-local apps, and an optional managed browser into one interface.

**Status:** v0.1 is early-stage software for one trusted user. Linux and macOS source checkouts are supported.

## Security first

> **Wayang controls a powerful local agent. It can expose project files, command execution, browser profiles, provider access, and transcripts. It is not a sandbox and is not safe for mutually untrusted users or public Internet exposure.**

Wayang binds to `127.0.0.1:8787` by default. Keep that default, or place the entire service behind a trusted VPN and/or an HTTPS authenticated reverse proxy. Optional built-in authentication provides one shared instance password; it does not create users, roles, project isolation, or an agent sandbox. A reverse proxy must protect every HTTP and WebSocket path.

Read [SECURITY.md](SECURITY.md) before changing the bind address or exposing Wayang remotely.

## Features

- pi SDK chat with persistent project/session navigation and model selection
- project file browsing and editing surfaces
- scheduled agent jobs and session history search
- project-local apps rendered in an Apps pane
- optional Chromium browser workbench
- optional text-to-speech integration
- optional shared-password login using an HttpOnly session cookie
- responsive desktop and mobile web UI

Some agent-side conveniences, such as tools that create or focus apps, require optional pi extensions. Core chat and the web UI do not require a global pi installation; the checkout includes pi through the backend dependency.

## Requirements

- Linux or macOS
- Node.js `>=22.19.0` and npm
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

OAuth state remains in pi's private `~/.pi/agent/auth.json`. API keys entered through the wizard are stored in the checkout's ignored `.env`, written atomically with mode `0600`. Pi 0.80.6 also requires an explicit saved trust decision before Wayang loads executable or configuration-bearing project `.pi` resources. Never paste credentials into issues or agent chat, and never approve an unreviewed project merely to enable its extensions.

The same wizard can enable Wayang's optional shared-password login. It stores a salted scrypt hash and a random session secret, never the password. See [docs/configuration.md](docs/configuration.md) for the complete environment contract, HTTPS/cookie behavior, data paths, browser setup, TTS, and reverse-proxy requirements.

## Common commands

```text
make                 Show help; does not change the machine
make doctor          Check prerequisites and configuration metadata only
make bootstrap       Install, build, configure, and smoke-test
make install         Run npm ci in backend, frontend, and e2e
make configure       Update private configuration interactively
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
  ├── project/session/file/job/app APIs
  ├── optional browser and TTS bridges
  └── production static assets
             ▲
             │ built by Vite
       React frontend (frontend/)
```

The development frontend runs on port 5173 and proxies `/api`, `/ws`, and `/healthz` to the backend. Production serves `frontend/dist` from the backend on one origin.

## Private data and backups

By default Wayang metadata is under `~/.wayang/`, pi configuration and transcripts are under `~/.pi/agent/`, and browser workbench profiles live inside each project at `.pi/browser-workbench/`. Project files remain in their original locations. These paths can contain sensitive content; protect backups and do not publish them.

See [docs/configuration.md](docs/configuration.md#data-locations) for exact files and overrides.

## Development and support

- Installation: [docs/installation.md](docs/installation.md)
- Configuration: [docs/configuration.md](docs/configuration.md)
- Agent-assisted installation: [docs/agent-install.md](docs/agent-install.md)
- Project-local apps: [docs/apps-framework.md](docs/apps-framework.md)
- Session search: [docs/session-history-search.md](docs/session-history-search.md)
- Contributions: [CONTRIBUTING.md](CONTRIBUTING.md)
- Vulnerability reporting: [SECURITY.md](SECURITY.md)

Copyright 2026 Wayang contributors. Licensed under the [Mozilla Public License 2.0](LICENSE).
