import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { request as httpRequest } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import { createApp } from "../app.js";
import type { AuthConfig } from "../config.js";
import { createPasswordHash } from "./password.js";
import { AuthService, type AuthServiceOptions } from "./service.js";

const PASSWORD = "test shared password";
const PASSWORD_HASH = await createPasswordHash(PASSWORD);

function authConfig(dataDir: string, overrides: Partial<AuthConfig> = {}): AuthConfig {
  return {
    enabled: true,
    passwordHash: PASSWORD_HASH,
    sessionSecret: "integration-test-session-secret-32-bytes-minimum",
    sessionDays: 30,
    sessionStorePath: path.join(dataDir, "auth-sessions.json"),
    trustProxy: "loopback",
    proxyIdentityHeader: "",
    cookieSecure: "auto",
    allowedOrigins: [],
    ...overrides,
  };
}

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function fixture(t: TestContext, config: AuthConfig, serviceOptions: AuthServiceOptions = {}) {
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  config.allowedOrigins = [...new Set([baseUrl, ...config.allowedOrigins])];
  const auth = new AuthService(config, { failureDelayMs: 0, ...serviceOptions });
  const { server } = createApp({ authService: auth });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return { auth, server, baseUrl, wsUrl: `ws://127.0.0.1:${port}` };
}

function sessionCookie(response: Response): string {
  const setCookie = response.headers.get("set-cookie");
  assert.ok(setCookie);
  return setCookie.split(";", 1)[0];
}

async function login(baseUrl: string, password = PASSWORD, headers: Record<string, string> = {}) {
  return fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl, ...headers },
    body: JSON.stringify({ password }),
  });
}

async function rawHttp(
  url: string,
  options: { method?: string; headers: Record<string, string>; body?: string },
): Promise<{ status: number; headers: Record<string, string | string[] | undefined> }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(url, { method: options.method, headers: options.headers }, (response) => {
      response.resume();
      resolve({ status: response.statusCode ?? 0, headers: response.headers });
    });
    request.once("error", reject);
    if (options.body) request.write(options.body);
    request.end();
  });
}

async function rawHttpStatus(url: string, headers: Record<string, string>): Promise<number> {
  return (await rawHttp(url, { headers })).status;
}

async function rejectedUpgrade(url: string, status: number, headers: Record<string, string> = {}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, status);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    ws.once("open", () => reject(new Error("WebSocket unexpectedly opened")));
    ws.once("error", () => undefined);
  });
}

async function acceptedUpgrade(url: string, headers: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("open", () => {
      ws.close();
      resolve();
    });
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`WebSocket rejected with ${response.statusCode}`));
    });
    ws.once("error", reject);
  });
}

test("auth-disabled mode preserves API and WebSocket access without setting a session cookie", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-disabled-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = authConfig(dataDir, { enabled: false, passwordHash: "", sessionSecret: "" });
  const { baseUrl, wsUrl } = await fixture(t, config);

  const status = await fetch(`${baseUrl}/api/auth/status`);
  assert.deepEqual(await status.json(), { enabled: false, authenticated: true });
  assert.equal((await fetch(`${baseUrl}/api/me`)).status, 200);
  const loginResponse = await login(baseUrl, "anything");
  assert.equal(loginResponse.status, 200);
  assert.equal(loginResponse.headers.get("set-cookie"), null);

  const sessionOpenMetric = await fetch(`${baseUrl}/api/latency/metrics/session-open`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ duration_ms: 123.45 }),
  });
  assert.equal(sessionOpenMetric.status, 204);
  const invalidSessionOpenMetric = await fetch(`${baseUrl}/api/latency/metrics/session-open`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ duration_ms: "private-session-id" }),
  });
  assert.equal(invalidSessionOpenMetric.status, 400);

  const crossOriginPost = await fetch(`${baseUrl}/api/sessions/search/reindex`, {
    method: "POST",
    headers: { Origin: "https://unrelated.example" },
  });
  assert.equal(crossOriginPost.status, 403);

  const rebindingOrigin = "http://attacker.example";
  assert.equal(
    await rawHttpStatus(`${baseUrl}/api/me`, { Host: "attacker.example" }),
    403,
  );
  assert.equal(
    await rawHttpStatus(`${baseUrl}/api/me`, {
      Host: "attacker.example",
      "X-Forwarded-Host": new URL(baseUrl).host,
    }),
    403,
  );

  const rebindingPost = await fetch(`${baseUrl}/api/sessions/search/reindex`, {
    method: "POST",
    headers: { Host: "attacker.example", Origin: rebindingOrigin },
  });
  assert.equal(rebindingPost.status, 403);

  for (const wsPath of ["/ws/chat", "/ws/browser", "/ws/browser-vnc"]) {
    await rejectedUpgrade(`${wsUrl}${wsPath}`, 403, { Origin: "https://unrelated.example" });
    await rejectedUpgrade(`${wsUrl}${wsPath}`, 403, { Host: "attacker.example", Origin: rebindingOrigin });
    await rejectedUpgrade(`${wsUrl}${wsPath}`, 403, { Host: "attacker.example", Origin: baseUrl });
    await acceptedUpgrade(`${wsUrl}${wsPath}`, { Origin: baseUrl });
  }
});

