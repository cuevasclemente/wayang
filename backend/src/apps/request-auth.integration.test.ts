import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
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
import { stopAllApps } from "./process-manager.js";
import {
  APPS_AGENT_ACTOR_HEADER,
  appsAgentAuthorizationForSourceSession,
  APPS_AGENT_SOURCE_SESSION_HEADER,
  APPS_AGENT_TOKEN_HEADER,
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

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function writeSyntheticApp(projectCwd: string, envResultPath: string): string {
  const appRoot = path.join(projectCwd, ".pi", "apps", "synthetic-app");
  fs.mkdirSync(appRoot, { recursive: true });
  const serverPath = path.join(appRoot, "server.cjs");
  fs.writeFileSync(serverPath, `
const fs = require("node:fs");
const http = require("node:http");
fs.writeFileSync(process.env.SYNTHETIC_APP_ENV_RESULT, JSON.stringify({
  appsTokenAbsent: process.env.WAYANG_APPS_AGENT_TOKEN === undefined,
  appsCapabilityAbsent: process.env.WAYANG_APPS_INTERNAL_CAPABILITY === undefined,
  browserTokenAbsent: process.env.WAYANG_BROWSER_AGENT_TOKEN === undefined,
  authSecretAbsent: process.env.WAYANG_AUTH_SESSION_SECRET === undefined,
}));
http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("synthetic-ok");
}).listen(Number(process.env.PI_APP_PORT), "127.0.0.1");
`, "utf8");
  const manifestPath = path.join(appRoot, "app.json");
  fs.writeFileSync(manifestPath, JSON.stringify({
    schemaVersion: 1,
    id: "synthetic-app",
    name: "Synthetic App",
    entry: {
      type: "managed-process",
      workingDirectory: ".pi/apps/synthetic-app",
      devCommand: `${shellQuote(process.execPath)} ${shellQuote(serverPath)}`,
      healthPath: "/",
      port: 0,
    },
  }), "utf8");
  process.env.SYNTHETIC_APP_ENV_RESULT = envResultPath;
  return path.relative(projectCwd, manifestPath);
}

test("Apps agent capability is source-attributed, target-authorized, and launch-fail-closed", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-apps-agent-auth-"));
  const project = path.join(root, "project-a");
  const protectedProject = path.join(root, "project-b");
  const envResultPath = path.join(root, "app-env-result.json");
  fs.mkdirSync(project);
  fs.mkdirSync(protectedProject);

  const environmentNames = [
    "WAYANG_DATA_DIR",
    "SYNTHETIC_APP_ENV_RESULT",
    "WAYANG_APPS_AGENT_TOKEN",
    "WAYANG_APPS_INTERNAL_CAPABILITY",
    "WAYANG_BROWSER_AGENT_TOKEN",
    "WAYANG_AUTH_SESSION_SECRET",
  ] as const;
  const previousEnvironment = new Map(environmentNames.map((name) => [name, process.env[name]]));
  process.env.WAYANG_DATA_DIR = path.join(root, "data");
  const manifestPath = writeSyntheticApp(project, envResultPath);

  init();
  const sourceProfile = createAgentProfile({ name: "Apps source", resource_mode: "standard" });
  const protectedProfile = createAgentProfile({ name: "Protected Apps source" });
  createProject({ cwd: project, default_agent_profile_id: sourceProfile.id });
  createProject({
    cwd: protectedProject,
    default_agent_profile_id: protectedProfile.id,
    access_policy: { privacy_mode: "protected", allowed_agent_profile_ids: [protectedProfile.id] },
  });
  const source = createSession(project);
  const protectedSource = createSession(protectedProject);
  const port = await availablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const authConfig: AuthConfig = {
    enabled: true,
    passwordHash: await createPasswordHash("synthetic-apps-test-password"),
    sessionSecret: "synthetic-session-secret-at-least-thirty-two-bytes",
    sessionDays: 30,
    sessionStorePath: path.join(root, "auth-sessions.json"),
    trustProxy: false,
    proxyIdentityHeader: "",
    cookieSecure: "auto",
    allowedOrigins: [baseUrl],
  };
  const { server } = createApp({ authService: new AuthService(authConfig) });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  t.after(async () => {
    await stopAllApps();
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    close();
    for (const [name, value] of previousEnvironment) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  const authorization = appsAgentAuthorizationForSourceSession(source.id);
  assert.ok(authorization);
  const agentHeaders = {
    [APPS_AGENT_ACTOR_HEADER]: "agent",
    [APPS_AGENT_TOKEN_HEADER]: authorization.token,
    [APPS_AGENT_SOURCE_SESSION_HEADER]: authorization.sourceSessionId,
  };
  const login = await fetch(`${baseUrl}/api/auth/login`, {
    method: "POST",
    headers: { Origin: baseUrl, "Content-Type": "application/json" },
    body: JSON.stringify({ password: "synthetic-apps-test-password" }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
  assert.ok(cookie);

  const unrelatedRoute = await fetch(`${baseUrl}/api/me`, { headers: agentHeaders });
  assert.equal(unrelatedRoute.status, 401, "Apps capability must not bypass unrelated API auth");

  const forgedSource = await fetch(`${baseUrl}/api/apps?${new URLSearchParams({ project_cwd: project, scan: "0" })}`, {
    headers: {
      ...agentHeaders,
      [APPS_AGENT_SOURCE_SESSION_HEADER]: protectedSource.id,
    },
  });
  assert.equal(forgedSource.status, 401);
  assert.equal(forgedSource.headers.get("cache-control"), "no-store");

  const register = await fetch(`${baseUrl}/api/apps/register`, {
    method: "POST",
    headers: { ...agentHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ projectCwd: project, sessionId: source.id, manifestPath }),
  });
  assert.equal(register.status, 201);
  assert.equal(fs.existsSync(envResultPath), false, "registration must not launch app code");

  const ownList = await fetch(`${baseUrl}/api/apps?${new URLSearchParams({ project_cwd: project, scan: "0" })}`, { headers: agentHeaders });
  assert.equal(ownList.status, 200);
  assert.equal(fs.existsSync(envResultPath), false, "listing must not launch app code");

  const protectedQuery = `${baseUrl}/api/apps?${new URLSearchParams({ project_cwd: protectedProject, scan: "0" })}`;
  const crossProject = await fetch(protectedQuery, { headers: agentHeaders });
  assert.equal(crossProject.status, 403);
  const protectedAuthorization = appsAgentAuthorizationForSourceSession(protectedSource.id);
  assert.ok(protectedAuthorization);
  const authorizedProtectedList = await fetch(protectedQuery, {
    headers: {
      [APPS_AGENT_ACTOR_HEADER]: "agent",
      [APPS_AGENT_TOKEN_HEADER]: protectedAuthorization.token,
      [APPS_AGENT_SOURCE_SESSION_HEADER]: protectedAuthorization.sourceSessionId,
    },
  });
  assert.equal(authorizedProtectedList.status, 200, "an allowlisted protected-project source retains non-launch operations");

  const updateState = await fetch(`${baseUrl}/api/apps/synthetic-app/state`, {
    method: "PUT",
    headers: { ...agentHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ projectCwd: project, sessionId: source.id, state: { synthetic: true } }),
  });
  assert.equal(updateState.status, 200);
  assert.equal(fs.existsSync(envResultPath), false, "state updates must not launch app code");

  const agentStart = await fetch(`${baseUrl}/api/apps/synthetic-app/start`, {
    method: "POST",
    headers: { ...agentHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ projectCwd: project, sessionId: source.id }),
  });
  assert.equal(agentStart.status, 403);
  assert.match((await agentStart.json() as { error: string }).error, /start\/restart is disabled.*protected project.*manually/is);
  assert.equal(fs.existsSync(envResultPath), false, "denied agent start must not launch app code");

  process.env.WAYANG_APPS_AGENT_TOKEN = "synthetic-apps-token";
  process.env.WAYANG_APPS_INTERNAL_CAPABILITY = "synthetic-apps-capability";
  process.env.WAYANG_BROWSER_AGENT_TOKEN = "synthetic-browser-token";
  process.env.WAYANG_AUTH_SESSION_SECRET = "synthetic-auth-secret";
  const manualStart = await fetch(`${baseUrl}/api/apps/synthetic-app/start`, {
    method: "POST",
    headers: { Origin: baseUrl, Cookie: cookie, "Content-Type": "application/json" },
    body: JSON.stringify({ projectCwd: project, sessionId: source.id }),
  });
  assert.equal(manualStart.status, 200);
  assert.equal((await manualStart.json() as { status: string }).status, "running");
  assert.deepEqual(JSON.parse(fs.readFileSync(envResultPath, "utf8")), {
    appsTokenAbsent: true,
    appsCapabilityAbsent: true,
    browserTokenAbsent: true,
    authSecretAbsent: true,
  });

  const deniedRestart = await fetch(`${baseUrl}/api/apps/synthetic-app/restart`, {
    method: "POST",
    headers: { ...agentHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ projectCwd: project, sessionId: source.id }),
  });
  assert.equal(deniedRestart.status, 403);
  const stillRunning = await fetch(`${baseUrl}/api/apps/synthetic-app?${new URLSearchParams({ project_cwd: project })}`, { headers: agentHeaders });
  assert.equal((await stillRunning.json() as { status: string }).status, "running", "denied restart must not stop the app");

  const agentStop = await fetch(`${baseUrl}/api/apps/synthetic-app/stop`, {
    method: "POST",
    headers: { ...agentHeaders, "Content-Type": "application/json" },
    body: JSON.stringify({ projectCwd: project, sessionId: source.id }),
  });
  assert.equal(agentStop.status, 200);
  assert.equal((await agentStop.json() as { status: string }).status, "stopped");
});
