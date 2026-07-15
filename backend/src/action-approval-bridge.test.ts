import test from "node:test";
import assert from "node:assert/strict";
import {
  PiActionApprovalBridge,
  getActionApprovalBridge,
  type ActionApprovalBridge,
  type ApprovalDecision,
  type ApprovalTerminalStatus,
  type ExternalActionRequest,
  type ExternalActionRequestInput,
} from "./action-approval-bridge.js";

function actionInput(
  overrides: Partial<ExternalActionRequestInput> = {},
): ExternalActionRequestInput {
  return {
    connector: "linear",
    workspace: "workspace-a",
    toolName: "create_issue",
    target: "TEAM-1",
    summary: "Create a synthetic issue",
    argumentsHash: "sha256:arguments-a",
    ...overrides,
  };
}

function decision(
  status: ApprovalTerminalStatus,
  requestId: string | null,
  sessionId: string,
  argumentsHash: string,
): ApprovalDecision {
  return { status, requestId, sessionId, argumentsHash };
}

test("action approval returns an exact denied proof when no client is attached", async () => {
  const bridge = new PiActionApprovalBridge();
  const requests: ExternalActionRequest[] = [];
  const terminals: Array<{
    requestId: string;
    sessionId: string;
    status: ApprovalTerminalStatus;
  }> = [];
  bridge.onRequest((request) => requests.push(request));
  bridge.onTerminal((event) => terminals.push(event));
  const input = actionInput();

  const result = await bridge.requestApproval("session-a", input);

  assert.deepEqual(
    result,
    decision("denied", null, "session-a", input.argumentsHash),
  );
  assert.deepEqual(requests, []);
  assert.equal(terminals.length, 1);
  assert.match(terminals[0].requestId, /^[0-9a-f-]{36}$/);
  assert.deepEqual(
    { sessionId: terminals[0].sessionId, status: terminals[0].status },
    { sessionId: "session-a", status: "denied" },
  );
  assert.deepEqual(bridge.getPendingRequests("session-a"), []);
});

test("action approval replays pending metadata and requires the exact session and hash", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-a", "client-a");
  let emitted: ExternalActionRequest | undefined;
  bridge.onRequest((request) => {
    emitted = request;
  });

  const pending = bridge.requestApproval("session-a", actionInput(), { timeoutMs: 1_000 });
  assert.ok(emitted);
  assert.match(emitted.requestId, /^[0-9a-f-]{36}$/);
  assert.equal(emitted.sessionId, "session-a");
  assert.equal(emitted.connector, "linear");
  assert.equal(emitted.workspace, "workspace-a");
  assert.equal(emitted.toolName, "create_issue");
  assert.equal(emitted.target, "TEAM-1");
  assert.equal(emitted.summary, "Create a synthetic issue");
  assert.equal(emitted.argumentsHash, "sha256:arguments-a");
  assert.equal(typeof emitted.createdAt, "number");
  assert.equal(emitted.timeoutMs, 1_000);
  assert.deepEqual(bridge.getPendingRequests("session-a"), [emitted]);

  assert.equal(
    bridge.respondForSession(
      "other-session",
      emitted.requestId,
      emitted.argumentsHash,
      true,
    ).status,
    "rejected",
  );
  assert.equal(
    bridge.respondForSession(
      "session-a",
      emitted.requestId,
      "sha256:different-arguments",
      true,
    ).status,
    "rejected",
  );
  assert.equal(bridge.getPendingRequests("session-a").length, 1);

  assert.equal(
    bridge.respondForSession(
      "session-a",
      emitted.requestId,
      emitted.argumentsHash,
      true,
    ).status,
    "approved",
  );
  assert.deepEqual(
    await pending,
    decision(
      "approved",
      emitted.requestId,
      emitted.sessionId,
      emitted.argumentsHash,
    ),
  );
  assert.deepEqual(bridge.getPendingRequests("session-a"), []);
});

