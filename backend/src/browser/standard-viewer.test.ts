import assert from "node:assert/strict";
import test from "node:test";
import { openStandardCdpViewer, StandardViewerInputError, type StandardViewerInputCategory, type StandardViewerObservation } from "./standard-viewer.js";

class SynchronousFrameCdp {
  readonly calls: Array<{ method: string; params?: unknown }> = [];
  private readonly listeners = new Map<string, Set<(params: any) => void>>();

  constructor(private readonly failStart = false) {}

  emitFrame(text: string, sessionId: number): void {
    for (const listener of this.listeners.get("Page.screencastFrame") ?? []) {
      listener({ data: Buffer.from(text).toString("base64"), metadata: { deviceWidth: sessionId }, sessionId });
    }
  }

  async send<T = any>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params });
    if (method === "Page.startScreencast") {
      this.emitFrame("first", 7);
      this.emitFrame("latest", 8);
      if (this.failStart) throw new Error("synthetic start failure");
    }
    if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "frame", loaderId: "loader" } } } as T;
    if (method === "Runtime.evaluate") return { result: { value: { url: "about:blank", title: "", readyState: "complete" } } } as T;
    return {} as T;
  }

  on(method: string, listener: (params: any) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close(): void {}
}

test("Standard viewer retains the latest synchronous initial frame until the WebSocket subscribes", async () => {
  const cdp = new SynchronousFrameCdp();
  let attachmentCloses = 0;
  let revocations = 0;
  const viewer = await openStandardCdpViewer({
    attachment: {
      cdp: cdp as any,
      target: { id: "target", type: "page", url: "about:blank", title: "" } as any,
      close() { attachmentCloses += 1; },
    },
    async authorize() {},
    async revoke() { revocations += 1; },
  });

  // Frame authorization is intentionally asynchronous even when CDP emitted
  // synchronously from startScreencast.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const received: Array<{ message: Buffer; binary: boolean }> = [];
  const unsubscribe = viewer.onMessage((message, binary) => received.push({ message, binary }));
  assert.equal(received.length, 1, "only the latest pre-consumer frame is retained");
  assert.equal(received[0]!.binary, false);
  const frame = JSON.parse(received[0]!.message.toString("utf8"));
  assert.equal(frame.type, "frame");
  assert.equal(frame.sessionId, 8);
  assert.equal(frame.metadata.deviceWidth, 8);
  assert.equal(frame.dataUrl, `data:image/jpeg;base64,${Buffer.from("latest").toString("base64")}`);

  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "frame-ack", sessionId: 8 })), false);
  assert.equal(cdp.calls.some((call) => call.method === "Page.screencastFrameAck"), true);

  const burstCdp = new SynchronousFrameCdp();
  let currentAuthorizationGate: Promise<void> | null = null;
  const gated = await openStandardCdpViewer({
    attachment: { cdp: burstCdp as any, target: { id: "target", type: "page", url: "about:blank", title: "" } as any, close() {} },
    async authorize() { if (currentAuthorizationGate) await currentAuthorizationGate; },
    async revoke() { revocations += 1; },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  const gatedReceived: Buffer[] = [];
  gated.onMessage((message) => gatedReceived.push(message));
  gatedReceived.length = 0;
  let releaseBurst!: () => void;
  currentAuthorizationGate = new Promise<void>((resolve) => { releaseBurst = resolve; });
  for (let index = 20; index < 120; index += 1) burstCdp.emitFrame(`burst-${index}`, index);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gatedReceived.length, 0, "authorization gate withholds the coalesced frame");
  currentAuthorizationGate = null;
  releaseBurst();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(gatedReceived.length, 1, "the burst remains bounded to one released frame");
  assert.equal(JSON.parse(gatedReceived[0]!.toString("utf8")).sessionId, 119);
  assert.equal(revocations, 0);
  await gated.close();
  unsubscribe();
  await viewer.close();
  assert.equal(attachmentCloses, 1);
});

