import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";
import test from "node:test";
import type { AuthConfig } from "../config.js";
import { createPasswordHash } from "./password.js";
import { AuthService, SESSION_COOKIE_NAME } from "./service.js";

function request(options: { origin?: string; host?: string; cookie?: string; remoteAddress?: string; extraHeaders?: Record<string, string> } = {}): IncomingMessage {
  return {
    method: "POST",
    headers: {
      host: options.host ?? "wayang.test",
      ...(options.origin === undefined ? {} : { origin: options.origin }),
      ...(options.cookie === undefined ? {} : { cookie: options.cookie }),
      ...options.extraHeaders,
    },
    socket: {
      remoteAddress: options.remoteAddress ?? "127.0.0.1",
      encrypted: options.origin?.startsWith("https://") ?? false,
    },
  } as unknown as IncomingMessage;
}

function config(root: string, overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    enabled: false,
    passwordHash: "",
    sessionSecret: "synthetic-session-secret-with-at-least-32-bytes",
    sessionDays: 1,
    sessionStorePath: path.join(root, "auth-sessions.json"),
    trustProxy: false,
    proxyIdentityHeader: "",
    cookieSecure: "always",
    allowedOrigins: ["https://wayang.test"],
    ...overrides,
  };
}

test("authenticated Settings owner is a stable server-derived token handle with exact Origin", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-owner-"));
  try {
    const auth = new AuthService(config(root, { enabled: true, passwordHash: await createPasswordHash("synthetic-password") }), { failureDelayMs: 0 });
    const login = await auth.login("synthetic-password", request({ remoteAddress: "198.51.100.20" }));
    assert.equal(login.status, "success");
    if (login.status !== "success") return;
    const cookie = `${SESSION_COOKIE_NAME}=${encodeURIComponent(login.token)}`;
    const first = auth.resolveSettingsOwner(request({
      origin: "https://wayang.test", cookie, remoteAddress: "198.51.100.21",
      extraHeaders: { "x-forwarded-for": "203.0.113.99", "x-user": "forged-name" },
    }));
    const second = auth.resolveSettingsOwner(request({
      origin: "https://wayang.test", cookie, remoteAddress: "192.0.2.44",
      extraHeaders: { "x-forwarded-for": "127.0.0.1", "x-user": "different-forgery" },
    }));
    assert.equal(first.status, "authenticated");
    assert.equal(second.status, "authenticated");
    if (first.status !== "authenticated" || second.status !== "authenticated") return;
    assert.equal(first.owner.sessionId, second.owner.sessionId);
    assert.match(first.owner.sessionId, /^authenticated:[A-Za-z0-9_-]{43}$/u);
    assert.equal(first.owner.sessionId.includes(login.token), false);
    assert.equal(first.owner.sessionId.includes("198.51.100"), false);
    assert.equal(first.owner.sessionId.includes("forged-name"), false);
    assert.equal(first.owner.origin, "https://wayang.test");
    assert.deepEqual(auth.resolveSettingsOwner(request({ cookie })), { status: "invalid_origin" });
    assert.deepEqual(auth.resolveSettingsOwner(request({ origin: "https://wayang.test/path", cookie })), { status: "invalid_origin" });
    assert.deepEqual(auth.resolveSettingsOwner(request({ origin: "https://other.test", cookie })), { status: "invalid_origin" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("a configured loopback proxy identity becomes an opaque exact-origin owner", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-proxy-owner-"));
  try {
    const auth = new AuthService(config(root, {
      trustProxy: "loopback",
      proxyIdentityHeader: "x-authentik-uid",
      allowedOrigins: ["https://wayang.test", "http://127.0.0.1:8787"],
    }));
    const proxied = (identity?: string, remoteAddress = "127.0.0.1") => request({
      origin: "https://wayang.test",
      host: "wayang.test",
      remoteAddress,
      extraHeaders: {
        "x-forwarded-proto": "https",
        ...(identity === undefined ? {} : { "x-authentik-uid": identity }),
      },
    });
    const first = auth.resolveSettingsOwner(proxied("synthetic-user-id"));
    const second = auth.resolveSettingsOwner(proxied("synthetic-user-id"));
    const other = auth.resolveSettingsOwner(proxied("other-synthetic-user-id"));
    assert.equal(first.status, "authenticated");
    assert.equal(second.status, "authenticated");
    assert.equal(other.status, "authenticated");
    if (first.status !== "authenticated" || second.status !== "authenticated" || other.status !== "authenticated") return;
    assert.equal(first.owner.sessionId, second.owner.sessionId);
    assert.notEqual(first.owner.sessionId, other.owner.sessionId);
    assert.match(first.owner.sessionId, /^authenticated-proxy:[A-Za-z0-9_-]{43}$/u);
    assert.equal(first.owner.sessionId.includes("synthetic-user-id"), false);
    assert.equal(first.owner.origin, "https://wayang.test");
    assert.deepEqual(auth.resolveSettingsOwner(proxied()), { status: "unauthenticated" });
    assert.deepEqual(auth.resolveSettingsOwner(proxied("synthetic-user-id", "192.0.2.10")), { status: "unauthenticated" });
    assert.deepEqual(auth.resolveSettingsOwner(proxied(" synthetic-user-id")), { status: "unauthenticated" });
    assert.deepEqual(auth.resolveSettingsOwner(proxied("synthetic,user-id")), { status: "unauthenticated" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test("passwordless loopback Settings requests share one explicit process-local owner realm", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-passwordless-owner-"));
  try {
    const firstAuth = new AuthService(config(root, { allowedOrigins: ["http://127.0.0.1:8787"] }));
    const secondAuth = new AuthService(config(root, { allowedOrigins: ["http://127.0.0.1:8787"] }));
    const local = request({ origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787", remoteAddress: "::ffff:127.0.0.1" });
    const first = firstAuth.resolveSettingsOwner(local);
    const second = secondAuth.resolveSettingsOwner(local);
    assert.equal(first.status, "authenticated");
    assert.equal(second.status, "authenticated");
    if (first.status !== "authenticated" || second.status !== "authenticated") return;
    assert.equal(first.owner.sessionId, second.owner.sessionId);
    assert.match(first.owner.sessionId, /^passwordless-loopback:[0-9a-f-]{36}$/u);
    assert.deepEqual(firstAuth.resolveSettingsOwner(request({
      origin: "http://127.0.0.1:8787", host: "127.0.0.1:8787", remoteAddress: "192.0.2.10",
    })), { status: "unauthenticated" });
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