test("action approval survives last-client detach and replays after reconnect", async () => {
  const bridge = new PiActionApprovalBridge();
  const detachFirstClient = bridge.attachClient("session-reconnect", "client-a");

  const pending = bridge.requestApproval("session-reconnect", actionInput(), {
    timeoutMs: 1_000,
  });
  const [originalRequest] = bridge.getPendingRequests("session-reconnect");
  assert.ok(originalRequest);

  detachFirstClient();
  assert.equal(bridge.hasClient("session-reconnect"), false);
  assert.deepEqual(bridge.getPendingRequests("session-reconnect"), [originalRequest]);

  const detachReconnectedClient = bridge.attachClient(
    "session-reconnect",
    "client-b",
  );
  assert.equal(bridge.hasClient("session-reconnect"), true);
  const [replayedRequest] = bridge.getPendingRequests("session-reconnect");
  assert.deepEqual(replayedRequest, originalRequest);
  assert.equal(
    bridge.respondForSession(
      "session-reconnect",
      replayedRequest.requestId,
      replayedRequest.argumentsHash,
      true,
    ).status,
    "approved",
  );
  assert.deepEqual(
    await pending,
    decision(
      "approved",
      replayedRequest.requestId,
      replayedRequest.sessionId,
      replayedRequest.argumentsHash,
    ),
  );
  detachReconnectedClient();
});

test("action approval rejects malformed runtime decisions without resolving", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-malformed", "client-a");
  const terminals: ApprovalTerminalStatus[] = [];
  bridge.onTerminal((event) => terminals.push(event.status));

  const pending = bridge.requestApproval("session-malformed", actionInput());
  const [request] = bridge.getPendingRequests("session-malformed");
  assert.ok(request);

  assert.equal(
    bridge.respondForSession(
      "session-malformed",
      "stale-request-id",
      "sha256:stale-arguments",
      true,
    ).status,
    "stale",
  );
  for (const malformed of ["false", 1] as const) {
    assert.equal(
      bridge.respondForSession(
        "session-malformed",
        request.requestId,
        request.argumentsHash,
        malformed,
      ).status,
      "rejected",
    );
  }
  assert.equal(bridge.getPendingRequests("session-malformed").length, 1);
  assert.deepEqual(terminals, []);

  assert.equal(
    bridge.respondForSession(
      "session-malformed",
      request.requestId,
      request.argumentsHash,
      false,
    ).status,
    "denied",
  );
  assert.deepEqual(
    await pending,
    decision(
      "denied",
      request.requestId,
      request.sessionId,
      request.argumentsHash,
    ),
  );
  assert.deepEqual(terminals, ["denied"]);
});

test("action approval times out and removes the pending request", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-timeout", "client-a");

  const pending = bridge.requestApproval("session-timeout", actionInput(), { timeoutMs: 10 });
  const [request] = bridge.getPendingRequests("session-timeout");
  assert.ok(request);

  assert.equal(bridge.getPendingRequests("session-timeout").length, 1);
  assert.deepEqual(
    await pending,
    decision(
      "timeout",
      request.requestId,
      request.sessionId,
      request.argumentsHash,
    ),
  );
  assert.deepEqual(bridge.getPendingRequests("session-timeout"), []);
});

test("action approval supports explicit denial", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-denial", "client-a");
  let request: ExternalActionRequest | undefined;
  bridge.onRequest((value) => {
    request = value;
  });

  const pending = bridge.requestApproval("session-denial", actionInput());
  assert.ok(request);
  assert.equal(
    bridge.respondForSession(
      "session-denial",
      request.requestId,
      request.argumentsHash,
      false,
    ).status,
    "denied",
  );
  assert.deepEqual(
    await pending,
    decision(
      "denied",
      request.requestId,
      request.sessionId,
      request.argumentsHash,
    ),
  );
});

test("action approval abort cancellation removes the request and makes responses stale", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-abort", "client-a");
  const controller = new AbortController();
  let request: ExternalActionRequest | undefined;
  const terminals: ApprovalTerminalStatus[] = [];
  bridge.onRequest((value) => {
    request = value;
  });
  bridge.onTerminal((event) => terminals.push(event.status));

  const pending = bridge.requestApproval("session-abort", actionInput(), {
    timeoutMs: 1_000,
    signal: controller.signal,
  });
  assert.ok(request);
  controller.abort();

  assert.deepEqual(
    await pending,
    decision(
      "cancelled",
      request.requestId,
      request.sessionId,
      request.argumentsHash,
    ),
  );
  assert.deepEqual(terminals, ["cancelled"]);
  assert.deepEqual(bridge.getPendingRequests("session-abort"), []);
  assert.equal(
    bridge.respondForSession(
      "session-abort",
      request.requestId,
      request.argumentsHash,
      true,
    ).status,
    "stale",
  );
});