class InteractiveCdp {
  readonly calls: Array<{ method: string; params?: any }> = [];
  readonly listeners = new Map<string, Set<(params: any) => void>>();
  pointerPressed = false;
  clicks = 0;
  failInputDispatch = false;
  failAttestation = false;
  inputDispatchGate: Promise<void> | null = null;
  attestationGate: Promise<void> | null = null;
  runtimeEvaluationGate: Promise<void> | null = null;
  runtimeEvaluationGateAt = 0;
  runtimeEvaluationCalls = 0;

  async send<T = any>(method: string, params?: any): Promise<T> {
    this.calls.push({ method, params });
    if (method === "Input.dispatchMouseEvent") {
      if (this.inputDispatchGate) await this.inputDispatchGate;
      if (this.failInputDispatch) throw new Error("synthetic CDP failure");
      if (params?.type === "mousePressed") this.pointerPressed = true;
      if (params?.type === "mouseReleased" && this.pointerPressed) {
        this.pointerPressed = false;
        this.clicks += 1;
      }
    }
    if (method === "Page.getFrameTree") {
      if (this.attestationGate) await this.attestationGate;
      if (this.failAttestation) return {} as T;
      return { frameTree: { frame: { id: "frame", loaderId: "loader" } } } as T;
    }
    if (method === "Runtime.evaluate") {
      this.runtimeEvaluationCalls += 1;
      if (this.runtimeEvaluationGate && this.runtimeEvaluationCalls === this.runtimeEvaluationGateAt) await this.runtimeEvaluationGate;
      return { result: { value: { url: "https://example.test/", title: "Synthetic", readyState: "complete" } } } as T;
    }
    return {} as T;
  }

  on(method: string, listener: (params: any) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  emit(method: string, params: any): void {
    for (const listener of this.listeners.get(method) ?? []) listener(params);
  }

  close(): void {}
}

async function interactiveViewer(cdp: InteractiveCdp, options: {
  authorize?: () => Promise<void>;
  observe?: (event: StandardViewerObservation) => void;
  onAttachmentClose?: () => void;
  onRevoke?: () => void;
} = {}) {
  return openStandardCdpViewer({
    attachment: {
      cdp: cdp as any,
      target: { id: "target", type: "page", url: "https://example.test/", title: "Synthetic" } as any,
      close() { options.onAttachmentClose?.(); },
    },
    authorize: options.authorize ?? (async () => undefined),
    async revoke() { options.onRevoke?.(); },
    observe: options.observe,
  });
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("synthetic viewer condition timed out");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

test("pointer, keyboard, and wheel dispatch stay responsive while every navigation-capable event attests", async () => {
  const cdp = new InteractiveCdp();
  const observations: StandardViewerObservation[] = [];
  const viewer = await interactiveViewer(cdp, { observe: (event) => observations.push({ ...event }) });
  assert.ok(observations.some((event) => event.event === "attestation" && event.category === "viewer_open" && event.outcome === "accepted"));

  let releaseAttestation!: () => void;
  cdp.attestationGate = new Promise<void>((resolve) => { releaseAttestation = resolve; });
  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "mouse", event: "down", x: 10, y: 20, button: "left" })), false);
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(cdp.pointerPressed, true);
  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "mouse", event: "up", x: 10, y: 20, button: "left" })), false);
  assert.equal(cdp.pointerPressed, false);
  assert.equal(cdp.clicks, 1, "mouse release dispatch is not held behind press attestation");

  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "key", event: "down", key: "s", code: "KeyS" })), false);
  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "key", event: "up", key: "s", code: "KeyS" })), false);
  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "mouse", event: "move", x: 11, y: 21 })), false);
  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "mouse", event: "wheel", x: 10, y: 20, deltaY: 4 })), false);
  cdp.attestationGate = null;
  releaseAttestation();

  const expectedCategories: StandardViewerInputCategory[] = ["mouse_down", "mouse_up", "key_down", "key_up", "mouse_move", "wheel"];
  assert.ok(expectedCategories.every((category) => observations.some((event) => (
    event.event === "input_received" && event.category === category
  ))), "every event category is observed without payload values");
  await waitUntil(() => observations.some((event) => (
    event.event === "attestation" && event.category === "wheel" && event.outcome === "accepted"
  )));
  const burstAttestations = observations.filter((event) => event.event === "attestation" && event.category !== "viewer_open");
  assert.ok(burstAttestations.length <= 2, "the dirty generation lane coalesces a burst without unbounded queue growth");
  assert.doesNotMatch(JSON.stringify(observations), /Synthetic|example\.test|KeyS|\"s\"/, "telemetry excludes page and key values");
  await viewer.close();
});

