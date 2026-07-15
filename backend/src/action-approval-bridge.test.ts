import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PiActionApprovalBridge,
  getActionApprovalBridge,
  type ActionApprovalBridge,
  type ApprovalDecision,
  type ApprovalTerminalStatus,
  type ExternalActionRequest,
  type ExternalActionRequestInput,
} from "./action-approval-bridge.js";

function argumentsHash(label: string): string {
  return createHash("sha256").update(label).digest("hex");
}

function actionInput(
  overrides: Partial<ExternalActionRequestInput> = {},
): ExternalActionRequestInput {
  const { argumentsHash: hashLabel = "arguments-a", ...rest } = overrides;
  return {
    connector: "linear",
    workspace: "workspace-a",
    toolName: "create_issue",
    target: "TEAM-1",
    summary: "Create a synthetic issue",
    ...rest,
    argumentsHash: argumentsHash(hashLabel),
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
  assert.equal(emitted.argumentsHash, argumentsHash("arguments-a"));
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

const malformedAbortSignals: Array<{
  name: string;
  create: () => Record<string, unknown>;
}> = [
  { name: "a plain object", create: () => ({}) },
  {
    name: "a structurally complete fake",
    create: () => ({
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    }),
  },
  {
    name: "an AbortSignal-prototype structural fake",
    create: () => Object.setPrototypeOf({
      aborted: false,
      addEventListener() {},
      removeEventListener() {},
    }, AbortSignal.prototype),
  },
  {
    name: "a non-boolean aborted property",
    create: () => ({
      aborted: "false",
      addEventListener() {},
      removeEventListener() {},
    }),
  },
  {
    name: "a missing removeEventListener method",
    create: () => ({
      aborted: false,
      addEventListener() {},
    }),
  },
  {
    name: "a throwing addEventListener method",
    create: () => ({
      aborted: false,
      addEventListener() {
        throw new Error("synthetic add failure");
      },
      removeEventListener() {},
    }),
  },
  {
    name: "a throwing removeEventListener method",
    create: () => ({
      aborted: false,
      addEventListener() {},
      removeEventListener() {
        throw new Error("synthetic remove failure");
      },
    }),
  },
];

for (const malformed of malformedAbortSignals) {
  test(`action approval rejects ${malformed.name} before pending creation`, async () => {
    const bridge = new PiActionApprovalBridge();
    const sessionId = "session-malformed-signal";
    bridge.attachClient(sessionId, "client-a");
    const requests: ExternalActionRequest[] = [];
    const terminals: ApprovalTerminalStatus[] = [];
    bridge.onRequest((request) => requests.push(request));
    bridge.onTerminal((event) => terminals.push(event.status));
    const input = actionInput({ argumentsHash: malformed.name });
    const signal = malformed.create();
    let approval: Promise<ApprovalDecision> | undefined;

    try {
      approval = bridge.requestApproval(sessionId, input, {
        timeoutMs: 1_000,
        signal: signal as unknown as AbortSignal,
      });

      assert.deepEqual(requests, []);
      assert.deepEqual(terminals, []);
      assert.deepEqual(bridge.getPendingRequests(sessionId), []);
      assert.deepEqual(
        await approval,
        decision("denied", null, sessionId, input.argumentsHash),
      );
    } finally {
      Object.defineProperties(signal, {
        aborted: { configurable: true, value: false },
        addEventListener: { configurable: true, value() {} },
        removeEventListener: { configurable: true, value() {} },
      });
      bridge.cancelSession(sessionId, "test cleanup");
      await approval?.catch(() => undefined);
    }
  });
}

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

  bridge.attachClient("session-cancel-other", "client-b");
  const first = bridge.requestApproval(
    "session-cancel",
    actionInput({ argumentsHash: "first" }),
  );
  const second = bridge.requestApproval(
    "session-cancel-other",
    actionInput({ argumentsHash: "second" }),
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
    [],
  );

  assert.equal(
    bridge.respondForSession(
      "session-cancel-other",
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
    actionInput({ argumentsHash: "one" }),
  );
  const otherSession = bridge.requestApproval(
    "session-two",
    actionInput({ argumentsHash: "other" }),
  );

  bridge.cancelSession("session-one", "session closed");
  assert.deepEqual(await first, decision(
    "cancelled",
    requests[0].requestId,
    requests[0].sessionId,
    requests[0].argumentsHash,
  ));
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
  assert.equal(secondListenerRequest.argumentsHash, argumentsHash("sha256:clone"));

  input.summary = "caller mutation";
  input.argumentsHash = "sha256:caller-mutation";
  const firstReplay = bridge.getPendingRequests("session-clone")[0];
  firstReplay.summary = "replay mutation";
  firstReplay.argumentsHash = "sha256:replay-mutation";
  const secondReplay = bridge.getPendingRequests("session-clone")[0];
  assert.equal(secondReplay.summary, "Create a synthetic issue");
  assert.equal(secondReplay.argumentsHash, argumentsHash("sha256:clone"));

  assert.equal(
    bridge.respondForSession(
      "session-clone",
      secondReplay.requestId,
      argumentsHash("sha256:clone"),
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

test("action approval accepts exact runtime admission boundaries", async () => {
  const sessionId = "s".repeat(512);
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient(sessionId, "client-a");
  const requests: ExternalActionRequest[] = [];
  bridge.onRequest((request) => requests.push(request));

  const maximumInput = actionInput({
    connector: "c".repeat(256),
    workspace: "w".repeat(256),
    toolName: "t".repeat(256),
    target: "x".repeat(2_048),
    summary: "é".repeat(32_768),
    argumentsHash: "maximum-boundary",
  });
  assert.equal(Buffer.byteLength(maximumInput.summary, "utf8"), 64 * 1_024);

  const maximumPending = bridge.requestApproval(sessionId, maximumInput, {
    timeoutMs: 300_000,
  });
  assert.equal(requests.length, 1);
  assert.equal(Buffer.byteLength(requests[0].summary, "utf8"), 64 * 1_024);
  assert.equal(requests[0].timeoutMs, 300_000);
  assert.deepEqual(bridge.getPendingRequests(sessionId), [requests[0]]);
  assert.equal(
    bridge.respondForSession(sessionId, requests[0].requestId, maximumInput.argumentsHash, false).status,
    "denied",
  );
  assert.deepEqual(
    await maximumPending,
    decision("denied", requests[0].requestId, sessionId, maximumInput.argumentsHash),
  );

  const minimumInput = actionInput({ argumentsHash: "minimum-timeout" });
  const minimumPending = bridge.requestApproval(sessionId, minimumInput, { timeoutMs: 1 });
  const minimumRequest = requests[1];
  assert.equal(minimumRequest.timeoutMs, 1);
  assert.equal(
    bridge.respondForSession(sessionId, minimumRequest.requestId, minimumInput.argumentsHash, true).status,
    "approved",
  );
  assert.deepEqual(
    await minimumPending,
    decision("approved", minimumRequest.requestId, sessionId, minimumInput.argumentsHash),
  );
});

test("action approval rejects summaries one UTF-8 byte above 64 KiB before cloning or emitting", async () => {
  const maximumSummaryBytes = 64 * 1_024;
  const oversizedSummaries = [
    "a".repeat(maximumSummaryBytes + 1),
    `${"é".repeat(maximumSummaryBytes / 2)}a`,
  ];

  for (const summary of oversizedSummaries) {
    assert.equal(Buffer.byteLength(summary, "utf8"), maximumSummaryBytes + 1);
    const bridge = new PiActionApprovalBridge();
    bridge.attachClient("session-oversized", "client-a");
    const requests: ExternalActionRequest[] = [];
    const terminals: ApprovalTerminalStatus[] = [];
    bridge.onRequest((request) => requests.push(request));
    bridge.onTerminal((event) => terminals.push(event.status));
    const source = actionInput({ summary, argumentsHash: "oversized-summary" });
    let enumerated = false;
    const input = new Proxy(source, {
      ownKeys(target) {
        enumerated = true;
        return Reflect.ownKeys(target);
      },
    });

    const result = await bridge.requestApproval("session-oversized", input, {
      signal: AbortSignal.abort(),
    });

    assert.deepEqual(
      result,
      decision("denied", null, "session-oversized", source.argumentsHash),
    );
    assert.equal(enumerated, false);
    assert.equal(input.summary, summary);
    assert.deepEqual(requests, []);
    assert.deepEqual(terminals, []);
    assert.deepEqual(bridge.getPendingRequests("session-oversized"), []);
  }
});

test("action approval rejects oversized or control-bearing metadata before emitting", async () => {
  const oversizedCases: Array<{ sessionId?: string; input: ExternalActionRequestInput }> = [
    { sessionId: "s".repeat(513), input: actionInput({ argumentsHash: "session-too-long" }) },
    { input: actionInput({ connector: "c".repeat(257), argumentsHash: "connector-too-long" }) },
    { input: actionInput({ workspace: "w".repeat(257), argumentsHash: "workspace-too-long" }) },
    { input: actionInput({ toolName: "t".repeat(257), argumentsHash: "tool-too-long" }) },
    { input: actionInput({ target: "x".repeat(2_049), argumentsHash: "target-too-long" }) },
  ];
  const controlCases: Array<{ sessionId?: string; input: ExternalActionRequestInput }> = [
    { sessionId: "session\ncontrol", input: actionInput({ argumentsHash: "session-control" }) },
    { input: actionInput({ connector: "connector\u0000control", argumentsHash: "connector-control" }) },
    { input: actionInput({ workspace: "workspace\tcontrol", argumentsHash: "workspace-control" }) },
    { input: actionInput({ toolName: "tool\u007fcontrol", argumentsHash: "tool-control" }) },
    { input: actionInput({ target: "target\u0085control", argumentsHash: "target-control" }) },
  ];

  for (const { sessionId = "session-metadata", input } of [...oversizedCases, ...controlCases]) {
    const bridge = new PiActionApprovalBridge();
    bridge.attachClient(sessionId, "client-a");
    let emitted = false;
    bridge.onRequest(() => { emitted = true; });
    bridge.onTerminal(() => { emitted = true; });

    assert.deepEqual(
      await bridge.requestApproval(sessionId, input, { signal: AbortSignal.abort() }),
      decision("denied", null, sessionId, input.argumentsHash),
    );
    assert.equal(emitted, false);
    assert.deepEqual(bridge.getPendingRequests(sessionId), []);
  }
});

test("action approval requires an exact 64-hex arguments hash", async () => {
  for (const invalidHash of [
    "a".repeat(63),
    "a".repeat(65),
    `${"a".repeat(63)}g`,
    `sha256:${"a".repeat(64)}`,
  ]) {
    const bridge = new PiActionApprovalBridge();
    bridge.attachClient("session-hash", "client-a");
    const input = { ...actionInput(), argumentsHash: invalidHash };
    let emitted = false;
    bridge.onRequest(() => { emitted = true; });
    bridge.onTerminal(() => { emitted = true; });

    assert.deepEqual(
      await bridge.requestApproval("session-hash", input, { signal: AbortSignal.abort() }),
      decision("denied", null, "session-hash", invalidHash),
    );
    assert.equal(emitted, false);
    assert.deepEqual(bridge.getPendingRequests("session-hash"), []);
  }
});

test("action approval rejects non-integer and out-of-range timeouts", async () => {
  for (const timeoutMs of [-1, 0, 1.5, 300_001, Number.NaN, Number.POSITIVE_INFINITY]) {
    const bridge = new PiActionApprovalBridge();
    bridge.attachClient("session-timeout-admission", "client-a");
    const input = actionInput({ argumentsHash: `timeout-${String(timeoutMs)}` });
    let emitted = false;
    bridge.onRequest(() => { emitted = true; });
    bridge.onTerminal(() => { emitted = true; });

    assert.deepEqual(
      await bridge.requestApproval("session-timeout-admission", input, {
        timeoutMs,
        signal: AbortSignal.abort(),
      }),
      decision("denied", null, "session-timeout-admission", input.argumentsHash),
    );
    assert.equal(emitted, false);
    assert.deepEqual(bridge.getPendingRequests("session-timeout-admission"), []);
  }
});

test("action approval admits only one pending request per session", async () => {
  const bridge = new PiActionApprovalBridge();
  bridge.attachClient("session-concurrent", "client-a");
  const requests: ExternalActionRequest[] = [];
  const terminals: ApprovalTerminalStatus[] = [];
  bridge.onRequest((request) => requests.push(request));
  bridge.onTerminal((event) => terminals.push(event.status));
  const firstInput = actionInput({ argumentsHash: "concurrent-first" });
  const secondInput = actionInput({ argumentsHash: "concurrent-second" });

  const firstPending = bridge.requestApproval("session-concurrent", firstInput);
  const secondDecision = await bridge.requestApproval("session-concurrent", secondInput, {
    timeoutMs: 20,
  });

  assert.deepEqual(
    secondDecision,
    decision("denied", null, "session-concurrent", secondInput.argumentsHash),
  );
  assert.equal(requests.length, 1);
  assert.deepEqual(terminals, []);
  assert.deepEqual(bridge.getPendingRequests("session-concurrent"), [requests[0]]);

  assert.equal(
    bridge.respondForSession(
      "session-concurrent",
      requests[0].requestId,
      requests[0].argumentsHash,
      false,
    ).status,
    "denied",
  );
  assert.deepEqual(
    await firstPending,
    decision("denied", requests[0].requestId, "session-concurrent", firstInput.argumentsHash),
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
