import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  PiActionApprovalBridge as ProductionPiActionApprovalBridge,
  getActionApprovalBridge,
  type ActionApprovalBridge,
  type ApprovalDecision,
  type ApprovalTerminalStatus,
  type ExternalActionRequest,
  type ExternalActionRequestInput,
} from "./action-approval-bridge.js";
import type {
  ReservePinAttemptResult,
  SettingsPinAttemptPort,
  VerifyPinAttemptResult,
} from "./workspace-capability-approval/types.js";

const LEGACY_TEST_PIN_ATTEMPTS: SettingsPinAttemptPort = {
  async reserve(): Promise<ReservePinAttemptResult> { return { status: "reserved" }; },
  async verifyAndConsume(): Promise<VerifyPinAttemptResult> { return { status: "verified" }; },
  async cancelAndConsume(): Promise<void> {},
};

/** Keeps pre-PIN bridge regressions focused on their original invariant. */
class PiActionApprovalBridge extends ProductionPiActionApprovalBridge {
  constructor() {
    super(LEGACY_TEST_PIN_ATTEMPTS);
  }

  override respondForSession(
    sessionId: string,
    requestId: string,
    hash: string,
    approved: unknown,
    pin?: unknown,
  ) {
    return super.respondForSession(
      sessionId,
      requestId,
      hash,
      approved,
      pin ?? (approved === true ? "12345678" : undefined),
    );
  }
}

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
    (await bridge.respondForSession(
      "other-session",
      emitted.requestId,
      emitted.argumentsHash,
      true,
    )).status,
    "rejected",
  );
  assert.equal(
    (await bridge.respondForSession(
      "session-a",
      emitted.requestId,
      "sha256:different-arguments",
      true,
    )).status,
    "rejected",
  );
  assert.equal(bridge.getPendingRequests("session-a").length, 1);

  assert.equal(
    (await bridge.respondForSession(
      "session-a",
      emitted.requestId,
      emitted.argumentsHash,
      true,
    )).status,
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
    (await bridge.respondForSession(
      "session-reconnect",
      replayedRequest.requestId,
      replayedRequest.argumentsHash,
      true,
    )).status,
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
    (await bridge.respondForSession(
      "session-malformed",
      "stale-request-id",
      "sha256:stale-arguments",
      true,
    )).status,
    "stale",
  );
  for (const malformed of ["false", 1] as const) {
    assert.equal(
      (await bridge.respondForSession(
        "session-malformed",
        request.requestId,
        request.argumentsHash,
        malformed,
      )).status,
      "rejected",
    );
  }
  assert.equal(bridge.getPendingRequests("session-malformed").length, 1);
  assert.deepEqual(terminals, []);

  assert.equal(
    (await bridge.respondForSession(
      "session-malformed",
      request.requestId,
      request.argumentsHash,
      false,
    )).status,
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
    (await bridge.respondForSession(
      "session-denial",
      request.requestId,
      request.argumentsHash,
      false,
    )).status,
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
    (await bridge.respondForSession(
      "session-abort",
      request.requestId,
      request.argumentsHash,
      true,
    )).status,
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
    (await bridge.respondForSession(
      "session-cancel-other",
      requests[1].requestId,
      requests[1].argumentsHash,
      true,
    )).status,
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
  await bridge.respondForSession(
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
  await bridge.respondForSession(
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
  await bridge.respondForSession(
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
    (await bridge.respondForSession(
      "session-clone",
      secondReplay.requestId,
      argumentsHash("sha256:clone"),
      true,
    )).status,
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
    (await bridge.respondForSession(
      "session-deadline",
      request.requestId,
      request.argumentsHash,
      true,
    )).status,
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
    (await bridge.respondForSession(
      "session-stale",
      request.requestId,
      request.argumentsHash,
      true,
    )).status,
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

  await bridge.respondForSession(
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
    (await bridge.respondForSession(sessionId, requests[0].requestId, maximumInput.argumentsHash, false)).status,
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
  // A 1 ms request is admitted, but approval now performs asynchronous durable
  // PIN reservation/verification and may legitimately expire before it can
  // complete. Denial is synchronous and proves the exact lower admission bound
  // without making the test scheduler-speed dependent.
  assert.equal(
    (await bridge.respondForSession(sessionId, minimumRequest.requestId, minimumInput.argumentsHash, false)).status,
    "denied",
  );
  assert.deepEqual(
    await minimumPending,
    decision("denied", minimumRequest.requestId, sessionId, minimumInput.argumentsHash),
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
    (await bridge.respondForSession(
      "session-concurrent",
      requests[0].requestId,
      requests[0].argumentsHash,
      false,
    )).status,
    "denied",
  );
  assert.deepEqual(
    await firstPending,
    decision("denied", requests[0].requestId, "session-concurrent", firstInput.argumentsHash),
  );
});

test("PIN-gated approval reserves an exact immutable external-action digest", async () => {
  const reserves: Parameters<SettingsPinAttemptPort["reserve"]>[0][] = [];
  const verifies: Parameters<SettingsPinAttemptPort["verifyAndConsume"]>[0][] = [];
  const pinAttempts: SettingsPinAttemptPort = {
    async reserve(input) { reserves.push(input); return { status: "reserved" }; },
    async verifyAndConsume(input) { verifies.push(input); return { status: "verified" }; },
    async cancelAndConsume() {},
  };
  const bridge = new ProductionPiActionApprovalBridge(pinAttempts);
  bridge.attachClient("session-pin", "client-a");
  const pending = bridge.requestApproval("session-pin", actionInput(), { timeoutMs: 1_000 });
  const [request] = bridge.getPendingRequests("session-pin");

  assert.deepEqual(
    await bridge.respondForSession("session-pin", request.requestId, request.argumentsHash, true, "12345678"),
    { status: "approved" },
  );
  assert.equal(reserves.length, 1);
  assert.equal(reserves[0].realm, "wayang.external-actions.v1");
  assert.equal(reserves[0].requestId, request.requestId);
  assert.equal(reserves[0].expiresAt, request.createdAt + request.timeoutMs);
  assert.equal(reserves[0].operationDigest, createHash("sha256").update(JSON.stringify({
    realm: "wayang.external-actions.v1",
    requestId: request.requestId,
    sessionId: request.sessionId,
    connector: request.connector,
    workspace: request.workspace ?? null,
    toolName: request.toolName,
    target: request.target ?? null,
    summary: request.summary,
    argumentsHash: request.argumentsHash,
    createdAt: request.createdAt,
    timeoutMs: request.timeoutMs,
    expiresAt: request.createdAt + request.timeoutMs,
  })).digest("hex"));
  assert.deepEqual(
    { ...verifies[0], now: undefined },
    {
      realm: "wayang.external-actions.v1",
      reservationId: reserves[0].reservationId,
      requestId: request.requestId,
      pin: "12345678",
      now: undefined,
    },
  );
  assert.deepEqual(await pending, decision("approved", request.requestId, request.sessionId, request.argumentsHash));
});

test("wrong and malformed PIN attempts each consume and deny the exact action", async () => {
  for (const submittedPin of ["87654321", "not-eight-digits", undefined, "x".repeat(2_000)]) {
    const verifiedPins: string[] = [];
    const pinAttempts: SettingsPinAttemptPort = {
      async reserve() { return { status: "reserved" }; },
      async verifyAndConsume(input) {
        verifiedPins.push(input.pin);
        return { status: "wrong_pin" };
      },
      async cancelAndConsume() {},
    };
    const bridge = new ProductionPiActionApprovalBridge(pinAttempts);
    bridge.attachClient("session-wrong-pin", "client-a");
    const pending = bridge.requestApproval("session-wrong-pin", actionInput());
    const [request] = bridge.getPendingRequests("session-wrong-pin");

    assert.deepEqual(
      await bridge.respondForSession(
        request.sessionId,
        request.requestId,
        request.argumentsHash,
        true,
        submittedPin,
      ),
      { status: "denied", errorCode: "wrong_pin" },
    );
    assert.deepEqual(await pending, decision("denied", request.requestId, request.sessionId, request.argumentsHash));
    assert.deepEqual(bridge.getPendingRequests(request.sessionId), []);
    assert.equal(verifiedPins.length, 1);
    if (submittedPin === undefined || (typeof submittedPin === "string" && Buffer.byteLength(submittedPin) > 1_024)) {
      assert.equal(verifiedPins[0], "");
    }
  }
});

test("missing and unavailable PIN authority fail approval closed", async () => {
  const cases: Array<SettingsPinAttemptPort | undefined> = [
    undefined,
    {
      async reserve() { return { status: "unavailable" }; },
      async verifyAndConsume() { return { status: "unavailable" }; },
      async cancelAndConsume() {},
    },
    {
      async reserve() { return { status: "reserved" }; },
      async verifyAndConsume() { return { status: "unavailable" }; },
      async cancelAndConsume() {},
    },
    {
      async reserve(): Promise<ReservePinAttemptResult> { throw new Error("synthetic reserve failure"); },
      async verifyAndConsume() { return { status: "verified" }; },
      async cancelAndConsume() {},
    },
    {
      async reserve() { return { status: "reserved" }; },
      async verifyAndConsume(): Promise<VerifyPinAttemptResult> { throw new Error("synthetic verify failure"); },
      async cancelAndConsume() {},
    },
  ];
  for (const pinAttempts of cases) {
    const bridge = new ProductionPiActionApprovalBridge(pinAttempts);
    bridge.attachClient("session-unavailable", "client-a");
    const pending = bridge.requestApproval("session-unavailable", actionInput());
    const [request] = bridge.getPendingRequests("session-unavailable");
    assert.deepEqual(
      await bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, true, "12345678"),
      { status: "denied", errorCode: "pin_unavailable" },
    );
    assert.equal((await pending).status, "denied");
    assert.deepEqual(bridge.getPendingRequests(request.sessionId), []);
  }
});

test("cooldown and adapter busy never approve and leave a live action retryable", async () => {
  const retryAt = Date.now() + 30_000;
  for (const reserveResult of [
    { status: "cooldown" as const, retryAt },
    { status: "busy" as const },
  ]) {
    let attempts = 0;
    const pinAttempts: SettingsPinAttemptPort = {
      async reserve() { attempts += 1; return reserveResult; },
      async verifyAndConsume() { throw new Error("verification must not run"); },
      async cancelAndConsume() {},
    };
    const bridge = new ProductionPiActionApprovalBridge(pinAttempts);
    bridge.attachClient("session-retry", "client-a");
    const pending = bridge.requestApproval("session-retry", actionInput());
    const [request] = bridge.getPendingRequests("session-retry");
    const response = await bridge.respondForSession(
      request.sessionId,
      request.requestId,
      request.argumentsHash,
      true,
      "12345678",
    );
    assert.deepEqual(response, reserveResult.status === "cooldown"
      ? { status: "rejected", errorCode: "cooldown", retryAt }
      : { status: "rejected", errorCode: "realm_busy" });
    assert.equal(attempts, 1);
    assert.deepEqual(bridge.getPendingRequests(request.sessionId), [request]);
    assert.deepEqual(
      await bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, false),
      { status: "denied" },
    );
    assert.equal((await pending).status, "denied");
  }
});

test("exact request, session, and hash validation precedes every PIN attempt", async () => {
  let attempts = 0;
  const pinAttempts: SettingsPinAttemptPort = {
    async reserve() { attempts += 1; return { status: "reserved" }; },
    async verifyAndConsume() { return { status: "verified" }; },
    async cancelAndConsume() {},
  };
  const bridge = new ProductionPiActionApprovalBridge(pinAttempts);
  bridge.attachClient("session-exact", "client-a");
  const pending = bridge.requestApproval("session-exact", actionInput());
  const [request] = bridge.getPendingRequests("session-exact");

  assert.equal((await bridge.respondForSession("other", request.requestId, request.argumentsHash, true, "12345678")).status, "rejected");
  assert.equal((await bridge.respondForSession(request.sessionId, request.requestId, argumentsHash("other"), true, "12345678")).status, "rejected");
  assert.equal((await bridge.respondForSession(request.sessionId, "invented", request.argumentsHash, true, "12345678")).status, "stale");
  assert.equal((await bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, "true", "12345678")).status, "rejected");
  assert.equal(attempts, 0);
  await bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, false);
  assert.equal((await pending).status, "denied");
});