test("stalled hundreds-of-moves input remains open and delivers the final coordinates", async () => {
  const cdp = new InteractiveCdp();
  let releaseDispatch!: () => void;
  cdp.inputDispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const viewer = await interactiveViewer(cdp);
  const reasons: Array<string | undefined> = [];
  viewer.onClose?.((reason) => reasons.push(reason));

  const dispatches: Promise<void>[] = [];
  for (let index = 0; index < 300; index += 1) {
    dispatches.push(Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
      type: "mouse", event: "move", x: index, y: index + 1,
    })), false)));
  }
  await waitUntil(() => cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent"));
  assert.deepEqual(reasons, [], "coalescible movement does not trip the discrete abuse bound");
  cdp.inputDispatchGate = null;
  releaseDispatch();
  await Promise.all(dispatches);

  const moves = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mouseMoved");
  assert.equal(moves.length, 2, "one active and one newest pending movement are dispatched");
  assert.equal(moves.at(-1)?.params?.x, 299);
  assert.equal(moves.at(-1)?.params?.y, 300);
  assert.deepEqual(reasons, [], "the viewer remains open after the movement burst");
  await viewer.close();
});

test("stalled wheel bursts aggregate into one finite pending dispatch", async () => {
  const cdp = new InteractiveCdp();
  let releaseDispatch!: () => void;
  cdp.inputDispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const viewer = await interactiveViewer(cdp);

  const dispatches: Promise<void>[] = [];
  for (let index = 0; index < 200; index += 1) {
    dispatches.push(Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
      type: "mouse", event: "wheel", x: index, y: index + 1, deltaX: 1, deltaY: -2,
    })), false)));
  }
  await waitUntil(() => cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent"));
  cdp.inputDispatchGate = null;
  releaseDispatch();
  await Promise.all(dispatches);

  const wheels = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent" && call.params?.type === "mouseWheel");
  assert.equal(wheels.length, 2, "one active and one aggregated pending wheel event are dispatched");
  assert.equal(wheels[0]!.params.deltaX + wheels[1]!.params.deltaX, 200);
  assert.equal(wheels[0]!.params.deltaY + wheels[1]!.params.deltaY, -400);
  assert.equal(wheels.at(-1)?.params?.x, 199, "the aggregate uses the newest burst coordinates");
  assert.equal(Number.isFinite(wheels.at(-1)?.params?.deltaX), true);
  assert.equal(Number.isFinite(wheels.at(-1)?.params?.deltaY), true);
  await viewer.close();
});

test("mouse moves around down and up remain separated by click-order barriers", async () => {
  const cdp = new InteractiveCdp();
  let releaseDispatch!: () => void;
  cdp.inputDispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const viewer = await interactiveViewer(cdp);
  const dispatches: Promise<void>[] = [];
  const dispatchMouse = (event: "move" | "down" | "up", x: number) => {
    dispatches.push(Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
      type: "mouse", event, x, y: x + 1, button: "left",
    })), false)));
  };

  for (let index = 0; index <= 100; index += 1) dispatchMouse("move", index);
  dispatchMouse("down", 101);
  for (let index = 102; index <= 201; index += 1) dispatchMouse("move", index);
  dispatchMouse("up", 202);
  for (let index = 203; index <= 302; index += 1) dispatchMouse("move", index);
  await waitUntil(() => cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent"));
  cdp.inputDispatchGate = null;
  releaseDispatch();
  await Promise.all(dispatches);

  const pointerCalls = cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent");
  assert.deepEqual(pointerCalls.map((call) => [call.params.type, call.params.x]), [
    ["mouseMoved", 0],
    ["mouseMoved", 100],
    ["mousePressed", 101],
    ["mouseMoved", 201],
    ["mouseReleased", 202],
    ["mouseMoved", 302],
  ]);
  assert.equal(cdp.clicks, 1);
  assert.equal(cdp.pointerPressed, false);
  await viewer.close();
});