test("action approval cancellation targets exactly one request", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-cancel", "client-a");
  const requests: ExternalActionRequest[] = [];
  bridge.onRequest((request) => requests.push(request));

  const first = bridge.requestApproval(
    "session-cancel",
    actionInput({ argumentsHash: "sha256:first" }),
  );
  const second = bridge.requestApproval(
    "session-cancel",
    actionInput({ argumentsHash: "sha256:second" }),
  );

  assert.equal(bridge.cancelRequest(requests[0].requestId, "test cleanup"), true);
  assert.equal(bridge.cancelRequest(requests[0].requestId, "duplicate cleanup"), false);
  assert.deepEqual(
    await first,
    decision(
      "cancelled",
      requests[0].requestId,
      requests[0].sessionId,
      requests[0].argumentsHash,
    ),
  );
  assert.deepEqual(
    bridge.getPendingRequests("session-cancel").map((request) => request.requestId),
    [requests[1].requestId],
  );

  assert.equal(
    bridge.respondForSession(
      "session-cancel",
      requests[1].requestId,
      requests[1].argumentsHash,
      true,
    ).status,
    "approved",
  );
  assert.deepEqual(
    await second,
    decision(
      "approved",
      requests[1].requestId,
      requests[1].sessionId,
      requests[1].argumentsHash,
    ),
  );
});

test("action approval duplicate and multi-client detach closures are idempotent", async () => {
  const bridge = new PiActionApprovalBridge();
  const detachFirstReference = bridge.attachClient("session-clients", "client-a");
  const detachSecondReference = bridge.attachClient("session-clients", "client-a");
  const detachOtherClient = bridge.attachClient("session-clients", "client-b");

  assert.equal(bridge.hasClient("session-clients"), true);
  detachFirstReference();
  detachFirstReference();
  assert.equal(bridge.hasClient("session-clients"), true);
  detachSecondReference();
  detachSecondReference();
  assert.equal(bridge.hasClient("session-clients"), true);
  detachOtherClient();
  detachOtherClient();
  assert.equal(bridge.hasClient("session-clients"), false);

  const input = actionInput();
  assert.deepEqual(
    await bridge.requestApproval("session-clients", input),
    decision("denied", null, "session-clients", input.argumentsHash),
  );
});

test("action approval broadcasts cloned terminal events without request metadata", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-terminal", "client-a");
  let request: ExternalActionRequest | undefined;
  const terminals: Array<{
    requestId: string;
    sessionId: string;
    status: ApprovalTerminalStatus;
  }> = [];
  bridge.onRequest((value) => {
    request = value;
  });
  const unsubscribeMutatingListener = bridge.onTerminal((event) => {
    event.sessionId = "mutated-by-listener";
  });
  const unsubscribe = bridge.onTerminal((event) => terminals.push(event));

  const pending = bridge.requestApproval("session-terminal", actionInput());
  assert.ok(request);
  bridge.respondForSession(
    "session-terminal",
    request.requestId,
    request.argumentsHash,
    true,
  );

  assert.deepEqual(
    await pending,
    decision(
      "approved",
      request.requestId,
      request.sessionId,
      request.argumentsHash,
    ),
  );
  assert.deepEqual(terminals, [
    {
      requestId: request.requestId,
      sessionId: "session-terminal",
      status: "approved",
    },
  ]);
  assert.deepEqual(Object.keys(terminals[0]).sort(), ["requestId", "sessionId", "status"]);
  unsubscribeMutatingListener();
  unsubscribe();

  const denied = bridge.requestApproval(
    "session-terminal",
    actionInput({ argumentsHash: "sha256:after-unsubscribe" }),
  );
  const [deniedRequest] = bridge.getPendingRequests("session-terminal");
  bridge.respondForSession(
    "session-terminal",
    deniedRequest.requestId,
    deniedRequest.argumentsHash,
    false,
  );
  assert.deepEqual(
    await denied,
    decision(
      "denied",
      deniedRequest.requestId,
      deniedRequest.sessionId,
      deniedRequest.argumentsHash,
    ),
  );
  assert.equal(terminals.length, 1);
});

