import assert from "node:assert/strict";
import test from "node:test";
import { openStandardCdpViewer } from "./standard-viewer.js";

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