test("closing during stalled input rejects the active, coalesced, and discrete callers promptly", async () => {
  const cdp = new InteractiveCdp();
  let releaseDispatch!: () => void;
  cdp.inputDispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const observations: StandardViewerObservation[] = [];
  const viewer = await interactiveViewer(cdp, { observe: (event) => observations.push({ ...event }) });

  const active = Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
    type: "mouse", event: "move", x: 1, y: 2,
  })), false));
  await waitUntil(() => cdp.calls.some((call) => call.method === "Input.dispatchMouseEvent"));
  const coalescedA = Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
    type: "mouse", event: "move", x: 3, y: 4,
  })), false));
  const coalescedB = Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
    type: "mouse", event: "move", x: 5, y: 6,
  })), false));
  const discrete = Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
    type: "mouse", event: "down", x: 7, y: 8, button: "left",
  })), false));

  await viewer.close();
  for (const pending of [active, coalescedA, coalescedB, discrete]) {
    await assert.rejects(pending, (error: unknown) => (
      error instanceof StandardViewerInputError && error.reason === "viewer_closed"
    ));
  }
  const closeIndex = observations.findIndex((event) => event.event === "viewer_close");
  assert.notEqual(closeIndex, -1);

  cdp.inputDispatchGate = null;
  releaseDispatch();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(observations.slice(closeIndex + 1).some((event) => event.outcome === "accepted"), false,
    "no input reports accepted after viewer_close");
});

test("more than 64 blocked discrete inputs still close with input_queue_full", async () => {
  const cdp = new InteractiveCdp();
  let releaseDispatch!: () => void;
  cdp.inputDispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const viewer = await interactiveViewer(cdp);
  const reasons: Array<string | undefined> = [];
  viewer.onClose?.((reason) => reasons.push(reason));
  const blocked: Array<Promise<unknown>> = [];

  for (let index = 0; index < 64; index += 1) {
    blocked.push(Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
      type: "mouse", event: "down", x: index, y: index, button: "left",
    })), false)).catch((error) => error));
  }
  await assert.rejects(
    Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
      type: "mouse", event: "up", x: 64, y: 64, button: "left",
    })), false)),
    (error: unknown) => error instanceof StandardViewerInputError && error.reason === "input_queue_full",
  );
  assert.deepEqual(reasons, ["input_queue_full"]);

  cdp.inputDispatchGate = null;
  releaseDispatch();
  const outcomes = await Promise.all(blocked);
  assert.equal(outcomes.filter((outcome) => (
    outcome instanceof StandardViewerInputError && outcome.reason === "input_queue_full"
  )).length, 64, "the active and queued discrete dispatches all reject when the viewer seals");
  assert.ok(cdp.calls.filter((call) => call.method === "Input.dispatchMouseEvent").length <= 1,
    "at most the already-active discrete dispatch can reach CDP before sealing");
  await viewer.close();
});

test("authenticated viewer paste inserts bounded text without exposing its value to telemetry", async () => {
  const cdp = new InteractiveCdp();
  const observations: StandardViewerObservation[] = [];
  const viewer = await interactiveViewer(cdp, { observe: (event) => observations.push({ ...event }) });
  const text = "synthetic-paste-canary";

  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "paste", text })), false);
  assert.ok(cdp.calls.some((call) => call.method === "Input.insertText" && call.params?.text === text));
  await waitUntil(() => observations.some((event) => (
    event.event === "attestation" && event.category === "paste" && event.outcome === "accepted"
  )));
  assert.ok(observations.some((event) => event.event === "input_received" && event.category === "paste"));
  assert.doesNotMatch(JSON.stringify(observations), /synthetic-paste-canary/, "paste text is excluded from telemetry");
  await viewer.close();

  const invalidMessages = [
    { type: "paste", text: "" },
    { type: "paste", text: "synthetic", extra: true },
    { type: "paste", text: "x".repeat(4_097) },
    { type: "paste", text: "nul\0text" },
    { type: "paste", text: "unpaired-\ud800" },
  ];
  for (const message of invalidMessages) {
    const invalidViewer = await interactiveViewer(new InteractiveCdp());
    await assert.rejects(
      Promise.resolve(invalidViewer.dispatch(Buffer.from(JSON.stringify(message)), false)),
      (error: unknown) => error instanceof StandardViewerInputError && error.reason === "input_invalid",
    );
    await invalidViewer.close();
  }
});

