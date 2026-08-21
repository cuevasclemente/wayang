# Wayang contributor instructions

Wayang is an early-stage, single-user web workbench for the pi coding-agent harness. Treat it as a privileged local control surface, not a sandbox or multi-tenant service.

## Before changing code

1. Read `README.md`, `SECURITY.md`, and the relevant guide under `docs/`.
2. Run `make doctor` before setup or troubleshooting.
3. Inspect the relevant source and tests; do not guess configuration or API contracts.
4. Keep the default bind at `127.0.0.1` unless the maintainer explicitly discusses the network and authentication model.

## Secret safety

- Never read, print, copy, or commit `.env`, pi's `auth.json`, provider credentials, cookies, private keys, or browser profiles.
- Protected-project and unclassified/quarantined session transcripts and attachments are private and must never be inspected outside their owning backend/UI flow. Standard-project transcripts and attachments are intentionally cross-session readable through Wayang's bounded session tools or exact-file `read`; keep that access read-only, avoid broad storage scans, and never reproduce credentials or sensitive personal data unnecessarily.
- Never ask a human to paste credentials into chat or place secrets in command arguments, logs, fixtures, screenshots, or tool calls.
- Hand OAuth, API-key, password, MFA, and account steps to the human in their local terminal. `make configure` and `make pi-login` provide the supported flows.
- Use synthetic homes, pi directories, data directories, and credentials in tests.

## Development

Use the root command surface rather than global tools or machine-wide installation:

```sh
make help
make install
make build
make test
make test-e2e
make check
```

Do not add `sudo`, automatic system-package installation, service-manager setup, destructive clean/reset targets, or secret-bearing examples. Keep Linux and macOS portability, Node `>=22.19.0`, deterministic `npm ci`, loopback defaults, foreground processes, and clean signal handling.

## Change expectations

- Add focused regression tests for behavior changes.
- Protect every privileged HTTP route and WebSocket transport consistently.
- Preserve passwordless loopback behavior.
- Document new stable environment variables in `.env.example` and `docs/configuration.md` without values.
- Do not weaken security or tests merely to make a check pass.
- Route vulnerabilities through `SECURITY.md`, not public issues.
