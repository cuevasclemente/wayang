# Installing Wayang from source

Wayang v0.1 supports source checkouts on Linux and macOS. It does not install a system service, write outside the checkout and user data directories, or require root access.

## Prerequisites

Required:

- Node.js `>=22.19.0`; `.nvmrc` selects the preferred Node 26.4.0 runtime, while CI covers Node 22.19.0 and 26.4.0
- npm supplied with Node
- Git
- Make (GNU Make or the common BSD Make interface used by this project)
- a local terminal for OAuth, API-key, and optional password entry

`better-sqlite3` normally uses a prebuilt binary on supported Node/platform combinations. If it must compile, install Python 3, Make, and a C/C++ compiler using your operating system's normal package-management documentation. On macOS, `xcode-select --install` installs Apple's command-line build tools. The Wayang scripts only report missing prerequisites; they do not run `sudo` or a package manager.

Optional:

- Chromium or Google Chrome for the embedded browser workbench
- Playwright's Chromium build for E2E tests (`make install-e2e-browser`)
- Xvfb and x11vnc on Linux for the VNC browser transport; CDP mode is the portable fallback
- Caddy for the optional foreground local-HTTPS remote-administration path; Wayang never installs it

## Automated interactive bootstrap

```sh
git clone https://github.com/cuevasclemente/wayang.git
cd wayang
make doctor
make bootstrap
```

Before making changes, inspect the bootstrap plan without installing or reading configuration:

```sh
sh scripts/bootstrap.sh --dry-run
node scripts/configure.mjs --dry-run
```

The bootstrap performs this sequence. Capability-approval attempt/cooldown state is runtime data, not setup or build-time configuration; the deployed service creates it automatically with owner-only permissions when missing:

1. verifies Linux/macOS, Node, npm, Git, Make, and native-build readiness;
2. runs `npm ci` in `backend/`, `frontend/`, and `e2e/` using committed lockfiles;
3. builds both applications;
4. hands pi and Wayang secret configuration to you in the local terminal;
5. writes `.env` atomically with mode `0600` while preserving unknown keys;
6. runs `make doctor` and an isolated production `/healthz` smoke test.

If `.env` already exists, configuration saves the immediately previous version as ignored `.env.backup`, also mode `0600`. Secret values are not printed.

## Manual workflow

Use this when dependencies are already installed or you want each step separately:

```sh
make install
make build
make configure
```

Choose pi authentication:

- **OAuth subscription:** `make pi-login`, type `/login`, select the provider, finish the browser/device handoff, then type `/quit`.
- **API key:** `make configure`, select an API-key provider, and type the key into the hidden prompt.
- **Later:** the web server can start, but an agent session cannot use a provider until pi authentication exists.

The checkout's pinned pi CLI is used; a globally installed `pi` is not required.

### Optional owner-PIN confirmation preflight

Project-Agent runtime authority needs no PIN setup; it is derived from Project privacy and RBAC. The existing command-guard identity PIN remains available for operation-specific confirmations such as transcript mutation, external actions, and Protected-automation purge. Startup initializes the shared non-secret attempt/cooldown state owner-privately when safe.

For a manual metadata preflight, the human may run:

```sh
make setup-owner-pin-confirmations
make doctor
```

The initializer never reads or creates the PIN and accepts no PIN argument. It validates filesystem metadata, uses owner-only no-follow/no-overwrite creation when state is absent, and preserves valid attempts or a live reservation. It creates no Project-Agent authority, service, or runtime.

Wayang treats registered project folders as trusted Pi projects. Their `.pi/settings.json`, project packages, and extensions may load or execute as the Wayang host user for any agent profile. Register only reviewed folders inside the same single-user trust boundary; agent tool restrictions are not a sandbox for project-local Pi code.

## Start Wayang

Production mode builds current source and stays attached to the terminal:

```sh
make start
```

Open <http://127.0.0.1:8787>. Stop it with Ctrl-C. `/healthz` should return `{"status":"ok"}`.

Development mode runs the TypeScript backend watcher and Vite frontend together:

```sh
make dev
```

Open <http://127.0.0.1:5173>. Ctrl-C stops both child processes.

No systemd or launchd unit is shipped. If you later add process supervision, keep `.env` private, preserve the working directory, run as an unprivileged user, and apply the full network/authentication requirements in [SECURITY.md](../SECURITY.md).

### Normalize an existing supervised Browser deployment

`auto` is the production-standard Browser transport. Existing service definitions should leave `WAYANG_BROWSER_TRANSPORT` unset or set it to `auto`; `cdp` is an explicit Fast-page override and rollback setting.

