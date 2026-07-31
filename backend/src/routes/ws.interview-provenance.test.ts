import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import test from "node:test";
import { WebSocket } from "ws";
import { createApp, closeWayangServer } from "../app.js";
import { AuthService } from "../auth/service.js";
import { createPasswordHash } from "../auth/password.js";
import type { AuthConfig } from "../config.js";
import { close, init } from "../db.js";
import { getInterviewBridge } from "../interview-bridge.js";
import {
  WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL,
  WAYANG_WEBSOCKET_SUBMISSION_CHANNEL,
} from "../interview-provenance.js";
import { getInterviewForSession } from "../interviews.js";
import { createSession } from "../sessions.js";

const QUESTIONS = [{
  id: "q1",
  label: "Scope",
  prompt: "Which scope?",
  options: [{ value: "small", label: "Small" }],
  allowOther: true,
}];

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

function cookieFrom(response: Response): string {
  const value = response.headers.get("set-cookie");
  assert.ok(value);
  return value.split(";", 1)[0]!;
}

async function expectRejectedUpgrade(url: string, headers: Record<string, string>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(url, { headers });
    ws.once("unexpected-response", (_request, response) => {
      try {
        assert.equal(response.statusCode, 401);
        response.resume();
        resolve();
      } catch (error) {
        reject(error);
      }
    });
    ws.once("open", () => reject(new Error("unauthenticated questionnaire WebSocket unexpectedly opened")));
    ws.once("error", () => undefined);
  });
}

function messageInbox(ws: WebSocket) {
  const queued: unknown[] = [];
  const waiters: Array<(message: unknown) => void> = [];
  ws.on("message", (raw) => {
    const message = JSON.parse(raw.toString()) as unknown;
    const waiter = waiters.shift();
    if (waiter) waiter(message);
    else queued.push(message);
  });

  const next = (): Promise<unknown> => {
    const message = queued.shift();
    if (message !== undefined) return Promise.resolve(message);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error("timed out waiting for WebSocket message")), 5_000);
      waiters.push((value) => {
        clearTimeout(timer);
        resolve(value);
      });
    });
  };

  return async (predicate: (message: any) => boolean): Promise<any> => {
    for (;;) {
      const message = await next();
      if (predicate(message)) return message;
    }
  };
}

test("authorized questionnaire WebSocket derives omitted provenance and ignores client forgeries", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-ws-interview-provenance-"));
  const dataDir = path.join(root, "data");
  const projectDir = path.join(root, "project");
  fs.mkdirSync(projectDir, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dataDir;

  let server: ReturnType<typeof createApp>["server"] | undefined;
  let ws: WebSocket | undefined;
  try {
    init();
    const session = createSession(projectDir, { title: "provenance route test" });
    const bridge = getInterviewBridge();
    const requestIds: string[] = [];
    const stopCapture = bridge.onRequest((request) => {
      if (request.sessionId === session.id) requestIds.push(request.requestId);
    });
    const missingPayloadWaiter = bridge.createRequestWithOutcome(session.id, QUESTIONS, { toolName: "questionnaire", timeoutMs: 5_000 });
    const forgedPayloadWaiter = bridge.createRequestWithOutcome(session.id, QUESTIONS, { toolName: "questionnaire", timeoutMs: 5_000 });
    stopCapture();
    assert.equal(requestIds.length, 2);

    const port = await availablePort();
    const baseUrl = `http://127.0.0.1:${port}`;
    const config: AuthConfig = {
      enabled: true,
      passwordHash: await createPasswordHash("synthetic route-test password"),
      sessionSecret: "synthetic-route-test-session-secret-32-bytes",
      sessionDays: 1,
      sessionStorePath: path.join(dataDir, "auth-sessions.json"),
      trustProxy: "loopback",
      proxyIdentityHeader: "",
      cookieSecure: "auto",
      allowedOrigins: [baseUrl],
    };
    const app = createApp({ authService: new AuthService(config, { failureDelayMs: 0 }) });
    server = app.server;
    await new Promise<void>((resolve, reject) => {
      server!.once("error", reject);
      server!.listen(port, "127.0.0.1", resolve);
    });

    const wsUrl = `ws://127.0.0.1:${port}/ws/chat?session_id=${encodeURIComponent(session.id)}`;
    await expectRejectedUpgrade(wsUrl, { Origin: baseUrl });
    assert.equal(getInterviewForSession(session.id, requestIds[0]!)?.status, "open");

    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: baseUrl },
      body: JSON.stringify({ password: "synthetic route-test password" }),
    });
    assert.equal(login.status, 200);

    ws = new WebSocket(wsUrl, { headers: { Origin: baseUrl, Cookie: cookieFrom(login) } });
    const untilMessage = messageInbox(ws);
    await new Promise<void>((resolve, reject) => {
      ws!.once("open", resolve);
      ws!.once("error", reject);
    });
    await untilMessage((message) => message.type === "session_ready" && message.session_id === session.id);

    ws.send(JSON.stringify({
      type: "interview_response",
      requestId: requestIds[0],
      answers: [{ id: "q1", value: "small", wasCustom: false }],
    }));
    const missingAck = await untilMessage((message) => message.type === "interview_response_ack" && message.requestId === requestIds[0]);
    assert.equal(missingAck.status, "delivered");
    assert.equal((await missingPayloadWaiter).status, "submitted");

    ws.send(JSON.stringify({
      type: "interview_response",
      requestId: requestIds[1],
      answers: [{ id: "q1", value: "small", wasCustom: false }],
      submission_channel: "FORGED_CLIENT_CHANNEL",
      authenticated_principal: "FORGED_CLIENT_PRINCIPAL",
    }));
    const forgedAck = await untilMessage((message) => message.type === "interview_response_ack" && message.requestId === requestIds[1]);
    assert.equal(forgedAck.status, "delivered");
    assert.equal((await forgedPayloadWaiter).status, "submitted");

    for (const requestId of requestIds) {
      const record = getInterviewForSession(session.id, requestId);
      assert.equal(record?.submission_channel, WAYANG_WEBSOCKET_SUBMISSION_CHANNEL);
      assert.equal(record?.authenticated_principal, WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL);
    }
  } finally {
    if (ws) {
      ws.terminate();
      ws = undefined;
    }
    if (server) await closeWayangServer(server);
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});