test("concurrent approval responses cannot double-attempt or outrun direct denial", async () => {
  let releaseReservation!: (result: ReservePinAttemptResult) => void;
  let reserveCalls = 0;
  let verifyCalls = 0;
  let cancelCalls = 0;
  const pinAttempts: SettingsPinAttemptPort = {
    reserve() {
      reserveCalls += 1;
      return new Promise<ReservePinAttemptResult>((resolve) => { releaseReservation = resolve; });
    },
    async verifyAndConsume() { verifyCalls += 1; return { status: "verified" }; },
    async cancelAndConsume() { cancelCalls += 1; },
  };
  const bridge = new ProductionPiActionApprovalBridge(pinAttempts);
  bridge.attachClient("session-race", "client-a");
  const pending = bridge.requestApproval("session-race", actionInput());
  const [request] = bridge.getPendingRequests("session-race");
  const firstApproval = bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, true, "12345678");

  assert.deepEqual(
    await bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, true, "12345678"),
    { status: "rejected", errorCode: "realm_busy" },
  );
  assert.deepEqual(
    await bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, false),
    { status: "denied" },
  );
  releaseReservation({ status: "reserved" });
  assert.deepEqual(await firstApproval, { status: "stale", errorCode: "request_not_pending" });
  assert.equal((await pending).status, "denied");
  assert.equal(reserveCalls, 1);
  assert.equal(verifyCalls, 0);
  assert.equal(cancelCalls, 1);
});

