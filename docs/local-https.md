# Local HTTPS remote administration with Caddy

Wayang can accept PIN-backed capability approvals from a non-localhost browser
only when that browser has an authenticated Settings owner. The simplest
single-user local-network topology is:

```text
remote browser
  └─ HTTPS + Wayang shared-password session
       └─ Caddy on an unprivileged LAN port
            └─ loopback HTTP
                 └─ Wayang on 127.0.0.1:8787
```

This keeps Wayang's backend port off the LAN, provides encrypted transport, and
lets the verified built-in-auth cookie own Settings approval challenges. It does
not turn Wayang into a multi-user service or make Internet exposure safe.

## What Wayang does and does not manage

The checkout includes a generated, foreground Caddy configuration through:

```sh
make local-https-check
make local-https
```

The command:

- parses `.env` as inert data, then applies the same ambient-environment
  precedence as `make start`; it retains only the selected non-secret
  networking/authentication shape and checks authentication values only for
  presence; those values are never returned or forwarded;
- generates no Caddyfile and writes no Wayang configuration; Caddy creates and
  retains its private local-CA and leaf-certificate material in its own data
  directory when it first serves the origin;
- validates the generated Caddyfile before startup;
- passes Caddy only a strict process-mechanics environment, never Wayang,
  provider, proxy, or loader credentials;
- disables Caddy's admin API and automatic trust-store installation, and does
  not enable request logging;
- binds the HTTPS listener only to the configured public-origin hostname and
  proxies every HTTP path and WebSocket upgrade;
- strips caller-supplied `Forwarded` and `X-Forwarded-*` headers, then sets the
  exact public `Host`, direct client address, and HTTPS protocol;
- runs Caddy in the foreground and forwards termination signals.

It never installs Caddy, edits DNS, installs CA trust, changes `.env`, sets a
password, opens a firewall, or installs a system service. Caddy does create the
private certificate-authority key and certificates required by `tls internal`;
protect its data directory and never transfer the CA private key. DNS, trust,
and other deployment actions remain explicit and human-managed.

## Prerequisites

1. Install Caddy from its official packages using your platform's normal
   package manager. Confirm `caddy version` works in the terminal that will run
   the proxy.
2. Choose a hostname that resolves to the Wayang host from each intended client
   device. Local DNS or an explicitly managed hosts entry is sufficient.
3. Choose an unprivileged HTTPS port from 1024 through 65535. This guide uses
   `8443`; the bundled foreground mode deliberately does not request root or
   bind port 443.
4. Keep the network private. A person who can authenticate to Wayang can control
   a host-level agent.

## Configure Wayang

Run the existing hidden-input wizard in a local terminal:

```sh
make configure
```

Select:

- **Enable shared-password login:** yes;
- a strong unique passphrase entered only at the hidden prompt;
- **Bind host:** `127.0.0.1`;
- **Port:** `8787` (or another free local port);
- **Configure an exact public browser origin:** yes;
- **Public browser origin:** for example
  `https://wayang-host.example:8443`;
- **Trust authenticated proxy identity:** no/not offered when built-in auth is
  enabled;
- **Secure cookie:** retain `auto` (or explicitly use `1`).

The local HTTPS command evaluates these settings with the same ambient-over-file
precedence as Wayang startup and fails closed unless all of these are true:

- `WAYANG_HOST=127.0.0.1`;
- the public origin is exact HTTPS, non-loopback, and uses an explicit
  unprivileged port;
- built-in authentication and its generated password/session records exist;
- `WAYANG_TRUST_PROXY=loopback`;
- Secure cookies are not disabled;
- `WAYANG_AUTH_PROXY_IDENTITY_HEADER` is unset because proxy identity and
  built-in auth are mutually exclusive.

Do not hand-edit or display `.env`. Rerun `make configure` to change these
settings.

## Validate and run

Validate without starting Caddy:

```sh
make local-https-check
```

Run Wayang and Caddy as two foreground processes, or use process supervision you
already understand:

```sh
# terminal/process 1
make start

# terminal/process 2
make local-https
```

Wayang ships no launchd/systemd unit for either process. If you supervise them,
preserve the checkout working directory, run both as an unprivileged user, keep
Wayang bound to loopback, and restart Wayang after `.env` changes.

## Trust the local CA

`tls internal` gives the configured origin a certificate from Caddy's local CA.
The human must establish trust before entering the Wayang password:

1. Start Caddy once so its local CA exists.
2. Use Caddy's documented `caddy trust` flow on the host if appropriate. It may
   require an administrator confirmation; Wayang never invokes it.
3. For another device, securely transfer and install **only the local CA root
   certificate** using that operating system/browser's documented trust flow.
   Never transfer Caddy's CA private key or its complete data directory.
4. Verify the browser shows a valid HTTPS connection for the exact configured
   hostname and port. Do not click through a certificate warning.

Each client must also resolve the configured hostname to the Wayang host. Caddy
binds that hostname rather than a wildcard interface; ensure it resolves to a
local address on the server before startup. DNS can still map the hostname to
an unintended or Internet-facing interface, so keep the host firewall/private
network boundary explicit.

## Verify remote Settings ownership

From a non-localhost client:

1. Open the exact HTTPS public origin.
2. Sign in with the Wayang shared password.
3. Open Settings → Capabilities.
4. Request and PIN-approve a reviewed Project-Agent capability association.
5. Start a fresh eligible agent runtime and confirm the capability-specific
   diagnostic reports tools available.

For Standard browser control, approve `wayang.standard-browser.v1` for the
intended Standard Project-Agent pair. Passwords, MFA, CAPTCHA, payment, passkeys,
and other secret-bearing browser steps remain human-only.

## Troubleshooting

- **Caddy executable not found:** install Caddy and ensure it is on `PATH`; the
  Wayang command does not install software.
- **Configuration rejected:** rerun `make configure` and follow the exact values
  above. The command reports setting names but never secret values.
- **Certificate warning:** stop. Fix hostname resolution and CA trust rather
  than bypassing TLS validation.
- **Login succeeds but capability approval says owner unavailable:** confirm the
  browser uses the exact HTTPS origin, cookies are enabled, Wayang built-in auth
  is enabled, and Caddy is the only network-reachable path.
- **WebSocket or Browser pane fails:** ensure no additional proxy handles only
  selected paths; the generated Caddyfile intentionally proxies the complete
  origin.
- **Port 8443 is busy:** choose another explicit unprivileged port in the public
  origin, rerun `make configure`, restart Wayang, then restart Caddy.

## Rollback

Stop Caddy, stop Wayang, restore the previous private configuration from
`.env.backup` without displaying either file, confirm mode `0600`, and restart
Wayang. Remove client CA trust only after confirming no other local service uses
that Caddy authority. Rollback never requires deleting Wayang data, sessions,
projects, capability associations, or browser profiles.

For an existing authenticated reverse proxy, use the identity-header design in
[Configuration](configuration.md#built-in-shared-password-login) instead of this
Caddy/shared-password path. Never relax remote Settings ownership to a hostname,
`Origin`, VPN membership, or the 8-digit command-guard PIN alone.
