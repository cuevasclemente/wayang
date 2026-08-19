# Agent-assisted installation

This guide lets a coding agent perform deterministic, non-secret setup while a human retains every credential, password, OAuth, MFA, account, and network-exposure decision. The intended result is a Linux or macOS source checkout with Node `>=22.19.0`, running on `127.0.0.1` for one trusted user.

## Non-negotiable boundaries

The installing agent must:

- inspect `README.md`, `SECURITY.md`, this guide, `Makefile`, and relevant manifests before acting;
- run `make doctor` before changing the checkout;
- never read or display `.env`, `.env.backup`, pi `auth.json`, secret stores, provider credentials, cookies, private keys, browser profiles, or real transcripts;
- never request secrets in chat or put them in command arguments, logs, commits, screenshots, test fixtures, or tool calls;
- pause for a human-local handoff for `/login`, API-key entry, the Wayang shared password, normal command-guard PIN entry when approving a capability, MFA, and account selection;
- keep `WAYANG_HOST=127.0.0.1` unless the human explicitly requests a networking/security discussion;
- use `npm ci` through the repository commands, with no global packages, `sudo`, service installation, or system-package mutation;
- use synthetic HOME/pi/Wayang directories and fake credentials for tests;
- stop and report an unexpected existing configuration or public bind rather than inspecting secrets or guessing intent.

## Workflow

### 1. Inspect and diagnose

From the checkout root:

```sh
make help
make doctor
sh scripts/bootstrap.sh --dry-run
node scripts/configure.mjs --dry-run
```

The agent may inspect file names, permissions, manifests, tool versions, and whether a private file exists. It must not inspect private file contents. Report missing system prerequisites and let the human choose how to install them.

### 2. Perform non-secret setup

The agent may run:

```sh
make install
make build
make test-scripts
```

If a native module build fails, report the exact non-secret error and platform prerequisites. Do not run a package manager or `sudo` autonomously.

### 3. Hand configuration to the human

Pause and ask the human to take over their local terminal. The human chooses one:

```sh
make configure
```

This supports hidden API-key entry, optional shared-password setup, and safe bind configuration; or:

```sh
make pi-login
```

The human types `/login`, selects the provider, completes browser/device authorization, then types `/quit`. Wayang treats registered project folders as trusted for project-local Pi resources, which may execute as the host user for every profile; register only reviewed folders. The agent must not watch, scrape, summarize, or copy secret-bearing interactions. A user may configure OAuth and then rerun `make configure` for server/password settings.

If the human uses reviewed privileged workspace capabilities, Wayang reuses the command guard's existing identity PIN; normal PIN entry in the approval UI is the human authorization action. The deployed service automatically creates missing non-secret attempt/cooldown state under `WAYANG_DATA_DIR` with owner-only permissions on startup and preserves it across reboots. Capability associations, deterministic jobs, and schedules persist in the service store; restart is needed only when deploying new code. `make setup-capability-approval` is an optional human-run preflight/migration, not installation or activation setup. The agent must not create a PIN, inspect either file, or substitute ad-hoc shell redirection for the supported command.

Normal installation must **not** run `make setup-historical-agent-activation`. That command exists only for an explicit continuity decision on the one designated historical-agent home and requires hidden local PIN entry. Fresh and secondary deployments remain identity-neutral with no activation witness; copying a store, profile name, or project configuration does not authorize activation.

After handoff, the agent may check only metadata with `make doctor`. A successful configuration file should exist with mode `0600`. Doctor may report PIN and cooldown metadata readiness, but missing or unsafe PIN metadata and unsafe or malformed existing cooldown state must remain fail-closed and must not be replaced. Their contents remain off limits.

### 4. Validate

Run the secret-isolated release checks:

```sh
make check
make smoke
```

If Playwright Chromium is already installed, run `make test-e2e`. Installing the browser into the user's cache is a separate human-approved step:

```sh
make install-e2e-browser
make test-e2e
```

Then ask the human to run `make start` in the foreground. Validate without printing headers/cookies:

1. `GET /healthz` returns status `ok`;
2. the root page loads at the configured local URL;
3. when built-in auth is enabled, a private/incognito browser sees the login gate and the human can log in;
4. when auth is disabled, loopback behavior remains passwordless;
5. the human creates a disposable test project/session and completes one normal user-visible agent message using their configured provider.

Do not automate a real password or provider credential into the validation. Do not weaken an auth failure to make the smoke test pass.

### 5. Report

Report:

- platform and Node/npm versions;
- non-secret commands run and pass/fail results;
- whether configuration/auth files are present by metadata only;
- the bind host category (`loopback` or `non-loopback`) only if the human states it or a non-secret startup message shows it;
- checks completed and remaining human validation;
- optional capabilities not installed, such as Chromium or external pi extensions.

Do not include environment values, session IDs, project paths containing personal information, cookies, auth responses, or transcript excerpts.

## Networking changes require a separate conversation

Do not turn `127.0.0.1` into `0.0.0.0`, a LAN address, tunnel, or public proxy as an installation convenience. First discuss:

- who can reach the network and whether all users are trusted;
- built-in shared-password versus external forward auth;
- HTTPS and Secure-cookie behavior;
- WebSocket forwarding and protection of every route;
- prevention of direct access that bypasses the proxy;
- the fact that authentication does not sandbox pi's filesystem/command/browser powers.

Follow [SECURITY.md](../SECURITY.md) and [configuration.md](configuration.md#networking-and-reverse-proxies).

## Rollback

To roll back installation/configuration without destroying data:

1. stop `make start` or `make dev` with Ctrl-C;
2. if the most recent wizard edit was wrong, have the human restore `.env.backup` over `.env` locally without showing either file, retaining mode `0600`;
3. rerun `make doctor`, `make build`, and the isolated smoke test;
4. preserve `~/.wayang`, `~/.pi/agent`, project files, sessions, and browser profiles.

Do not delete dependencies, configuration, transcripts, databases, profiles, or projects as a rollback shortcut. Publication, service management, and external networking are separate tasks requiring explicit approval.

## Copy/paste prompt for an installing agent

```text
Install this Wayang source checkout by following docs/agent-install.md exactly. Inspect first and run make doctor. You may perform only non-secret dependency installation, builds, script tests, and isolated smoke checks. Never read .env, .env.backup, pi auth.json, command-guard PIN/cooldown state, secret stores, browser profiles, or real transcripts. Never create a default PIN or ask me to paste a password/API key/PIN into chat or put secrets in argv, logs, commits, screenshots, or tool calls. Keep the loopback bind. Pause and hand control to me for pi /login, API-key entry, the optional Wayang password, normal entry of my existing command-guard PIN when I approve a capability, optional `make setup-capability-approval` preflight/migration, MFA, and any account choice. Do not use sudo, install global packages/services, change networking, activate capabilities, or delete user data. At the end, report commands/results and the human validation still required.
```
