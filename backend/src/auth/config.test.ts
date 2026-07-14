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

test("public browser origin is exact and defaults to loopback aliases", () => {
  const previous = process.env.WAYANG_PUBLIC_ORIGIN;
  const previousPort = process.env.WAYANG_PORT;
  try {
    delete process.env.WAYANG_PUBLIC_ORIGIN;
    process.env.WAYANG_PORT = "9876";
    assert.deepEqual(getConfig().auth.allowedOrigins, [
      "http://127.0.0.1:9876",
      "http://localhost:9876",
      "http://[::1]:9876",
    ]);

    process.env.WAYANG_PUBLIC_ORIGIN = "https://wayang.example";
    assert.deepEqual(getConfig().auth.allowedOrigins, ["https://wayang.example"]);

    process.env.WAYANG_PUBLIC_ORIGIN = "https://wayang.example/path";
    assert.throws(() => getConfig(), /PUBLIC_ORIGIN/);
  } finally {
    if (previous === undefined) delete process.env.WAYANG_PUBLIC_ORIGIN;
    else process.env.WAYANG_PUBLIC_ORIGIN = previous;
    if (previousPort === undefined) delete process.env.WAYANG_PORT;
    else process.env.WAYANG_PORT = previousPort;
  }
});