test("input authorization, CDP dispatch, and attestation failures seal with stable bounded reasons", async () => {
  for (const scenario of ["authorization", "dispatch", "attestation"] as const) {
    const cdp = new InteractiveCdp();
    let deny = false;
    let attachmentCloses = 0;
    let revocations = 0;
    const viewer = await interactiveViewer(cdp, {
      async authorize() { if (deny) throw new Error("private raw authority detail"); },
      onAttachmentClose() { attachmentCloses += 1; },
      onRevoke() { revocations += 1; },
    });
    const reasons: Array<string | undefined> = [];
    viewer.onClose?.((reason) => reasons.push(reason));
    if (scenario === "authorization") deny = true;
    if (scenario === "dispatch") cdp.failInputDispatch = true;
    if (scenario === "attestation") cdp.failAttestation = true;
    const message = scenario === "attestation"
      ? { type: "mouse", event: "up", x: 1, y: 1 }
      : { type: "mouse", event: "down", x: 1, y: 1 };
    const expected = scenario === "authorization"
      ? "input_authorization_failed"
      : scenario === "dispatch" ? "input_dispatch_failed" : "input_attestation_failed";
    const dispatch = () => Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify(message)), false));
    if (scenario === "attestation") {
      await dispatch();
      await waitUntil(() => reasons.length === 1);
      assert.equal(revocations, 1, "unverified documents revoke the retained workspace before retry");
    } else {
      await assert.rejects(
        dispatch,
        (error: unknown) => error instanceof StandardViewerInputError && error.reason === expected,
      );
      assert.equal(revocations, 0);
    }
    assert.deepEqual(reasons, [expected]);
    assert.equal(attachmentCloses, 1);
    await viewer.close();
    assert.equal(attachmentCloses, 1, "sealing is idempotent");
  }
});

test("authority changing during CDP dispatch seals before stale input can report success", async () => {
  const cdp = new InteractiveCdp();
  let deny = false;
  let releaseDispatch!: () => void;
  const viewer = await interactiveViewer(cdp, {
    async authorize() { if (deny) throw new Error("synthetic authority changed"); },
  });
  const reasons: Array<string | undefined> = [];
  viewer.onClose?.((reason) => reasons.push(reason));
  cdp.inputDispatchGate = new Promise<void>((resolve) => { releaseDispatch = resolve; });
  const dispatching = Promise.resolve(viewer.dispatch(Buffer.from(JSON.stringify({
    type: "mouse", event: "down", x: 1, y: 1,
  })), false));
  await new Promise<void>((resolve) => setImmediate(resolve));
  deny = true;
  cdp.inputDispatchGate = null;
  releaseDispatch();
  await assert.rejects(
    dispatching,
    (error: unknown) => error instanceof StandardViewerInputError && error.reason === "input_authorization_failed",
  );
  assert.deepEqual(reasons, ["input_authorization_failed"]);
});

