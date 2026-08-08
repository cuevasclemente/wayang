# Contributing to Wayang

Wayang v0.1 is early-stage, single-user software. Contributions that improve portability, reliability, documentation, test coverage, and the trusted-user security model are welcome.

## Before opening work

- Search existing issues and pull requests.
- Use a public issue for ordinary bugs or proposals, without private paths, transcripts, screenshots, credentials, or deployment details.
- Follow [SECURITY.md](SECURITY.md) for vulnerabilities; do not open a public security issue.
- Discuss large architecture, network exposure, authentication, data-format, or extension-distribution changes before implementing them.

## Development setup

Linux and macOS are supported. Node `>=22.19.0` is required; `.nvmrc` selects the preferred Node 26.4.0 runtime, and CI covers Node 22.19.0 and 26.4.0.

```sh
make doctor
make install
make build
make test
```

Run development servers with `make dev`. The frontend is normally at `http://127.0.0.1:5173` and proxies to the backend at `http://127.0.0.1:8787`.

Use repository-local dependencies and committed lockfiles. Do not require global npm packages, root privileges, a service manager, real credentials, or private infrastructure.

## Tests

Add focused regression coverage for behavior changes. Before submitting:

```sh
make check
```

For browser-visible or transport changes, also run:

```sh
make install-e2e-browser  # once, if Chromium is absent
make test-e2e
```

E2E tests must use synthetic HOME, pi, Wayang, project, and credential state. Never point tests at a real pi config/session directory or forward the parent process's provider secrets.

Authentication changes need coverage across privileged REST routes, chat WebSocket, browser CDP/VNC WebSockets, cookies, origin handling, logout/revocation, proxy behavior, and passwordless compatibility. Do not weaken assertions or security defaults merely to pass CI.

## Code and documentation expectations

- Keep the default bind loopback-only and foreground lifecycle signal-safe.
- Keep scripts portable across Linux and macOS, secret-safe, non-privileged, and deterministic.
- Use `WAYANG_*` for new public configuration and document it in `.env.example` plus `docs/configuration.md`.
- Do not shell-source `.env` or place secrets in arguments, URLs, browser storage, logs, examples, or snapshots.
- Preserve unknown user configuration and data; avoid destructive reset/clean/uninstall behavior.
- Clearly label optional capabilities and graceful degradation.
- Update user documentation when commands, configuration, data locations, or security behavior change.

## Pull requests

Wayang is distributed across multiple machines. A release-intended change is not complete when it exists only in one checkout: commit it, push it to GitHub, open or update a pull request, and merge it into the canonical default branch after required checks pass. Report merged-source status separately from deployment or service-restart status, and do not leave shipping fixes as unmerged host-local patches unless they are explicitly experimental.

Keep changes focused. Include:

- the problem and approach;
- security/data-migration implications;
- tests and commands run with results;
- platforms tested;
- remaining limitations or human validation.

Do not commit generated `dist`, dependency directories, test artifacts, `.env*` (other than `.env.example`), `.pi/`, browser profiles, local databases, internal journals, or personal deployment configuration.

## License

By contributing, you agree that your contribution is licensed under the repository's [Mozilla Public License 2.0](LICENSE). You must have the right to submit the work and retain required third-party notices. Avoid adding dependencies or copied code without compatible licensing and provenance review.
