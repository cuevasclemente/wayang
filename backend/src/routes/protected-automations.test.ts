import assert from "node:assert/strict";
import * as http from "node:http";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { WebSocket } from "ws";
import { AuthService } from "../auth/service.js";
import { closeWayangServer, createApp } from "../app.js";
import type { AuthConfig } from "../config.js";
import type { ProtectedAutomationProductionIntegration } from "../protected-automation/production.js";

async function freePort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  const address = server.address();
  const port = address && typeof address !== "string" ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

function integration(): ProtectedAutomationProductionIntegration {
  return {
    listJobs: () => [],
    getJob: () => { throw Object.assign(new Error("Protected automation job not found"), { statusCode: 404 }); },
    listRuns: () => [],
    pauseJob: (_owner, jobId, expectedRevision) => ({
      id: jobId, revision: expectedRevision + 1, enabled: false, blocked_reason: "paused",
      activationAvailable: false,
    } as any),
    cancelRun: (_owner, jobId, runId) => ({
      id: runId, job_id: jobId, project_id: "project", agent_profile_id: "profile", status: "cancelled",
    } as any),
    getPreparation: (_owner, selection) => ({
      preparation_id: selection.preparationId, source_session_id: selection.sourceSessionId,
      job_id: selection.jobId, job_revision: 4, state: "ready", websocket_path: "/dedicated",
      project_id: "project", agent_profile_id: "profile", capability_revision: 2, source_revision: 3,
      allowed_https_origins: ["https://example.test"], credential_broker: { supported: true, guarded: true },
    }),
    closePreparation: async () => undefined,
    openPreparationViewer: async () => { throw new Error("not used"); },
    navigatePreparation: async (_owner, selection) => ({
      preparation_id: selection.preparationId, source_session_id: selection.sourceSessionId,
      job_id: selection.jobId, job_revision: 4, state: "ready", websocket_path: "/dedicated",
      project_id: "project", agent_profile_id: "profile", capability_revision: 2, source_revision: 3,
      allowed_https_origins: ["https://example.test"], credential_broker: { supported: true, guarded: true },
    }),
    credentialStatus: async () => ({ available: true, unlocked: false, origin: null }),
    credentialMatches: async () => ({ origin: "https://example.test", choices: [] }),
    credentialFill: async () => ({ filled: ["password"] }),
    credentialLock: async () => undefined,
    requestPurge: async (_owner, jobId, expectedRevision) => ({ request_id: "request", job_id: jobId,
      expected_revision: expectedRevision, operation_digest: "a".repeat(64), expires_at: Date.now() + 10_000, summary: "synthetic" }),
    commitPurge: async (_owner, jobId) => ({ purged_job_id: jobId, purged_run_ids: [] }),
    cancelPurge: async () => undefined,
  };
}

