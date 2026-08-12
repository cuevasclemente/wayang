import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  buildLocalHttpsCaddyfile,
  localHttpsCaddyEnvironment,
  localHttpsSettings,
} from "../lib/local-https.mjs";

const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));

function validValues(overrides = {}) {
  return new Map(Object.entries({
    WAYANG_HOST: "127.0.0.1",
    WAYANG_PORT: "8787",
    WAYANG_PUBLIC_ORIGIN: "https://wayang-host.example:8443",
    WAYANG_AUTH_ENABLED: "1",
    WAYANG_AUTH_PASSWORD_HASH: "synthetic-password-record",
    WAYANG_AUTH_SESSION_SECRET: "synthetic-session-secret",
    WAYANG_TRUST_PROXY: "loopback",
    WAYANG_AUTH_COOKIE_SECURE: "auto",
    ...overrides,
  }));
}

test("local HTTPS settings require a loopback backend, authenticated exact HTTPS origin, and Secure cookies", () => {
  assert.deepEqual(localHttpsSettings(validValues()), {
    publicOrigin: "https://wayang-host.example:8443",
    publicAuthority: "wayang-host.example:8443",
    backendOrigin: "http://127.0.0.1:8787",
  });

  const invalid = [
    ["WAYANG_HOST", "0.0.0.0", /127\.0\.0\.1/],
    ["WAYANG_PUBLIC_ORIGIN", "http://wayang-host.example:8443", /HTTPS/],
    ["WAYANG_PUBLIC_ORIGIN", "https://localhost:8443", /non-loopback/],
    ["WAYANG_PUBLIC_ORIGIN", "https://wayang-host.example", /unprivileged port/],
    ["WAYANG_PUBLIC_ORIGIN", "https://wayang-host.example:443", /unprivileged port/],
    ["WAYANG_PUBLIC_ORIGIN", "https://wayang-host.example:8443\\", /exact HTTPS authority/],
    ["WAYANG_AUTH_ENABLED", "0", /built-in authentication/],
    ["WAYANG_AUTH_PASSWORD_HASH", "", /shared-password credentials/],
    ["WAYANG_AUTH_SESSION_SECRET", "", /shared-password credentials/],
    ["WAYANG_TRUST_PROXY", "0", /WAYANG_TRUST_PROXY=loopback/],
    ["WAYANG_AUTH_COOKIE_SECURE", "0", /Secure cookies/],
    ["WAYANG_AUTH_COOKIE_SECURE", "sometimes", /Secure cookies/],
    ["WAYANG_AUTH_PROXY_IDENTITY_HEADER", "x-owner", /mutually exclusive/],
  ];
  for (const [key, value, expected] of invalid) {
    assert.throws(() => localHttpsSettings(validValues({ [key]: value })), expected, `${key}=${value}`);
  }
});

test("generated Caddyfile covers the whole origin and replaces forwarding metadata", () => {
  const config = buildLocalHttpsCaddyfile(localHttpsSettings(validValues()));
  assert.match(config, /^\{\n\s+admin off\n\}/);
  assert.match(config, /https:\/\/wayang-host\.example:8443 \{/);
  assert.match(config, /tls internal/);
  assert.match(config, /reverse_proxy http:\/\/127\.0\.0\.1:8787/);
  assert.match(config, /header_up Host "wayang-host\.example:8443"/);
  assert.match(config, /header_up -Forwarded/);
  assert.match(config, /header_up -X-Forwarded-For/);
  assert.match(config, /header_up -X-Forwarded-Host/);
  assert.match(config, /header_up -X-Forwarded-Proto/);
  assert.match(config, /header_up X-Forwarded-For "\{http\.request\.remote\.host\}"/);
  assert.match(config, /header_up X-Forwarded-Proto "https"/);
  assert.doesNotMatch(config, /AUTH_PASSWORD|SESSION_SECRET|synthetic-password|synthetic-session/);
  assert.doesNotMatch(config, /log\s*\{/i, "request logging stays off unless the operator adds it deliberately");
});

test("Caddy receives only non-secret process mechanics", () => {
  const child = localHttpsCaddyEnvironment({
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    TMPDIR: "/synthetic/tmp",
    XDG_DATA_HOME: "/synthetic/data",
    LANG: "en_US.UTF-8",
    OPENAI_API_KEY: "provider-secret",
    WAYANG_AUTH_SESSION_SECRET: "session-secret",
    HTTPS_PROXY: "proxy-secret",
    NODE_OPTIONS: "--require=untrusted",
  });
  assert.deepEqual(child, {
    PATH: "/synthetic/bin",
    HOME: "/synthetic/home",
    TMPDIR: "/synthetic/tmp",
    XDG_DATA_HOME: "/synthetic/data",
    LANG: "en_US.UTF-8",
  });
});

test("local HTTPS dry-run is non-interactive and does not read deployment configuration", () => {
  const output = execFileSync(process.execPath, [resolve(root, "scripts", "local-https.mjs"), "--dry-run"], {
    cwd: root,
    encoding: "utf8",
    env: { PATH: process.env.PATH || "" },
  });
  assert.match(output, /writes nothing|starts nothing|not read/i);
  assert.match(output, /make configure/i);
  assert.match(output, /Caddy/i);
  assert.doesNotMatch(output, /API_KEY|PASSWORD_HASH|SESSION_SECRET/);
});
