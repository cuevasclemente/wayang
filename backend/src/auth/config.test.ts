import assert from "node:assert/strict";
import test from "node:test";
import type { AuthConfig } from "../config.js";
import { getConfig, validateAuthConfig } from "../config.js";
import { createPasswordHash } from "./password.js";

const validHash = await createPasswordHash("configuration test password");

function config(overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    enabled: true,
    passwordHash: validHash,
    sessionSecret: "a".repeat(32),
    sessionDays: 30,
    sessionStorePath: "/tmp/wayang-auth-test.json",
    trustProxy: "loopback",
    proxyIdentityHeader: "",
    cookieSecure: "auto",
    allowedOrigins: ["http://127.0.0.1:8787"],
    ...overrides,
  };
}

test("enabled authentication requires a valid scrypt record and high-entropy session secret", () => {
  assert.doesNotThrow(() => validateAuthConfig(config()));
  assert.throws(() => validateAuthConfig(config({ passwordHash: "malformed" })), /PASSWORD_HASH/);
  assert.throws(() => validateAuthConfig(config({ sessionSecret: "too-short" })), /SESSION_SECRET/);
  assert.throws(() => validateAuthConfig(config({ sessionDays: 0 })), /SESSION_DAYS/);
  assert.throws(() => validateAuthConfig(config({ sessionDays: 366 })), /SESSION_DAYS/);
});

test("disabled authentication does not require password or session secrets", () => {
  assert.doesNotThrow(() => validateAuthConfig(config({ enabled: false, passwordHash: "", sessionSecret: "" })));
});

test("proxy owner identity requires passwordless loopback trust and an exact remote HTTPS origin", () => {
  const proxy = config({
    enabled: false,
    passwordHash: "",
    sessionSecret: "",
    proxyIdentityHeader: "x-authentik-uid",
    allowedOrigins: ["https://wayang.example", "http://127.0.0.1:8787"],
  });
  assert.doesNotThrow(() => validateAuthConfig(proxy));
  assert.throws(() => validateAuthConfig({ ...proxy, enabled: true }), /mutually exclusive/);
  assert.throws(() => validateAuthConfig({ ...proxy, trustProxy: false }), /TRUST_PROXY/);
  assert.throws(() => validateAuthConfig({ ...proxy, allowedOrigins: ["http://127.0.0.1:8787"] }), /remote HTTPS/);
  assert.throws(() => validateAuthConfig({ ...proxy, allowedOrigins: ["http://wayang.example"] }), /remote HTTPS/);
});

test("browser transport, Bitwarden path, and credential timeout are validated without reading credentials", () => {
  const previous = {
    transport: process.env.WAYANG_BROWSER_TRANSPORT,
    bwPath: process.env.WAYANG_BITWARDEN_CLI_PATH,
    idle: process.env.WAYANG_BROWSER_CREDENTIALS_IDLE_MINUTES,
  };
  try {
    process.env.WAYANG_BROWSER_TRANSPORT = "invalid";
    assert.throws(() => getConfig(), /BROWSER_TRANSPORT/);
    process.env.WAYANG_BROWSER_TRANSPORT = "cdp";
    process.env.WAYANG_BITWARDEN_CLI_PATH = "relative/bw";
    assert.throws(() => getConfig(), /BITWARDEN_CLI_PATH/);
    process.env.WAYANG_BITWARDEN_CLI_PATH = "/synthetic/fake-bw";
    process.env.WAYANG_BROWSER_CREDENTIALS_IDLE_MINUTES = "0";
    assert.throws(() => getConfig(), /CREDENTIALS_IDLE_MINUTES/);
    process.env.WAYANG_BROWSER_CREDENTIALS_IDLE_MINUTES = "9";
    const browser = getConfig().browser;
    assert.equal(browser.transport, "cdp");
    assert.equal(browser.credentials.bwPath, "/synthetic/fake-bw");
    assert.equal(browser.credentials.idleTimeoutMs, 9 * 60_000);
  } finally {
    if (previous.transport === undefined) delete process.env.WAYANG_BROWSER_TRANSPORT;
    else process.env.WAYANG_BROWSER_TRANSPORT = previous.transport;
    if (previous.bwPath === undefined) delete process.env.WAYANG_BITWARDEN_CLI_PATH;
    else process.env.WAYANG_BITWARDEN_CLI_PATH = previous.bwPath;
    if (previous.idle === undefined) delete process.env.WAYANG_BROWSER_CREDENTIALS_IDLE_MINUTES;
    else process.env.WAYANG_BROWSER_CREDENTIALS_IDLE_MINUTES = previous.idle;
  }
});

test("public browser origin is exact and defaults to loopback aliases", () => {
  const previous = process.env.WAYANG_PUBLIC_ORIGIN;
  const previousPort = process.env.WAYANG_PORT;
  const previousProxyIdentityHeader = process.env.WAYANG_AUTH_PROXY_IDENTITY_HEADER;
  try {
    delete process.env.WAYANG_PUBLIC_ORIGIN;
    delete process.env.WAYANG_AUTH_PROXY_IDENTITY_HEADER;
    process.env.WAYANG_PORT = "9876";
    assert.deepEqual(getConfig().auth.allowedOrigins, [
      "http://127.0.0.1:9876",
      "http://localhost:9876",
      "http://[::1]:9876",
    ]);

    process.env.WAYANG_PUBLIC_ORIGIN = "https://wayang.example";
    assert.deepEqual(getConfig().auth.allowedOrigins, [
      "https://wayang.example",
      "http://127.0.0.1:9876",
      "http://localhost:9876",
      "http://[::1]:9876",
    ]);

    process.env.WAYANG_PUBLIC_ORIGIN = "https://wayang.example/path";
    assert.throws(() => getConfig(), /PUBLIC_ORIGIN/);
  } finally {
    if (previous === undefined) delete process.env.WAYANG_PUBLIC_ORIGIN;
    else process.env.WAYANG_PUBLIC_ORIGIN = previous;
    if (previousPort === undefined) delete process.env.WAYANG_PORT;
    else process.env.WAYANG_PORT = previousPort;
    if (previousProxyIdentityHeader === undefined) delete process.env.WAYANG_AUTH_PROXY_IDENTITY_HEADER;
    else process.env.WAYANG_AUTH_PROXY_IDENTITY_HEADER = previousProxyIdentityHeader;
  }
});