test("public allowlist stays public and every privileged REST router is centrally protected", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-rest-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { baseUrl } = await fixture(t, authConfig(dataDir));

  assert.equal((await fetch(`${baseUrl}/healthz`)).status, 200);
  const status = await fetch(`${baseUrl}/api/auth/status`);
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), { enabled: true, authenticated: false });
  const healthWithOrigin = await fetch(`${baseUrl}/healthz`, { headers: { Origin: "https://other.example" } });
  assert.equal(healthWithOrigin.headers.get("access-control-allow-origin"), null);
  const oversizedLogin = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: baseUrl },
    body: JSON.stringify({ password: "x".repeat(5_000) }),
  });
  assert.equal(oversizedLogin.status, 413);

  const protectedPaths = [
    "/api/me", "/api/latency/metrics", "/api/models", "/api/sessions", "/api/sessions/search",
    "/api/projects", "/api/agent-profiles", "/api/workspace-settings",
    "/api/agent-profiles/example/references", "/api/fs/tree", "/api/capabilities", "/api/apps",
    "/api/apps/example/proxy/example/", "/api/scheduled-agent-jobs", "/api/scheduled-jobs",
    "/api/tts/audio/example", "/api/browser/status", "/api/unknown",
  ];
  for (const route of protectedPaths) {
    const response = await fetch(`${baseUrl}${route}`);
    assert.equal(response.status, 401, route);
    assert.equal(response.headers.get("x-wayang-authentication-required"), "1", route);
    assert.deepEqual(await response.json(), { error: "Authentication required" }, route);
  }
});

test("login, persistent status, cookie flags, logout, revocation, and store permissions", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-login-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const config = authConfig(dataDir);
  const { baseUrl } = await fixture(t, config);

  const failure = await login(baseUrl, "wrong password");
  assert.equal(failure.status, 401);
  assert.equal(failure.headers.get("x-wayang-authentication-required"), null);
  assert.deepEqual(await failure.json(), { error: "Invalid password" });

  const success = await login(baseUrl);
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), { enabled: true, authenticated: true });
  const setCookie = success.headers.get("set-cookie")!;
  assert.match(setCookie, /wayang_session=[^;]+/);
  assert.match(setCookie, /HttpOnly/i);
  assert.match(setCookie, /SameSite=Strict/i);
  assert.match(setCookie, /Path=\//i);
  assert.match(setCookie, /Max-Age=2592000/i);
  assert.doesNotMatch(setCookie, /; Secure/i);
  const cookie = sessionCookie(success);

  const authenticated = await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } });
  assert.deepEqual(await authenticated.json(), { enabled: true, authenticated: true });
  assert.equal((await fetch(`${baseUrl}/api/me`, { headers: { Cookie: cookie } })).status, 200);

  assert.equal(fs.readFileSync(config.sessionStorePath, "utf8").includes(cookie.split("=", 2)[1]), false);
  if (process.platform !== "win32") assert.equal(fs.statSync(config.sessionStorePath).mode & 0o777, 0o600);

  const logout = await fetch(`${baseUrl}/api/auth/logout`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: baseUrl },
  });
  assert.equal(logout.status, 200);
  assert.deepEqual(await logout.json(), { enabled: true, authenticated: false });
  assert.match(logout.headers.get("set-cookie")!, /Max-Age=0/i);
  assert.deepEqual(
    await (await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } })).json(),
    { enabled: true, authenticated: false },
  );
});