test("display metadata rejects format, bidi, unsafe controls, and unpaired surrogates", async () => {
  const unsafeCases: Array<{ sessionId?: string; input: ExternalActionRequestInput }> = [
    { sessionId: "session\u2066isolate", input: actionInput({ argumentsHash: "session-bidi" }) },
    { input: actionInput({ connector: "linear\u202Eoverride", argumentsHash: "connector-bidi" }) },
    { input: actionInput({ workspace: "workspace\u200Bhidden", argumentsHash: "workspace-format" }) },
    { input: actionInput({ toolName: "create\u2069issue", argumentsHash: "tool-bidi" }) },
    { input: actionInput({ target: "TEAM\u061C-1", argumentsHash: "target-format" }) },
    { input: actionInput({ summary: "Approve\u202Edenied", argumentsHash: "summary-bidi" }) },
    { input: actionInput({ summary: "unsafe\u0000summary", argumentsHash: "summary-control" }) },
    { input: actionInput({ summary: "unsafe\u000bsummary", argumentsHash: "summary-vertical-tab" }) },
    { input: actionInput({ summary: "unpaired\uD800summary", argumentsHash: "summary-surrogate" }) },
  ];
  for (const { sessionId = "session-display", input } of unsafeCases) {
    const bridge = new ProductionPiActionApprovalBridge(LEGACY_TEST_PIN_ATTEMPTS);
    bridge.attachClient(sessionId, "client-a");
    assert.deepEqual(
      await bridge.requestApproval(sessionId, input),
      decision("denied", null, sessionId, input.argumentsHash),
    );
    assert.deepEqual(bridge.getPendingRequests(sessionId), []);
  }

  const bridge = new ProductionPiActionApprovalBridge(LEGACY_TEST_PIN_ATTEMPTS);
  bridge.attachClient("session-safe-summary", "client-a");
  const input = actionInput({ summary: "First line\r\n\tindented second line", argumentsHash: "safe-summary" });
  const pending = bridge.requestApproval("session-safe-summary", input);
  const [request] = bridge.getPendingRequests("session-safe-summary");
  assert.equal(request.summary, input.summary);
  await bridge.respondForSession(request.sessionId, request.requestId, request.argumentsHash, false);
  assert.equal((await pending).status, "denied");
});

test("action approval singleton satisfies the exported bridge contract", () => {
  const first: ActionApprovalBridge = getActionApprovalBridge();
  const second = getActionApprovalBridge();

  assert.strictEqual(first, second);
  assert.strictEqual(
    (globalThis as typeof globalThis & {
      __pi_action_approval_bridge?: ProductionPiActionApprovalBridge;
    }).__pi_action_approval_bridge,
    first,
  );
});