test("action approval session cleanup cancels only matching requests", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-one", "client-a");
  bridge.attachClient("session-two", "client-b");
  const requests: ExternalActionRequest[] = [];
  bridge.onRequest((request) => requests.push(request));

  const first = bridge.requestApproval(
    "session-one",
    actionInput({ argumentsHash: "sha256:one" }),
  );
  const second = bridge.requestApproval(
    "session-one",
    actionInput({ argumentsHash: "sha256:two" }),
  );
  const otherSession = bridge.requestApproval(
    "session-two",
    actionInput({ argumentsHash: "sha256:other" }),
  );

  bridge.cancelSession("session-one", "session closed");
  assert.deepEqual(await Promise.all([first, second]), [
    decision(
      "cancelled",
      requests[0].requestId,
      requests[0].sessionId,
      requests[0].argumentsHash,
    ),
    decision(
      "cancelled",
      requests[1].requestId,
      requests[1].sessionId,
      requests[1].argumentsHash,
    ),
  ]);
  assert.deepEqual(bridge.getPendingRequests("session-one"), []);
  assert.equal(bridge.getPendingRequests("session-two").length, 1);

  const remaining = requests.find((request) => request.sessionId === "session-two");
  assert.ok(remaining);
  bridge.respondForSession(
    "session-two",
    remaining.requestId,
    remaining.argumentsHash,
    true,
  );
  assert.deepEqual(
    await otherSession,
    decision(
      "approved",
      remaining.requestId,
      remaining.sessionId,
      remaining.argumentsHash,
    ),
  );
});

test("action approval defensively clones input, request events, and pending replay", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-clone", "client-a");
  const input = actionInput({ argumentsHash: "sha256:clone" });
  let secondListenerRequest: ExternalActionRequest | undefined;
  bridge.onRequest((request) => {
    request.summary = "mutated summary";
    request.argumentsHash = "sha256:mutated";
  });
  bridge.onRequest((request) => {
    secondListenerRequest = request;
  });

  const pending = bridge.requestApproval("session-clone", input);
  assert.ok(secondListenerRequest);
  assert.equal(secondListenerRequest.summary, "Create a synthetic issue");
  assert.equal(secondListenerRequest.argumentsHash, "sha256:clone");

  input.summary = "caller mutation";
  input.argumentsHash = "sha256:caller-mutation";
  const firstReplay = bridge.getPendingRequests("session-clone")[0];
  firstReplay.summary = "replay mutation";
  firstReplay.argumentsHash = "sha256:replay-mutation";
  const secondReplay = bridge.getPendingRequests("session-clone")[0];
  assert.equal(secondReplay.summary, "Create a synthetic issue");
  assert.equal(secondReplay.argumentsHash, "sha256:clone");

  assert.equal(
    bridge.respondForSession(
      "session-clone",
      secondReplay.requestId,
      "sha256:clone",
      true,
    ).status,
    "approved",
  );
  assert.deepEqual(
    await pending,
    decision(
      "approved",
      secondReplay.requestId,
      secondReplay.sessionId,
      secondReplay.argumentsHash,
    ),
  );
});

test("action approval synchronously rejects a response after its deadline", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-deadline", "client-a");
  const terminals: ApprovalTerminalStatus[] = [];
  bridge.onTerminal((event) => terminals.push(event.status));

  const pending = bridge.requestApproval("session-deadline", actionInput(), {
    timeoutMs: 5,
  });
  const [request] = bridge.getPendingRequests("session-deadline");
  assert.ok(request);

  const deadline = request.createdAt + request.timeoutMs;
  while (Date.now() <= deadline) {
    // Keep the event loop blocked so the timer callback cannot enforce the deadline first.
  }

  assert.equal(
    bridge.respondForSession(
      "session-deadline",
      request.requestId,
      request.argumentsHash,
      true,
    ).status,
    "stale",
  );
  assert.deepEqual(
    await pending,
    decision(
      "timeout",
      request.requestId,
      request.sessionId,
      request.argumentsHash,
    ),
  );
  assert.deepEqual(terminals, ["timeout"]);
  assert.deepEqual(bridge.getPendingRequests("session-deadline"), []);
});

