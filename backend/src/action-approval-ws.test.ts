import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { createServer as createNetServer, type AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { WebSocket } from "ws";
import {
  PiActionApprovalBridge,
  type ApprovalDecision,
  type ApprovalResponse,
  type ExternalActionRequestInput,
} from "./action-approval-bridge.js";
import { closeWayangServer, createApp } from "./app.js";
import { AuthService } from "./auth/service.js";
import { close, commitStoreMutation, init } from "./db.js";
import type {
  ReservePinAttemptResult,
  SettingsPinAttemptPort,
  VerifyPinAttemptResult,
} from "./workspace-capability-approval/types.js";
import { stopPiSession } from "./pi-bridge.js";
import { createSession } from "./sessions.js";

interface ServerMessage {
  type: string;
  [key: string]: unknown;
}

const SYNTHETIC_IDENTITY_PIN = "12345678";

class SyntheticPinAttemptPort implements SettingsPinAttemptPort {
  readonly reserves: Parameters<SettingsPinAttemptPort["reserve"]>[0][] = [];
  readonly verifications: Parameters<SettingsPinAttemptPort["verifyAndConsume"]>[0][] = [];
  readonly cancellations: Parameters<SettingsPinAttemptPort["cancelAndConsume"]>[0][] = [];

  async reserve(input: Parameters<SettingsPinAttemptPort["reserve"]>[0]): Promise<ReservePinAttemptResult> {
    this.reserves.push({ ...input });
    return { status: "reserved" };
  }

  async verifyAndConsume(
    input: Parameters<SettingsPinAttemptPort["verifyAndConsume"]>[0],
  ): Promise<VerifyPinAttemptResult> {
    this.verifications.push({ ...input });
    return input.pin === SYNTHETIC_IDENTITY_PIN
      ? { status: "verified" }
      : { status: "wrong_pin" };
  }

  async cancelAndConsume(
    input: Parameters<SettingsPinAttemptPort["cancelAndConsume"]>[0],
  ): Promise<void> {
    this.cancellations.push({ ...input });
  }
}

class CountingActionApprovalBridge extends PiActionApprovalBridge {
  responseCalls = 0;
  private readonly attachedClients = new Map<string, number>();

  constructor(readonly syntheticPinAttempts: SyntheticPinAttemptPort) {
    super(syntheticPinAttempts);
  }

  override attachClient(sessionId: string, clientId: string): () => void {
    const detach = super.attachClient(sessionId, clientId);
    this.attachedClients.set(sessionId, (this.attachedClients.get(sessionId) ?? 0) + 1);
    let detached = false;
    return () => {
      if (detached) return;
      detached = true;
      detach();
      const count = (this.attachedClients.get(sessionId) ?? 1) - 1;
      if (count === 0) this.attachedClients.delete(sessionId);
      else this.attachedClients.set(sessionId, count);
    };
  }

  attachedClientCount(sessionId: string): number {
    return this.attachedClients.get(sessionId) ?? 0;
  }

  override async respondForSession(
    sessionId: string,
    requestId: string,
    argumentsHash: string,
    approved: unknown,
    pin?: unknown,
  ): Promise<ApprovalResponse> {
    this.responseCalls += 1;
    return super.respondForSession(sessionId, requestId, argumentsHash, approved, pin);
  }
}

class MessageInbox {
  private readonly messages: ServerMessage[] = [];
  private readonly waiters = new Set<{
    predicate: (message: ServerMessage) => boolean;
    resolve: (message: ServerMessage) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(ws: WebSocket) {
    ws.on("message", (raw) => {
      let message: ServerMessage;
      try {
        message = JSON.parse(raw.toString()) as ServerMessage;
      } catch {
        return;
      }
      for (const waiter of this.waiters) {
        if (!waiter.predicate(message)) continue;
        this.waiters.delete(waiter);
        clearTimeout(waiter.timer);
        waiter.resolve(message);
        return;
      }
      this.messages.push(message);
    });
  }

  take(predicate: (message: ServerMessage) => boolean, timeoutMs = 3_000): Promise<ServerMessage> {
    const index = this.messages.findIndex(predicate);
    if (index !== -1) return Promise.resolve(this.messages.splice(index, 1)[0]);

    return new Promise((resolve, reject) => {
      const waiter = {
        predicate,
        resolve,
        reject,
        timer: setTimeout(() => {
          this.waiters.delete(waiter);
          reject(new Error(`Timed out waiting for WebSocket message; buffered types: ${this.messages.map((message) => message.type).join(", ")}`));
        }, timeoutMs),
      };
      this.waiters.add(waiter);
    });
  }
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

async function connectChat(
  wsBaseUrl: string,
  origin: string,
  sessionId: string,
  selectionId: string | null,
): Promise<{ ws: WebSocket; inbox: MessageInbox }> {
  const url = `${wsBaseUrl}/ws/chat?session_id=${encodeURIComponent(sessionId)}${selectionId ? `&selection_id=${encodeURIComponent(selectionId)}` : ""}`;
  const ws = new WebSocket(url, { headers: { Origin: origin } });
  const inbox = new MessageInbox(ws);
  await new Promise<void>((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
    ws.once("unexpected-response", (_request, response) => {
      response.resume();
      reject(new Error(`WebSocket rejected with ${response.statusCode}`));
    });
  });
  return { ws, inbox };
}

async function closeSocket(ws: WebSocket): Promise<void> {
  if (ws.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    ws.once("close", () => resolve());
    ws.close();
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.ok(predicate(), "condition did not become true before timeout");
}

function actionInput(hashLabel: string): ExternalActionRequestInput {
  return {
    connector: "synthetic-connector",
    workspace: "synthetic-workspace",
    toolName: "create_synthetic_record",
    target: "synthetic-target",
    summary: "Synthetic full action preview; must not be logged",
    argumentsHash: createHash("sha256").update(hashLabel).digest("hex"),
  };
}

function isSnapshotFor(sessionId: string, selectionId: string, requestCount?: number) {
  return (message: ServerMessage): boolean => (
    message.type === "external_action_snapshot"
    && message.sessionId === sessionId
    && message.selection_id === selectionId
    && message.syncComplete === true
    && (requestCount === undefined || (Array.isArray(message.requests) && message.requests.length === requestCount))
  );
}

function isRequest(requestId: string, sessionId: string, selectionId: string) {
  return (message: ServerMessage): boolean => (
    message.type === "external_action_request"
    && message.requestId === requestId
    && message.sessionId === sessionId
    && message.selection_id === selectionId
  );
}

function isAck(requestId: string, status: string, sessionId: string, selectionId: string) {
  return (message: ServerMessage): boolean => (
    message.type === "external_action_response_ack"
    && message.requestId === requestId
    && message.status === status
    && message.sessionId === sessionId
    && message.selection_id === selectionId
  );
}

function isTerminal(requestId: string, status: string, sessionId: string, selectionId: string) {
  return (message: ServerMessage): boolean => (
    message.type === "external_action_terminal"
    && message.requestId === requestId
    && message.status === status
    && message.sessionId === sessionId
    && message.selection_id === selectionId
  );
}

function isResolutionFrame(requestId: string, sessionId: string, selectionId: string) {
  return (message: ServerMessage): boolean => (
    (message.type === "external_action_terminal"
      && message.requestId === requestId
      && message.sessionId === sessionId
      && message.selection_id === selectionId)
    || isSnapshotFor(sessionId, selectionId)(message)
    || (message.type === "external_action_response_ack"
      && message.requestId === requestId
      && message.sessionId === sessionId
      && message.selection_id === selectionId)
  );
}

async function fixture(t: TestContext) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-action-ws-"));
  const sharedCwd = path.join(dataDir, "shared-project");
  fs.mkdirSync(sharedCwd, { recursive: true });
  const previousDataDir = process.env.WAYANG_DATA_DIR;
  process.env.WAYANG_DATA_DIR = dataDir;

  const pinAttempts = new SyntheticPinAttemptPort();
  const bridge = new CountingActionApprovalBridge(pinAttempts);
  (globalThis as typeof globalThis & { __pi_action_approval_bridge?: PiActionApprovalBridge }).__pi_action_approval_bridge = bridge;
  init();
  const interactiveSession = createSession(sharedCwd, "interactive action session");
  const otherSession = createSession(sharedCwd, "other action session");
  const headlessSession = createSession(sharedCwd, "headless scheduled action session");
  const quarantinedSession = createSession(sharedCwd, "quarantined legacy action session");
  commitStoreMutation((draft) => {
    const row = draft.sessions.find((candidate) => candidate.id === quarantinedSession.id);
    assert.ok(row);
    row.legacy_private_session_quarantine = true;
  });

  const port = await availablePort();
  const origin = `http://127.0.0.1:${port}`;
  const auth = new AuthService({
    enabled: false,
    passwordHash: "",
    sessionSecret: "",
    sessionDays: 30,
    sessionStorePath: path.join(dataDir, "auth-sessions.json"),
    trustProxy: "loopback",
    proxyIdentityHeader: "",
    cookieSecure: "auto",
    allowedOrigins: [origin],
  });
  const { server } = createApp({
    authService: auth,
    config: { port, host: "127.0.0.1", dataDir },
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const sockets = new Set<WebSocket>();
  t.after(async () => {
    bridge.cancelSession(interactiveSession.id, "test cleanup");
    bridge.cancelSession(otherSession.id, "test cleanup");
    bridge.cancelSession(headlessSession.id, "test cleanup");
    bridge.cancelSession(quarantinedSession.id, "test cleanup");
    for (const ws of sockets) {
      try { ws.terminate(); } catch {}
    }
    await closeWayangServer(server);
    close();
    if (previousDataDir === undefined) delete process.env.WAYANG_DATA_DIR;
    else process.env.WAYANG_DATA_DIR = previousDataDir;
    delete (globalThis as typeof globalThis & { __pi_action_approval_bridge?: PiActionApprovalBridge }).__pi_action_approval_bridge;
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const connect = async (sessionId: string, selectionId: string | null) => {
    const connection = await connectChat(`ws://127.0.0.1:${port}`, origin, sessionId, selectionId);
    sockets.add(connection.ws);
    connection.ws.once("close", () => sockets.delete(connection.ws));
    return connection;
  };

  return {
    bridge,
    pinAttempts,
    interactiveSession,
    otherSession,
    headlessSession,
    quarantinedSession,
    connect,
  };
}

function withoutField(packet: Record<string, unknown>, field: string): Record<string, unknown> {
  return Object.fromEntries(Object.entries(packet).filter(([key]) => key !== field));
}

test("closing the sole chat socket detaches the old session approval client", async (t) => {
  const { bridge, interactiveSession, connect } = await fixture(t);
  const client = await connect(interactiveSession.id, "selection-close-detach");
  await client.inbox.take(isSnapshotFor(interactiveSession.id, "selection-close-detach", 0));
  assert.equal(bridge.attachedClientCount(interactiveSession.id), 1);
  assert.equal(bridge.hasClient(interactiveSession.id), true);

  await closeSocket(client.ws);
  await waitUntil(() => bridge.attachedClientCount(interactiveSession.id) === 0);
  assert.equal(bridge.attachedClientCount(interactiveSession.id), 0);
  assert.equal(bridge.hasClient(interactiveSession.id), false);
});

test("a quarantined session socket never becomes an external-action approval client", async (t) => {
  const { bridge, pinAttempts, quarantinedSession, connect } = await fixture(t);
  const selectionId = "selection-quarantined";
  const client = await connect(quarantinedSession.id, selectionId);
  await client.inbox.take((message) => (
    message.type === "session_ready"
    && message.session_id === quarantinedSession.id
    && message.selection_id === selectionId
  ));

  await waitUntil(() => bridge.attachedClientCount(quarantinedSession.id) === 0);
  assert.equal(bridge.hasClient(quarantinedSession.id), false);
  const quarantinedInput = actionInput("sha256:quarantined");
  assert.deepEqual(await bridge.requestApproval(quarantinedSession.id, quarantinedInput), {
    status: "denied",
    requestId: null,
    sessionId: quarantinedSession.id,
    argumentsHash: quarantinedInput.argumentsHash,
  } satisfies ApprovalDecision);
  assert.deepEqual(bridge.getPendingRequests(quarantinedSession.id), []);
  assert.equal(pinAttempts.reserves.length, 0);
  assert.equal(pinAttempts.verifications.length, 0);
});

test("external action responses do not default a missing session identity", async (t) => {
  const { bridge, pinAttempts, interactiveSession, connect } = await fixture(t);
  const selectionId = "selection-missing-session";
  const client = await connect(interactiveSession.id, selectionId);
  await client.inbox.take(isSnapshotFor(interactiveSession.id, selectionId, 0));

  const pending = bridge.requestApproval(
    interactiveSession.id,
    actionInput("sha256:missing-session"),
    { timeoutMs: 5_000 },
  );
  const [request] = bridge.getPendingRequests(interactiveSession.id);
  assert.ok(request);
  await client.inbox.take(isRequest(request.requestId, interactiveSession.id, selectionId));

  client.ws.send(JSON.stringify({
    type: "external_action_response",
    requestId: request.requestId,
    selection_id: selectionId,
    argumentsHash: request.argumentsHash,
    approved: true,
  }));
  const ack = await client.inbox.take((message) => message.type === "external_action_response_ack");
  assert.equal(ack.status, "rejected");
  assert.equal(ack.sessionId, null);
  assert.equal(bridge.responseCalls, 0);
  assert.equal(pinAttempts.reserves.length, 0);
  assert.equal(pinAttempts.verifications.length, 0);
  assert.equal(bridge.getPendingRequests(interactiveSession.id).length, 1);

  bridge.cancelRequest(request.requestId, "test cleanup");
  assert.equal((await pending).status, "cancelled");
});

test("external action responses validate every identity field and decision before bridge dispatch", async (t) => {
  const identityFields = ["requestId", "sessionId", "selection_id", "argumentsHash"] as const;
  const malformedCases: Array<{ name: string; mutate: (packet: Record<string, unknown>) => Record<string, unknown> }> = [];
  for (const field of identityFields) {
    malformedCases.push(
      { name: `missing ${field}`, mutate: (packet) => withoutField(packet, field) },
      { name: `non-string ${field}`, mutate: (packet) => ({ ...packet, [field]: 42 }) },
    );
  }
  malformedCases.push(
    { name: "missing approved", mutate: (packet) => withoutField(packet, "approved") },
    { name: "non-boolean approved", mutate: (packet) => ({ ...packet, approved: "true" }) },
  );

  for (const malformedCase of malformedCases) {
    await t.test(malformedCase.name, async (t) => {
      const { bridge, pinAttempts, interactiveSession, connect } = await fixture(t);
      const selectionId = `selection-${malformedCase.name.replaceAll(" ", "-")}`;
      const client = await connect(interactiveSession.id, selectionId);
      await client.inbox.take(isSnapshotFor(interactiveSession.id, selectionId, 0));

      const pending = bridge.requestApproval(
        interactiveSession.id,
        actionInput(`sha256:${malformedCase.name}`),
        { timeoutMs: 5_000 },
      );
      const [request] = bridge.getPendingRequests(interactiveSession.id);
      assert.ok(request);
      await client.inbox.take(isRequest(request.requestId, interactiveSession.id, selectionId));

      const validPacket: Record<string, unknown> = {
        type: "external_action_response",
        requestId: request.requestId,
        sessionId: request.sessionId,
        selection_id: selectionId,
        argumentsHash: request.argumentsHash,
        approved: true,
      };
      client.ws.send(JSON.stringify(malformedCase.mutate(validPacket)));
      const ack = await client.inbox.take((message) => message.type === "external_action_response_ack");
      assert.equal(ack.status, "rejected", malformedCase.name);
      assert.equal(bridge.responseCalls, 0, malformedCase.name);
      assert.equal(pinAttempts.reserves.length, 0, malformedCase.name);
      assert.equal(pinAttempts.verifications.length, 0, malformedCase.name);
      assert.equal(bridge.getPendingRequests(interactiveSession.id).length, 1, malformedCase.name);

      bridge.cancelRequest(request.requestId, "test cleanup");
      assert.equal((await pending).status, "cancelled");
    });
  }
});

test("approved WebSocket responses deny and consume wrong or missing PIN attempts", async (t) => {
  for (const pinCase of [
    { name: "missing PIN", pin: undefined, adapterPin: "" },
    { name: "wrong PIN", pin: "87654321", adapterPin: "87654321" },
  ] as const) {
    await t.test(pinCase.name, async (t) => {
      const { bridge, pinAttempts, interactiveSession, connect } = await fixture(t);
      const selectionId = `selection-${pinCase.name.replaceAll(" ", "-")}`;
      const client = await connect(interactiveSession.id, selectionId);
      await client.inbox.take(isSnapshotFor(interactiveSession.id, selectionId, 0));

      const pending = bridge.requestApproval(
        interactiveSession.id,
        actionInput(`sha256:${pinCase.name}`),
        { timeoutMs: 5_000 },
      );
      const [request] = bridge.getPendingRequests(interactiveSession.id);
      assert.ok(request);
      await client.inbox.take(isRequest(request.requestId, request.sessionId, selectionId));

      client.ws.send(JSON.stringify({
        type: "external_action_response",
        requestId: request.requestId,
        sessionId: request.sessionId,
        selection_id: selectionId,
        argumentsHash: request.argumentsHash,
        approved: true,
        ...(pinCase.pin === undefined ? {} : { pin: pinCase.pin }),
      }));

      assert.deepEqual(await pending, {
        status: "denied",
        requestId: request.requestId,
        sessionId: request.sessionId,
        argumentsHash: request.argumentsHash,
      } satisfies ApprovalDecision);
      assert.equal(bridge.responseCalls, 1);
      assert.equal(pinAttempts.reserves.length, 1);
      assert.equal(pinAttempts.reserves[0].realm, "wayang.external-actions.v1");
      assert.deepEqual(pinAttempts.verifications.map((attempt) => attempt.pin), [pinCase.adapterPin]);
      assert.deepEqual(bridge.getPendingRequests(interactiveSession.id), []);

      const terminal = await client.inbox.take(isResolutionFrame(
        request.requestId,
        request.sessionId,
        selectionId,
      ));
      assert.ok(isTerminal(request.requestId, "denied", request.sessionId, selectionId)(terminal));
      const snapshot = await client.inbox.take(isResolutionFrame(
        request.requestId,
        request.sessionId,
        selectionId,
      ));
      assert.ok(isSnapshotFor(request.sessionId, selectionId, 0)(snapshot));
      const ack = await client.inbox.take(isResolutionFrame(
        request.requestId,
        request.sessionId,
        selectionId,
      ));
      assert.ok(isAck(request.requestId, "denied", request.sessionId, selectionId)(ack));
      assert.equal(ack.errorCode, "wrong_pin");
    });
  }
});

test("external action WebSocket transport is reconnect-safe and exact-session fail-closed", async (t) => {
  const { bridge, pinAttempts, interactiveSession, otherSession, headlessSession, connect } = await fixture(t);
  const firstSelection = "selection-first-tab";
  const secondSelection = "selection-second-tab";
  const first = await connect(interactiveSession.id, firstSelection);
  await first.inbox.take(isSnapshotFor(interactiveSession.id, firstSelection, 0));
  assert.equal(bridge.hasClient(interactiveSession.id), true);
  assert.equal(bridge.attachedClientCount(interactiveSession.id), 1);

  // Sharing a cwd is never enough to make a scheduled/headless session interactive.
  const headlessInput = actionInput("sha256:headless-same-cwd");
  assert.deepEqual(await bridge.requestApproval(headlessSession.id, headlessInput), {
    status: "denied",
    requestId: null,
    sessionId: headlessSession.id,
    argumentsHash: headlessInput.argumentsHash,
  } satisfies ApprovalDecision);
  assert.deepEqual(bridge.getPendingRequests(headlessSession.id), []);

  // A legacy/invalid socket without a selection generation is not an exact
  // interactive approver, even when it names a real session.
  const selectionless = await connect(otherSession.id, null);
  await selectionless.inbox.take((message) => message.type === "session_ready" && message.session_id === otherSession.id);
  assert.equal(bridge.hasClient(otherSession.id), false);
  const selectionlessInput = actionInput("sha256:selectionless");
  assert.deepEqual(await bridge.requestApproval(otherSession.id, selectionlessInput), {
    status: "denied",
    requestId: null,
    sessionId: otherSession.id,
    argumentsHash: selectionlessInput.argumentsHash,
  } satisfies ApprovalDecision);
  await closeSocket(selectionless.ws);

  const second = await connect(interactiveSession.id, secondSelection);
  await second.inbox.take(isSnapshotFor(interactiveSession.id, secondSelection, 0));
  assert.equal(bridge.attachedClientCount(interactiveSession.id), 2);

  const exactPending = bridge.requestApproval(interactiveSession.id, actionInput("sha256:exact"), { timeoutMs: 5_000 });
  const [exactRequest] = bridge.getPendingRequests(interactiveSession.id);
  assert.ok(exactRequest);
  const firstRequestMessage = await first.inbox.take(isRequest(exactRequest.requestId, interactiveSession.id, firstSelection));
  const secondRequestMessage = await second.inbox.take(isRequest(exactRequest.requestId, interactiveSession.id, secondSelection));
  assert.equal(firstRequestMessage.summary, exactRequest.summary);
  assert.equal(secondRequestMessage.argumentsHash, exactRequest.argumentsHash);

  first.ws.send(JSON.stringify({
    type: "external_action_response",
    requestId: exactRequest.requestId,
    sessionId: exactRequest.sessionId,
    selection_id: "wrong-selection",
    argumentsHash: exactRequest.argumentsHash,
    approved: true,
  }));
  await first.inbox.take(isAck(exactRequest.requestId, "rejected", exactRequest.sessionId, "wrong-selection"));

  first.ws.send(JSON.stringify({
    type: "external_action_response",
    requestId: exactRequest.requestId,
    sessionId: otherSession.id,
    selection_id: firstSelection,
    argumentsHash: exactRequest.argumentsHash,
    approved: true,
  }));
  await first.inbox.take(isAck(exactRequest.requestId, "rejected", otherSession.id, firstSelection));

  first.ws.send(JSON.stringify({
    type: "external_action_response",
    requestId: exactRequest.requestId,
    sessionId: exactRequest.sessionId,
    selection_id: firstSelection,
    argumentsHash: "sha256:changed",
    approved: true,
  }));
  await first.inbox.take(isAck(exactRequest.requestId, "rejected", exactRequest.sessionId, firstSelection));

  first.ws.send(JSON.stringify({
    type: "external_action_response",
    requestId: exactRequest.requestId,
    sessionId: exactRequest.sessionId,
    selection_id: firstSelection,
    argumentsHash: exactRequest.argumentsHash,
    approved: "true",
  }));
  await first.inbox.take(isAck(exactRequest.requestId, "rejected", exactRequest.sessionId, firstSelection));
  assert.equal(bridge.getPendingRequests(interactiveSession.id).length, 1);
  assert.equal(pinAttempts.reserves.length, 0);
  assert.equal(pinAttempts.verifications.length, 0);

  first.ws.send(JSON.stringify({
    type: "external_action_response",
    requestId: exactRequest.requestId,
    sessionId: exactRequest.sessionId,
    selection_id: firstSelection,
    argumentsHash: exactRequest.argumentsHash,
    approved: true,
    pin: SYNTHETIC_IDENTITY_PIN,
  }));
  assert.deepEqual(await exactPending, {
    status: "approved",
    requestId: exactRequest.requestId,
    sessionId: exactRequest.sessionId,
    argumentsHash: exactRequest.argumentsHash,
  } satisfies ApprovalDecision);
  assert.equal(pinAttempts.reserves.length, 1);
  assert.equal(pinAttempts.reserves[0].realm, "wayang.external-actions.v1");
  assert.match(pinAttempts.reserves[0].operationDigest, /^[a-f0-9]{64}$/);
  assert.deepEqual(pinAttempts.verifications.map((attempt) => attempt.pin), [SYNTHETIC_IDENTITY_PIN]);

  // Every attached tab receives the explicit terminal status before its
  // authoritative empty snapshot. The submitting tab receives its ack last.
  const firstTerminal = await first.inbox.take(isResolutionFrame(
    exactRequest.requestId,
    exactRequest.sessionId,
    firstSelection,
  ));
  assert.ok(isTerminal(exactRequest.requestId, "approved", exactRequest.sessionId, firstSelection)(firstTerminal));
  const firstSnapshot = await first.inbox.take(isResolutionFrame(
    exactRequest.requestId,
    exactRequest.sessionId,
    firstSelection,
  ));
  assert.ok(isSnapshotFor(interactiveSession.id, firstSelection, 0)(firstSnapshot));
  const firstAck = await first.inbox.take(isResolutionFrame(
    exactRequest.requestId,
    exactRequest.sessionId,
    firstSelection,
  ));
  assert.ok(isAck(exactRequest.requestId, "approved", exactRequest.sessionId, firstSelection)(firstAck));

  const secondTerminal = await second.inbox.take(isResolutionFrame(
    exactRequest.requestId,
    exactRequest.sessionId,
    secondSelection,
  ));
  assert.ok(isTerminal(exactRequest.requestId, "approved", exactRequest.sessionId, secondSelection)(secondTerminal));
  const secondSnapshot = await second.inbox.take(isResolutionFrame(
    exactRequest.requestId,
    exactRequest.sessionId,
    secondSelection,
  ));
  assert.ok(isSnapshotFor(interactiveSession.id, secondSelection, 0)(secondSnapshot));

  // Replay a still-live request after reconnect, then process a response while
  // intentionally ignoring its ack. The next snapshot reconciles the lost ack.
  const replayPending = bridge.requestApproval(interactiveSession.id, actionInput("sha256:replay"), { timeoutMs: 5_000 });
  const [replayRequest] = bridge.getPendingRequests(interactiveSession.id);
  assert.ok(replayRequest);
  await first.inbox.take(isRequest(replayRequest.requestId, interactiveSession.id, firstSelection));
  await second.inbox.take(isRequest(replayRequest.requestId, interactiveSession.id, secondSelection));
  await closeSocket(first.ws);
  await waitUntil(() => bridge.attachedClientCount(interactiveSession.id) === 1);
  assert.equal(bridge.hasClient(interactiveSession.id), true); // the second tab remains attached

  const replaySelection = "selection-reconnected";
  const reconnected = await connect(interactiveSession.id, replaySelection);
  const replaySnapshot = await reconnected.inbox.take(isSnapshotFor(interactiveSession.id, replaySelection, 1));
  assert.equal((replaySnapshot.requests as Array<{ requestId: string }>)[0].requestId, replayRequest.requestId);
  reconnected.ws.send(JSON.stringify({
    type: "external_action_response",
    requestId: replayRequest.requestId,
    sessionId: replayRequest.sessionId,
    selection_id: replaySelection,
    argumentsHash: replayRequest.argumentsHash,
    approved: false,
  }));
  assert.deepEqual(await replayPending, {
    status: "denied",
    requestId: replayRequest.requestId,
    sessionId: replayRequest.sessionId,
    argumentsHash: replayRequest.argumentsHash,
  } satisfies ApprovalDecision);
  await second.inbox.take(isTerminal(
    replayRequest.requestId,
    "denied",
    replayRequest.sessionId,
    secondSelection,
  ));
  await second.inbox.take(isSnapshotFor(interactiveSession.id, secondSelection, 0));
  await closeSocket(reconnected.ws); // discard the response ack and terminal snapshot

  const afterLostAckSelection = "selection-after-lost-ack";
  const afterLostAck = await connect(interactiveSession.id, afterLostAckSelection);
  await afterLostAck.inbox.take(isSnapshotFor(interactiveSession.id, afterLostAckSelection, 0));

  const timeoutPending = bridge.requestApproval(interactiveSession.id, actionInput("sha256:timeout"), { timeoutMs: 500 });
  const [timeoutRequest] = bridge.getPendingRequests(interactiveSession.id);
  assert.ok(timeoutRequest);
  await second.inbox.take(isRequest(timeoutRequest.requestId, interactiveSession.id, secondSelection));
  await afterLostAck.inbox.take(isRequest(timeoutRequest.requestId, interactiveSession.id, afterLostAckSelection));
  assert.equal((await timeoutPending).status, "timeout");
  await second.inbox.take(isTerminal(
    timeoutRequest.requestId,
    "timeout",
    timeoutRequest.sessionId,
    secondSelection,
  ));
  await second.inbox.take(isSnapshotFor(interactiveSession.id, secondSelection, 0));
  await afterLostAck.inbox.take(isTerminal(
    timeoutRequest.requestId,
    "timeout",
    timeoutRequest.sessionId,
    afterLostAckSelection,
  ));
  await afterLostAck.inbox.take(isSnapshotFor(interactiveSession.id, afterLostAckSelection, 0));

  const interruptPending = bridge.requestApproval(interactiveSession.id, actionInput("sha256:interrupt"), { timeoutMs: 5_000 });
  const [interruptRequest] = bridge.getPendingRequests(interactiveSession.id);
  assert.ok(interruptRequest);
  await second.inbox.take(isRequest(interruptRequest.requestId, interactiveSession.id, secondSelection));
  second.ws.send(JSON.stringify({ type: "interrupt", clear_queue: true }));
  assert.equal((await interruptPending).status, "cancelled");

  const destructionPending = bridge.requestApproval(interactiveSession.id, actionInput("sha256:destruction"), { timeoutMs: 5_000 });
  const [destructionRequest] = bridge.getPendingRequests(interactiveSession.id);
  assert.ok(destructionRequest);
  await second.inbox.take(isRequest(destructionRequest.requestId, interactiveSession.id, secondSelection));
  await stopPiSession(interactiveSession.id);
  assert.equal((await destructionPending).status, "cancelled");

  await closeSocket(afterLostAck.ws);
  second.ws.send(JSON.stringify({
    type: "switch_session",
    session_id: otherSession.id,
    selection_id: "selection-other-session",
  }));
  await second.inbox.take(isSnapshotFor(otherSession.id, "selection-other-session", 0));
  await waitUntil(() => bridge.attachedClientCount(interactiveSession.id) === 0);
  assert.equal(bridge.hasClient(interactiveSession.id), false);
  assert.equal(bridge.attachedClientCount(otherSession.id), 1);
  assert.equal(bridge.hasClient(otherSession.id), true);
  await closeSocket(second.ws);
  await waitUntil(() => bridge.attachedClientCount(otherSession.id) === 0);
  assert.equal(bridge.hasClient(otherSession.id), false);
});
