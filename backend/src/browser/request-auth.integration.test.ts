import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { IncomingMessage } from "node:http";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import test from "node:test";
import { createApp } from "../app.js";
import { createPasswordHash } from "../auth/password.js";
import { AuthService } from "../auth/service.js";
import type { AuthConfig } from "../config.js";
import { createAgentProfile } from "../agent-profiles.js";
import { close, init } from "../db.js";
import { createProject } from "../projects.js";
import { createSession } from "../sessions.js";
import { selectProtectedBrowserWebSocket, type ProtectedBrowserIntegration } from "../routes/protected-browser.js";
import {
  browserAgentAuthorizationForSourceSession,
  BROWSER_AGENT_SOURCE_SESSION_HEADER,
  BROWSER_AGENT_TOKEN_HEADER,
  LEGACY_BROWSER_AGENT_ATTRIBUTION_ERROR,
} from "./request-auth.js";

async function availablePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve, reject) => {
    probe.once("error", reject);
    probe.listen(0, "127.0.0.1", resolve);
  });
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

test("legacy generic browser agent tokens are route-scoped but cannot bypass exact Standard browser capability tools", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-agent-auth-"));
  const project = path.join(root, "project-a");
  const targetProject = path.join(root, "project-b");
  fs.mkdirSync(project);
  fs.mkdirSync(targetProject);
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  init();
  const sourceProfile = createAgentProfile({ name: "Browser source", resource_mode: "standard" });
  const targetProfile = createAgentProfile({ name: "Browser target source", resource_mode: "standard" });
  createProject({ cwd: project, default_agent_profile_id: sourceProfile.id });
  createProject({
    cwd: targetProject,
    default_agent_profile_id: targetProfile.id,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [targetProfile.id] },
  });
  const source = createSession(project);
  const authorizedSource = createSession(targetProject);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authConfig: AuthConfig = {
    enabled: true,
    passwordHash: await createPasswordHash("synthetic-browser-test-password"),
    sessionSecret: "synthetic-session-secret-at-least-thirty-two-bytes",
    sessionDays: 30,
    sessionStorePath: path.join(root, "auth-sessions.json"),
    trustProxy: false,
    proxyIdentityHeader: "",
    cookieSecure: "auto",
    allowedOrigins: [baseUrl],
  };
  const { server } = createApp({
    config: { standardBrowserProfileHosts: false },
    authService: new AuthService(authConfig),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  assert.equal(process.env.WAYANG_BROWSER_AGENT_TOKEN, undefined);
  const authorization = browserAgentAuthorizationForSourceSession(source.id);
  assert.ok(authorization);
  const agentHeaders = {
    [BROWSER_AGENT_TOKEN_HEADER]: authorization.token,
    [BROWSER_AGENT_SOURCE_SESSION_HEADER]: authorization.sourceSessionId,
  };
  const deniedWebSocketIntegration: ProtectedBrowserIntegration = {
    select: async () => null,
    resolve: async () => null,
  };
  await assert.rejects(
    selectProtectedBrowserWebSocket({
      url: "/api/browser/ws?transport=cdp",
      headers: { [BROWSER_AGENT_SOURCE_SESSION_HEADER]: authorization.sourceSessionId },
    } as unknown as IncomingMessage, "cdp", deniedWebSocketIntegration),
    /Exact interactive browser capability authority is unavailable/,
  );
  const query = new URLSearchParams({ project_cwd: project, persistence: "project" });
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "synthetic-browser-test-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const status = await fetch(`${baseUrl}/api/browser/status?${query}`, { headers: agentHeaders });
  assert.equal(status.status, 403);
  assert.equal(status.headers.get("cache-control"), "no-store");
  assert.deepEqual(await status.json(), {
    error: "Standard browser agent access requires exact capability-bound tools",
  }, "gate-off preserves the existing legacy attribution contract");
  const matchingSessionQuery = new URLSearchParams({
    session_id: source.id,
    project_cwd: project,
    persistence: "session",
  });
  const matchingSessionTarget = await fetch(`${baseUrl}/api/browser/status?${matchingSessionQuery}`, { headers: agentHeaders });
  assert.equal(matchingSessionTarget.status, 403);

  const uiStateResponse = await fetch(`${baseUrl}/api/browser/status?${query}`, {
    headers: { Origin: baseUrl, Cookie: cookie },
  });
  assert.equal(uiStateResponse.status, 200);
  const publicState = await uiStateResponse.json() as Record<string, unknown>;
  const serialized = JSON.stringify(publicState);
  for (const privateField of ["profileDir", "runtimePath", "cdpPort", "vncPort", "display", "logs", "controlGeneration", "activeTargetId"]) {
    assert.equal(serialized.includes(privateField), false, privateField);
  }

  const forged = await fetch(`${baseUrl}/api/browser/status?${query}`, {
    headers: {
      [BROWSER_AGENT_TOKEN_HEADER]: "forged-browser-agent-token",
      [BROWSER_AGENT_SOURCE_SESSION_HEADER]: source.id,
    },
  });
  assert.equal(forged.status, 403, "generic browser authority is denied before bearer recognition");

  const nonBrowserBypass = await fetch(`${baseUrl}/api/me`, { headers: agentHeaders });
  assert.equal(nonBrowserBypass.status, 401, "browser capability must not bypass non-browser API auth");

  const targetQuery = new URLSearchParams({ project_cwd: targetProject, persistence: "project" });
  const mismatchedSessionQuery = new URLSearchParams({
    session_id: source.id,
    project_cwd: targetProject,
    persistence: "session",
  });
  const mismatchedAgentTarget = await fetch(`${baseUrl}/api/browser/status?${mismatchedSessionQuery}`, { headers: agentHeaders });
  assert.equal(mismatchedAgentTarget.status, 403, "legacy agent tokens fail before generic target selection");
  const mismatchedUiTarget = await fetch(`${baseUrl}/api/browser/status?${mismatchedSessionQuery}`, {
    headers: { Origin: baseUrl, Cookie: cookie },
  });
  assert.equal(mismatchedUiTarget.status, 409, "manual/UI lookups must reject the same mismatch");

  const deniedTarget = await fetch(`${baseUrl}/api/browser/status?${targetQuery}`, { headers: agentHeaders });
  assert.equal(deniedTarget.status, 403);

  const targetAuthorization = browserAgentAuthorizationForSourceSession(authorizedSource.id);
  assert.ok(targetAuthorization);
  const authorizedTarget = await fetch(`${baseUrl}/api/browser/status?${targetQuery}`, {
    headers: {
      [BROWSER_AGENT_TOKEN_HEADER]: targetAuthorization.token,
      [BROWSER_AGENT_SOURCE_SESSION_HEADER]: targetAuthorization.sourceSessionId,
    },
  });
  assert.equal(authorizedTarget.status, 403, "project allowlisting alone is not browser capability authority");

  const handoff = await fetch(`${baseUrl}/api/browser/control-mode`, {
    method: "POST",
    headers: { Origin: baseUrl, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ projectCwd: project, persistence: "project", mode: "user", reason: "synthetic login" }),
  });
  assert.equal(handoff.status, 200);

  const blocked = await fetch(`${baseUrl}/api/browser/navigate`, {
    method: "POST",
    headers: { ...agentHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ projectCwd: project, persistence: "project", url: "https://example.test" }),
  });
  assert.equal(blocked.status, 403);

  const credentialAgent = await fetch(`${baseUrl}/api/browser/credentials/status?${query}`, {
    method: "POST",
    headers: { ...agentHeaders, Origin: baseUrl },
  });
  assert.equal(credentialAgent.status, 403);
  assert.equal(credentialAgent.headers.get("cache-control"), "no-store");

  const missingOrigin = await fetch(`${baseUrl}/api/browser/credentials/status?${query}`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(missingOrigin.status, 403);
  const uiStatus = await fetch(`${baseUrl}/api/browser/credentials/status?${query}`, {
    method: "POST",
    headers: { Origin: baseUrl, Cookie: cookie },
  });
  assert.equal(uiStatus.status, 200);
  assert.equal(uiStatus.headers.get("cache-control"), "no-store");

  const legacyGet = await fetch(`${baseUrl}/api/browser/credentials/status?${query}`, {
    headers: { Origin: baseUrl, Cookie: cookie },
  });
  assert.equal(legacyGet.status, 404);
  assert.equal(legacyGet.headers.get("cache-control"), "no-store");

  const allowMissingOrigin = await fetch(`${baseUrl}/api/browser/credentials/allow-agent-inspection?${query}`, {
    method: "POST",
    headers: { Cookie: cookie },
  });
  assert.equal(allowMissingOrigin.status, 403);
  const allowAgent = await fetch(`${baseUrl}/api/browser/credentials/allow-agent-inspection?${query}`, {
    method: "POST",
    headers: { ...agentHeaders, Origin: baseUrl },
  });
  assert.equal(allowAgent.status, 403);
  const allowWithoutFill = await fetch(`${baseUrl}/api/browser/credentials/allow-agent-inspection?${query}`, {
    method: "POST",
    headers: { Origin: baseUrl, Cookie: cookie },
  });
  assert.equal(allowWithoutFill.status, 409);
  assert.equal(allowWithoutFill.headers.get("cache-control"), "no-store");
});

test("enabled Standard Browser Profile hosts reject legacy attribution before JSON parsing", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-browser-agent-gate-"));
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authConfig: AuthConfig = {
    enabled: false,
    passwordHash: "",
    sessionSecret: "",
    sessionDays: 30,
    sessionStorePath: path.join(root, "auth-sessions.json"),
    trustProxy: false,
    proxyIdentityHeader: "",
    cookieSecure: "auto",
    allowedOrigins: [baseUrl],
  };
  const { server } = createApp({
    config: { standardBrowserProfileHosts: true },
    authService: new AuthService(authConfig),
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  const response = await fetch(`${baseUrl}/api/browser/status`, {
    method: "POST",
    headers: {
      [BROWSER_AGENT_TOKEN_HEADER]: "synthetic-legacy-attribution",
      "Content-Type": "application/json",
    },
    body: "{malformed-json",
  });
  assert.equal(response.status, 403);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { error: LEGACY_BROWSER_AGENT_ATTRIBUTION_ERROR });
});