Before changing an existing systemd or launchd deployment:

1. preserve the current unit drop-in or launchd configuration as an owner-private, timestamped rollback copy without printing its contents;
2. change only the Browser transport value to `auto`, preserving every unrelated environment and service setting;
3. on an existing systemd deployment, the tracked transport-only `deploy/60-browser-transport.auto.conf` is the reference drop-in; install it through the host's normal reviewed administrator procedure, then daemon-reload and restart the existing unit. It deliberately does not enable or migrate the separate named-profile host gate;
4. on an existing launchd deployment, update the equivalent `EnvironmentVariables` entry to `auto` through the host's established backup-first deployment procedure, then reload the existing job;
5. verify the bounded startup line reports `requested=auto` and the expected `selected` value, without dumping the service environment;
6. if the separate named-profile host gate was already reviewed and enabled, start a named Standard Browser Profile and verify Full browser is available on Linux with Xvfb/x11vnc. macOS and hosts without those dependencies should report the CDP fallback while retaining the same `auto` setting.

After selecting Full browser, pause the agent, click the destination field, and use **Paste text**. Test only with a synthetic canary before using a credential. The canary should appear exactly once and must not appear in HTTP requests, browser storage, or operational logs.

To roll back, restore the preserved supervisor configuration or set `WAYANG_BROWSER_TRANSPORT=cdp`, restart through the same reviewed procedure, and confirm startup reports `selected=cdp-screencast`. Do not delete browser profiles or Wayang data during transport rollback.

For authenticated Settings/capability administration from another private-LAN device, follow [Local HTTPS remote administration](local-https.md). After human configuration and Caddy installation, `make local-https-check` validates the non-secret deployment shape and generated proxy configuration; `make local-https` runs Caddy in a separate foreground process. It does not weaken remote owner checks or treat the command-guard PIN as a network password.

## Validate the checkout

```sh
make doctor
make check
make smoke
```

Playwright is separate because it needs a browser download:

```sh
make install-e2e-browser
make test-e2e
```

E2E tests create synthetic pi and Wayang directories and do not forward provider credentials into their web servers.

## Troubleshooting

### Node is unsupported or changed

Use your preferred version manager and the repository's preferred runtime:

```sh
nvm install
nvm use
```

Any manager is acceptable if `node --version` is at least 22.19.0. CI exercises the compatibility floor (22.19.0) and preferred current runtime (26.4.0); `make doctor` warns when a satisfying Node major is not covered by CI.

Native addons are tied to the Node module ABI. After changing Node major versions—even when both versions satisfy `engines`—rerun `make install` before starting Wayang, then verify `make doctor` reports the active Node ABI and a working `better-sqlite3` binding.

### `better-sqlite3` installation fails

Confirm that Node is supported and that Python 3 plus a compiler toolchain are available. Remove nothing from the checkout blindly; after fixing prerequisites, rerun `make install`, which recreates dependencies from lockfiles for the active Node runtime.

### No usable model

Run `make pi-login` for OAuth or API-key storage managed by pi, or rerun `make configure` to place a provider environment variable in private `.env`. Then choose a configured model in Wayang. Do not pass an API key with pi's `--api-key` CLI flag because command arguments may be visible to other local processes and shell history.

### Browser executable not found

Install Chromium/Chrome normally or set `WAYANG_CHROMIUM_PATH` to the absolute executable binary in `.env` (on macOS, the binary inside the app bundle, not the `.app` directory). The Browser pane reports whether resolution is `resolved`, `missing`, or `invalid_configured_path`; it never displays the configured path. The rest of Wayang remains usable without the browser workbench.

If the Browser pane works manually but an agent has no `browser_*` tools, review its **Agent browser tools** diagnostic. Approve `wayang.standard-browser.v1` for a Standard Project-Agent pair or `wayang.protected-browser.v1` for a Protected pair, then start a fresh interactive runtime. Scheduled/background sessions intentionally never receive these tools.

### Port already in use

Run `make configure` and choose another port. Keep the host at `127.0.0.1` unless you have reviewed [SECURITY.md](../SECURITY.md) and [configuration networking guidance](configuration.md#networking-and-reverse-proxies).

### Roll back configuration

Stop the foreground process. If the last wizard change was incorrect, copy `.env.backup` over `.env` without displaying either file, then ensure `.env` remains mode `0600`. Do not delete `~/.wayang`, pi state, sessions, projects, or browser profiles as part of rollback.