test("action approval synchronously hides expired requests from replay", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-replay-deadline", "client-a");
  const terminals: Array<{
    requestId: string;
    sessionId: string;
    status: ApprovalTerminalStatus;
  }> = [];
  bridge.onTerminal((event) => terminals.push(event));

  const pending = bridge.requestApproval("session-replay-deadline", actionInput(), {
    timeoutMs: 5,
  });
  const [request] = bridge.getPendingRequests("session-replay-deadline");
  assert.ok(request);

  const deadline = request.createdAt + request.timeoutMs;
  while (Date.now() <= deadline) {
    // Keep the event loop blocked so replay observes expiry before the timer callback.
  }

  assert.deepEqual(bridge.getPendingRequests("session-replay-deadline"), []);
  assert.deepEqual(
    await pending,
    decision(
      "timeout",
      request.requestId,
      request.sessionId,
      request.argumentsHash,
    ),
  );
  assert.deepEqual(terminals, [
    {
      requestId: request.requestId,
      sessionId: request.sessionId,
      status: "timeout",
    },
  ]);

  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.deepEqual(terminals, [
    {
      requestId: request.requestId,
      sessionId: request.sessionId,
      status: "timeout",
    },
  ]);
});

test("action approval responses are stale after timeout", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-stale", "client-a");
  let request: ExternalActionRequest | undefined;
  bridge.onRequest((value) => {
    request = value;
  });

  const pending = bridge.requestApproval("session-stale", actionInput(), { timeoutMs: 10 });
  assert.ok(request);
  assert.deepEqual(
    await pending,
    decision(
      "timeout",
      request.requestId,
      request.sessionId,
      request.argumentsHash,
    ),
  );
  assert.equal(
    bridge.respondForSession(
      "session-stale",
      request.requestId,
      request.argumentsHash,
      true,
    ).status,
    "stale",
  );
});

test("action approval exposes no secret-capable request fields beyond display metadata", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-fields", "client-a");
  let emitted: ExternalActionRequest | undefined;
  bridge.onRequest((request) => {
    emitted = request;
  });
  const inputWithExtraFields = {
    ...actionInput(),
    apiKey: "synthetic-token-value",
    credentials: { accessToken: "synthetic-access-value" },
    authorization: "synthetic-authorization-value",
  } as ExternalActionRequestInput;

  const pending = bridge.requestApproval("session-fields", inputWithExtraFields);
  assert.ok(emitted);
  assert.deepEqual(Object.keys(emitted).sort(), [
    "argumentsHash",
    "connector",
    "createdAt",
    "requestId",
    "sessionId",
    "summary",
    "target",
    "timeoutMs",
    "toolName",
    "workspace",
  ]);
  assert.equal(JSON.stringify(emitted).includes("synthetic-token-value"), false);
  assert.equal(JSON.stringify(emitted).includes("synthetic-access-value"), false);
  assert.equal(JSON.stringify(emitted).includes("synthetic-authorization-value"), false);

  bridge.respondForSession(
    "session-fields",
    emitted.requestId,
    emitted.argumentsHash,
    false,
  );
  assert.deepEqual(
    await pending,
    decision(
      "denied",
      emitted.requestId,
      emitted.sessionId,
      emitted.argumentsHash,
    ),
  );
});

test("action approval singleton satisfies the exported bridge contract", () => {
  const first: ActionApprovalBridge = getActionApprovalBridge();
  const second = getActionApprovalBridge();

  assert.strictEqual(first, second);
  assert.strictEqual(
    (globalThis as typeof globalThis & {
      __pi_action_approval_bridge?: PiActionApprovalBridge;
    }).__pi_action_approval_bridge,
    first,
  );
});