function bounded<T>(promise: Promise<T>, label: string, timeoutMs = 2_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} exceeded ${timeoutMs}ms`)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

test("automation metadata/control routes require an exact allowed Origin and retain dedicated preparation IDs", async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const authConfig: AuthConfig = {
    enabled: false, passwordHash: "", sessionSecret: "synthetic-session-secret-at-least-32-bytes",
    sessionDays: 1, sessionStorePath: path.join(os.tmpdir(), `wayang-auth-${port}.json`),
    trustProxy: false, proxyIdentityHeader: "", cookieSecure: "never", allowedOrigins: [origin],
  };
  const auth = new AuthService(authConfig);
  const { server } = createApp({
    config: { port, host: "127.0.0.1", auth: authConfig },
    authService: auth,
    protectedAutomation: integration(),
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  try {
    const hostile = await fetch(`${origin}/api/protected-automations/status`, { headers: { Origin: "https://hostile.example" } });
    assert.equal(hostile.status, 403);
    const status = await fetch(`${origin}/api/protected-automations/status`, { headers: { Origin: origin } });
    assert.equal(status.status, 200);
    assert.equal((await status.json() as any).activationAvailable, true);

    const exactPath = `${origin}/api/protected-automations/sources/source-a/jobs/job-a/preparations/preparation-a`;
    const metadata = await fetch(exactPath, { headers: { Origin: origin } });
    assert.equal(metadata.status, 200);
    const state = await metadata.json() as any;
    assert.deepEqual([state.source_session_id, state.job_id, state.preparation_id], ["source-a", "job-a", "preparation-a"]);

    const pause = await fetch(`${origin}/api/protected-automations/jobs/job-a/pause`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7 }),
    });
    assert.equal(pause.status, 200);
    assert.deepEqual(await pause.json() as any, { job: {
      id: "job-a", revision: 8, enabled: false, blocked_reason: "paused", activationAvailable: false,
    } });
    const pauseSmuggled = await fetch(`${origin}/api/protected-automations/jobs/job-a/pause`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7, enable: true }),
    });
    assert.equal(pauseSmuggled.status, 400);

    const cancel = await fetch(`${origin}/api/protected-automations/jobs/job-a/runs/run-a/cancel`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(cancel.status, 200);
    assert.deepEqual(await cancel.json() as any, { run: {
      id: "run-a", job_id: "job-a", project_id: "project", agent_profile_id: "profile", status: "cancelled",
    } });
    const cancelSmuggled = await fetch(`${origin}/api/protected-automations/jobs/job-a/runs/run-a/cancel`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ expectedRevision: 7 }),
    });
    assert.equal(cancelSmuggled.status, 400);
    const cancelMissingBody = await fetch(`${origin}/api/protected-automations/jobs/job-a/runs/run-a/cancel`, {
      method: "POST", headers: { Origin: origin },
    });
    assert.equal(cancelMissingBody.status, 400);
    const ownerEnable = await fetch(`${origin}/api/protected-automations/jobs/job-a/enable`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" }, body: "{}",
    });
    assert.equal(ownerEnable.status, 404);

    const navigate = await fetch(`${exactPath}/navigate`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.test/login" }),
    });
    assert.equal(navigate.status, 200);
    const smuggled = await fetch(`${exactPath}/navigate`, {
      method: "POST", headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://example.test/login", project_cwd: "/forged" }),
    });
    assert.equal(smuggled.status, 400);
  } finally {
    await closeWayangServer(server as http.Server);
  }
});

test("closeWayangServer terminates an upgraded preparation socket and closes its viewer transport boundedly", async () => {
  const port = await freePort();
  const origin = `http://127.0.0.1:${port}`;
  const authConfig: AuthConfig = {
    enabled: false, passwordHash: "", sessionSecret: "synthetic-session-secret-at-least-32-bytes",
    sessionDays: 1, sessionStorePath: path.join(os.tmpdir(), `wayang-ws-auth-${port}.json`),
    trustProxy: false, proxyIdentityHeader: "", cookieSecure: "never", allowedOrigins: [origin],
  };
  const auth = new AuthService(authConfig);
  const bridge = integration();
  let viewerCloseCount = 0;
  let viewerOpenedResolve!: () => void;
  let viewerClosedResolve!: () => void;
  const viewerOpened = new Promise<void>((resolve) => { viewerOpenedResolve = resolve; });
  const viewerClosed = new Promise<void>((resolve) => { viewerClosedResolve = resolve; });
  bridge.openPreparationViewer = async () => {
    let closed = false;
    viewerOpenedResolve();
    return {
      async dispatch() {},
      async close() {
        if (closed) return;
        closed = true;
        viewerCloseCount += 1;
        viewerClosedResolve();
      },
      onMessage() { return () => undefined; },
    };
  };
  const { server } = createApp({
    config: { port, host: "127.0.0.1", auth: authConfig },
    authService: auth,
    protectedAutomation: bridge,
  });
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", resolve); });
  const socket = new WebSocket(
    `ws://127.0.0.1:${port}/ws/protected-automations/preparations/preparation-a?source_session_id=source-a&job_id=job-a`,
    { headers: { Origin: origin } },
  );
  const socketOpened = new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  const socketClosed = new Promise<void>((resolve) => socket.once("close", () => resolve()));
  try {
    await bounded(socketOpened, "preparation WebSocket upgrade");
    await bounded(viewerOpened, "preparation viewer opening");
    assert.equal(socket.readyState, WebSocket.OPEN);

    await bounded(closeWayangServer(server as http.Server), "Wayang server shutdown");
    await bounded(Promise.all([socketClosed, viewerClosed]).then(() => undefined), "preparation transport shutdown");
    assert.equal(viewerCloseCount, 1, "the held viewer transport is closed exactly once");
    assert.equal(socket.readyState, WebSocket.CLOSED);
  } finally {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) socket.terminate();
    await closeWayangServer(server as http.Server).catch(() => undefined);
  }
});