test("authority changing during final attestation evaluation cannot publish stale metadata", async () => {
  const cdp = new InteractiveCdp();
  let deny = false;
  let revocations = 0;
  const observations: StandardViewerObservation[] = [];
  const viewer = await interactiveViewer(cdp, {
    async authorize() { if (deny) throw new Error("synthetic authority changed"); },
    onRevoke() { revocations += 1; },
    observe(event) { observations.push({ ...event }); },
  });
  const initialRuntimeCalls = cdp.runtimeEvaluationCalls;
  let releaseEvaluation!: () => void;
  cdp.runtimeEvaluationGateAt = initialRuntimeCalls + 2;
  cdp.runtimeEvaluationGate = new Promise<void>((resolve) => { releaseEvaluation = resolve; });
  const reasons: Array<string | undefined> = [];
  viewer.onClose?.((reason) => reasons.push(reason));
  await viewer.dispatch(Buffer.from(JSON.stringify({ type: "mouse", event: "down", x: 1, y: 1 })), false);
  await waitUntil(() => cdp.runtimeEvaluationCalls === cdp.runtimeEvaluationGateAt);
  deny = true;
  cdp.runtimeEvaluationGate = null;
  releaseEvaluation();
  await waitUntil(() => reasons.length === 1);
  assert.deepEqual(reasons, ["input_authorization_failed"]);
  assert.equal(revocations, 1);
  assert.equal(observations.some((event) => event.event === "attestation" && event.category === "mouse_down" && event.outcome === "accepted"), false);
});

test("committed forbidden top-level navigation revokes immediately even between attestations", async () => {
  const cdp = new InteractiveCdp();
  let attachmentCloses = 0;
  let revocations = 0;
  const viewer = await interactiveViewer(cdp, {
    onAttachmentClose() { attachmentCloses += 1; },
    onRevoke() { revocations += 1; },
  });
  const reasons: Array<string | undefined> = [];
  viewer.onClose?.((reason) => reasons.push(reason));
  cdp.emit("Page.frameNavigated", { frame: { id: "frame", url: "http://forbidden.example.test/" } });
  await waitUntil(() => reasons.length === 1);
  assert.deepEqual(reasons, ["input_attestation_failed"]);
  assert.equal(revocations, 1);
  assert.equal(attachmentCloses, 1);
});

test("viewer opening fails closed before publication when the initial document cannot be attested", async () => {
  const cdp = new InteractiveCdp();
  cdp.failAttestation = true;
  let attachmentCloses = 0;
  let revocations = 0;
  await assert.rejects(
    () => interactiveViewer(cdp, {
      onAttachmentClose() { attachmentCloses += 1; },
      onRevoke() { revocations += 1; },
    }),
    (error: unknown) => error instanceof StandardViewerInputError && error.reason === "input_attestation_failed",
  );
  assert.equal(attachmentCloses, 1);
  assert.equal(revocations, 1);
});

test("close releases the attachment while frame authorization is delayed", async () => {
  const cdp = new SynchronousFrameCdp();
  let currentGate: Promise<void> | null = null;
  let releaseGate!: () => void;
  let attachmentCloses = 0;
  let revocations = 0;
  const viewer = await openStandardCdpViewer({
    attachment: {
      cdp: cdp as any,
      target: { id: "target", type: "page", url: "about:blank", title: "" } as any,
      close() { attachmentCloses += 1; },
    },
    async authorize() { if (currentGate) await currentGate; },
    async revoke() { revocations += 1; },
  });
  await new Promise<void>((resolve) => setImmediate(resolve));
  currentGate = new Promise<void>((resolve) => { releaseGate = resolve; });
  cdp.emitFrame("blocked", 22);
  await new Promise<void>((resolve) => setImmediate(resolve));
  await viewer.close();
  assert.equal(attachmentCloses, 1, "close does not wait for frame authorization");
  releaseGate();
  currentGate = null;
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(revocations, 0);
});

test("failed construction cannot re-buffer a frame after delayed authorization", async () => {
  const cdp = new SynchronousFrameCdp(true);
  let authorizationCalls = 0;
  let releaseFrame!: () => void;
  const frameGate = new Promise<void>((resolve) => { releaseFrame = resolve; });
  let attachmentCloses = 0;
  let revocations = 0;
  const opening = openStandardCdpViewer({
    attachment: {
      cdp: cdp as any,
      target: { id: "target", type: "page", url: "about:blank", title: "" } as any,
      close() { attachmentCloses += 1; },
    },
    async authorize() {
      authorizationCalls += 1;
      if (authorizationCalls === 4) await frameGate;
    },
    async revoke() { revocations += 1; },
  });
  await assert.rejects(opening, /synthetic start failure/);
  assert.equal(attachmentCloses, 1);
  releaseFrame();
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(revocations, 0, "closed failed construction suppresses delayed frame work");
});
