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

- is **not** a sandbox;
- is **not** a multi-user or multi-tenant service;
- does not isolate projects from each other or pi from the host user;
- does not make unreviewed pi extensions/packages safe;
- does not provide TLS or certificate management;
- cannot make public exposure safe solely by requiring a shared password.

Authentication controls who can reach Wayang. It does not reduce the authority of the Wayang/pi process after login.

## Safe deployment requirements

1. Keep the default `127.0.0.1:8787` bind whenever possible.
2. For remote access, use a trusted VPN/private network and HTTPS, and set `WAYANG_PUBLIC_ORIGIN` to the exact browser-facing HTTPS origin. Consider both built-in shared-password login and an authenticated reverse proxy according to your risk.
3. A proxy must protect and forward **every** path and WebSocket upgrade, including frontend assets, `/api/*`, `/ws/*`, app proxy routes, chat, browser CDP, and browser VNC. Block direct access to the backend that bypasses the proxy.
4. Treat every person/device with network access and credentials as able to control a host-level agent. VPN membership is not authorization isolation.
5. Use `WAYANG_TRUST_PROXY=loopback` only when the reverse proxy connects from loopback. Configure it to set the upstream `Host` header to the exact `WAYANG_PUBLIC_ORIGIN` authority and to replace—not append to or preserve—client-supplied `Forwarded` and `X-Forwarded-*` headers. `X-Forwarded-Host` is never used for authorization. v0.1 intentionally has no broad forwarded-header or proxy-auth identity trust mode.
6. Use Secure cookies over HTTPS. Never disable Secure-cookie behavior for remote login.
7. Run Wayang as an unprivileged dedicated user when practical. Do not run it as root.
8. Review third-party pi packages/extensions before installation; they execute with the host user's authority. Preserve pi's project-trust gate and approve project `.pi` resources only after source review.

When built-in authentication is enabled, `/healthz`, login/static assets, `GET /api/auth/status`, and `POST /api/auth/login` remain public by design. Other APIs and all WebSocket transports must share the same session checks. Browser origin checks for state-changing requests and every WebSocket upgrade apply even when password authentication is disabled. Report any bypass privately.

## Sensitive data

Protect at least:

- root `.env` and `.env.backup`;
- `~/.pi/agent/auth.json`, settings, extensions, and session JSONL;
- `~/.wayang/store.json`, `search.db`, and `auth-sessions.json`;
- projects and files Wayang can access;
- project `.pi/browser-workbench/` profiles, cookies, downloads, and artifacts;
- proxy/VPN configuration and logs;
- screenshots, debug output, browser traces, database copies, and backups.

The configuration wizard writes `.env`, its backup, and generated authentication material with mode `0600`. It stores only a salted scrypt password record, not the shared password. Browser sessions use opaque HttpOnly, SameSite cookies; stored session records contain keyed token hashes. Rotate provider credentials and the Wayang password/session secret if exposure is suspected.

Do not attach `.env`, auth files, transcripts, profiles, traces, or raw logs to issues. Before sharing diagnostics, reproduce with a synthetic HOME, pi directory, Wayang data directory, project, and credentials.

## Browser, apps, and TTS

The managed browser may contain active sessions to unrelated services. A compromised Wayang session can potentially act through that browser. Use a dedicated profile, minimize logged-in accounts, and keep profile directories private.

Project-local apps are executable code managed by the backend and displayed in the trusted Wayang origin. Review app manifests and source before launching them. Do not treat an iframe as a security sandbox for hostile code.

Configured TTS sends assistant text to the selected service. A remote broker/provider is a separate disclosure boundary and must be secured independently.

## Dependency and update practice

Use committed lockfiles and `npm ci`. Review dependency advisories for actual reachability rather than suppressing or blindly accepting them. Update from a reviewed source, rerun `make check` and relevant E2E/auth tests, and back up private data before migrations.