test("state-changing HTTP requests and all WebSocket transports enforce same-origin", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-origin-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { baseUrl, wsUrl } = await fixture(t, authConfig(dataDir));

  const rejectedLogin = await login(baseUrl, PASSWORD, { Origin: "https://evil.example" });
  assert.equal(rejectedLogin.status, 403);
  const success = await login(baseUrl);
  const cookie = sessionCookie(success);

  const rejectedPost = await fetch(`${baseUrl}/api/sessions`, {
    method: "POST",
    headers: { Cookie: cookie, Origin: "https://evil.example", "Content-Type": "application/json" },
    body: "{}",
  });
  assert.equal(rejectedPost.status, 403);
  assert.deepEqual(await rejectedPost.json(), { error: "Origin not allowed" });

  const rejectedWorkspaceDefault = await fetch(`${baseUrl}/api/workspace-settings`, {
    method: "PUT",
    headers: { Cookie: cookie, Origin: "https://evil.example", "Content-Type": "application/json" },
    body: JSON.stringify({ default_agent_profile_id: "synthetic-profile" }),
  });
  assert.equal(rejectedWorkspaceDefault.status, 403);
  assert.deepEqual(await rejectedWorkspaceDefault.json(), { error: "Origin not allowed" });

  for (const wsPath of ["/ws/chat", "/ws/browser", "/ws/browser-vnc"]) {
    await rejectedUpgrade(`${wsUrl}${wsPath}`, 401, { Origin: baseUrl });
    await rejectedUpgrade(`${wsUrl}${wsPath}`, 403, { Origin: "https://evil.example", Cookie: cookie });
    await acceptedUpgrade(`${wsUrl}${wsPath}`, { Origin: baseUrl, Cookie: cookie });
  }
});

test("login rate limiting is per trusted source and bounded before password work", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-rate-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const { baseUrl } = await fixture(t, authConfig(dataDir), {
    rateLimitAttempts: 2,
    rateLimitWindowMs: 60_000,
    maxRateLimitSources: 2,
  });

  assert.equal((await login(baseUrl, "wrong one")).status, 401);
  assert.equal((await login(baseUrl, "wrong two")).status, 401);
  const limited = await login(baseUrl, PASSWORD);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get("retry-after")) >= 1);

  // Loopback is the explicitly trusted proxy, so a distinct forwarded client
  // gets an independent bucket rather than sharing the proxy's bucket.
  const otherSource = await login(baseUrl, PASSWORD, { "X-Forwarded-For": "198.51.100.5" });
  assert.equal(otherSource.status, 200);
});

test("trusted loopback proxy metadata controls auto-Secure cookies; untrusted metadata is ignored", async (t) => {
  const trustedDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-proxy-"));
  t.after(() => fs.rmSync(trustedDir, { recursive: true, force: true }));
  const trusted = await fixture(t, authConfig(trustedDir, { allowedOrigins: ["https://wayang.example"] }));
  const body = JSON.stringify({ password: PASSWORD });
  const proxied = await rawHttp(`${trusted.baseUrl}/api/auth/login`, {
    method: "POST",
    headers: {
      Host: "wayang.example",
      Origin: "https://wayang.example",
      "Content-Type": "application/json",
      "Content-Length": String(Buffer.byteLength(body)),
      "X-Forwarded-Proto": "https",
      "X-Forwarded-Host": "attacker-controlled.example",
    },
    body,
  });
  assert.equal(proxied.status, 200);
  assert.match(String(proxied.headers["set-cookie"]), /; Secure/i);

  const untrustedDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-no-proxy-"));
  t.after(() => fs.rmSync(untrustedDir, { recursive: true, force: true }));
  const untrusted = await fixture(t, authConfig(untrustedDir, { trustProxy: false }));
  const spoofed = await login(untrusted.baseUrl, PASSWORD, {
    Origin: "https://wayang.example",
    "X-Forwarded-Proto": "https",
    "X-Forwarded-Host": "wayang.example",
  });
  assert.equal(spoofed.status, 403);
});

test("expired cookies cease authenticating even if a client keeps sending them", async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-auth-expiry-"));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  let now = 10_000;
  const config = authConfig(dataDir, { sessionDays: 1 });
  const { baseUrl } = await fixture(t, config, { now: () => now });
  const success = await login(baseUrl);
  const cookie = sessionCookie(success);
  assert.deepEqual(
    await (await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } })).json(),
    { enabled: true, authenticated: true },
  );
  now += 24 * 60 * 60 * 1_000 + 1;
  assert.deepEqual(
    await (await fetch(`${baseUrl}/api/auth/status`, { headers: { Cookie: cookie } })).json(),
    { enabled: true, authenticated: false },
  );
});
