import type { CdpConnection, ChromeTarget } from "./cdp.js";
import { guardedSend, settledTopLevelDocument } from "./guarded-page.js";
import { isProtectedBrowserAllowedTopLevelUrl } from "./protected-browser.js";
import type { ProtectedBrowserViewerTransport } from "../routes/protected-browser.js";

const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_INTERVAL_MS = 50;
const STANDARD_VIEWER_PASTE_MAX_CHARS = 4_096;
const STANDARD_VIEWER_PASTE_MAX_BYTES = 16_384;
const STANDARD_VIEWER_WHEEL_DELTA_MAX = Number.MAX_SAFE_INTEGER;

export type StandardViewerFailureReason =
  | "viewer_closed"
  | "viewer_authorization_failed"
  | "input_invalid"
  | "input_queue_full"
  | "input_authorization_failed"
  | "input_dispatch_failed"
  | "input_attestation_failed";

export type StandardViewerInputCategory =
  | "viewer_open"
  | "frame_ack"
  | "mouse_down"
  | "mouse_up"
  | "mouse_move"
  | "wheel"
  | "key_down"
  | "key_up"
  | "paste";

export interface StandardViewerObservation {
  event: "input_received" | "authority" | "cdp_dispatch" | "attestation" | "viewer_close";
  category?: StandardViewerInputCategory;
  outcome: "accepted" | "rejected" | "timed_out" | "closed";
  reason?: StandardViewerFailureReason;
  latencyBucket?: "lt_10ms" | "lt_100ms" | "lt_1s" | "gte_1s";
}

export class StandardViewerInputError extends Error {
  constructor(readonly reason: StandardViewerFailureReason) {
    super(reason);
    this.name = "StandardViewerInputError";
  }
}

function latencyBucket(startedAt: number): StandardViewerObservation["latencyBucket"] {
  const elapsed = Date.now() - startedAt;
  if (elapsed < 10) return "lt_10ms";
  if (elapsed < 100) return "lt_100ms";
  if (elapsed < 1_000) return "lt_1s";
  return "gte_1s";
}

function inputCategory(message: any): StandardViewerInputCategory | null {
  if (message?.type === "frame-ack") return "frame_ack";
  if (message?.type === "mouse") {
    if (message.event === "down") return "mouse_down";
    if (message.event === "up") return "mouse_up";
    if (message.event === "move") return "mouse_move";
    if (message.event === "wheel") return "wheel";
    return null;
  }
  if (message?.type === "key") {
    if (message.event === "down") return "key_down";
    if (message.event === "up") return "key_up";
  }
  if (message?.type === "paste") return "paste";
  return null;
}

function exactPasteText(value: unknown): string | null {
  if (typeof value !== "string" || !value || value.length > STANDARD_VIEWER_PASTE_MAX_CHARS
    || Buffer.byteLength(value, "utf8") > STANDARD_VIEWER_PASTE_MAX_BYTES || value.includes("\0")) return null;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return null;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return null;
    }
  }
  return value;
}

function keyCodeFor(key: string): number | undefined {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return ({ Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 } as Record<string, number>)[key];
}

function normalizedWheelDelta(value: unknown): number | null {
  if (value === undefined) return 0;
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(-STANDARD_VIEWER_WHEEL_DELTA_MAX, Math.min(STANDARD_VIEWER_WHEEL_DELTA_MAX, value));
}

function aggregateWheelDelta(current: number, next: number): number {
  return Math.max(-STANDARD_VIEWER_WHEEL_DELTA_MAX, Math.min(STANDARD_VIEWER_WHEEL_DELTA_MAX, current + next));
}

export async function openStandardCdpViewer(options: {
  attachment: { cdp: Pick<CdpConnection, "send" | "on" | "close">; target: ChromeTarget; close(): void };
  authorize(): Promise<void>;
  revoke(): Promise<void>;
  redact?(value: unknown): unknown;
  observe?(event: Readonly<StandardViewerObservation>): void;
}): Promise<ProtectedBrowserViewerTransport> {
  const { cdp, target } = options.attachment;
  const listeners = new Set<(message: Buffer, isBinary: boolean) => void>();
  const closeListeners = new Set<(reason?: string) => void>();
  type QueuedViewerInput = {
    category: StandardViewerInputCategory;
    message: any;
    discrete: boolean;
    counted: boolean;
    settled: boolean;
    done: Promise<void>;
    resolve(): void;
    reject(error: StandardViewerInputError): void;
  };
  const MAX_VIEWER_INPUT_QUEUE = 64;
  const inputQueue: QueuedViewerInput[] = [];
  let activeInput: QueuedViewerInput | null = null;
  let discreteInputDepth = 0;
  let inputPump: Promise<void> | null = null;
  let closed = false;
  let attachmentClosed = false;
  let pendingMessage: { bytes: Buffer; isBinary: boolean } | null = null;
  let pendingFrame: any | null = null;
  let framePump: Promise<void> | null = null;
  let inputGeneration = 0;
  let attestedGeneration = 0;
  let pendingAttestationCategory: StandardViewerInputCategory = "viewer_open";
  let attestationPump: Promise<void> | null = null;
  let topFrameId: string | null = null;
  let offFrame: (() => void) | null = null;
  let offFrameNavigated: (() => void) | null = null;
  let offWithinDocument: (() => void) | null = null;
  const observe = (event: StandardViewerObservation) => {
    try { options.observe?.(event); } catch { /* diagnostics cannot affect viewer authority or input */ }
  };
  const seal = (reason: StandardViewerFailureReason = "viewer_closed"): boolean => {
    if (closed) return false;
    closed = true;
    offFrame?.();
    offFrameNavigated?.();
    offWithinDocument?.();
    offFrame = null;
    offFrameNavigated = null;
    offWithinDocument = null;
    pendingFrame = null;
    pendingMessage = null;
    const queuedError = new StandardViewerInputError(reason);
    const rejectInput = (entry: QueuedViewerInput) => {
      if (entry.counted) {
        entry.counted = false;
        discreteInputDepth -= 1;
      }
      entry.reject(queuedError);
    };
    if (activeInput) rejectInput(activeInput);
    for (const entry of inputQueue.splice(0)) rejectInput(entry);
    listeners.clear();
    observe({ event: "viewer_close", outcome: "closed", reason });
    for (const listener of closeListeners) {
      try { listener(reason); } catch { /* close notification is best effort */ }
    }
    closeListeners.clear();
    if (!attachmentClosed) {
      attachmentClosed = true;
      options.attachment.close();
    }
    return true;
  };
  const emit = (message: unknown) => {
    if (closed) return;
    const candidate = { bytes: Buffer.from(JSON.stringify(message)), isBinary: false };
    if (listeners.size === 0) {
      // Chromium may emit the initial frame synchronously from
      // Page.startScreencast, before openViewer() returns and the WebSocket
      // consumer can subscribe. Retain only the latest bounded JPEG envelope;
      // a static page may never repaint to replace a lost first frame.
      pendingMessage = candidate;
      return;
    }
    for (const listener of listeners) listener(candidate.bytes, candidate.isBinary);
  };
  const startFramePump = () => {
    if (closed || framePump || !pendingFrame) return;
    framePump = (async () => {
      while (!closed && pendingFrame) {
        // Authorization is binding-wide rather than frame-specific. Read the
        // retained frame only after authorization so arrivals during the await
        // coalesce into the one latest frame instead of promise-per-frame data.
        await options.authorize();
        if (closed) return;
        const latest = pendingFrame;
        pendingFrame = null;
        if (latest) {
          emit({ type: "frame", dataUrl: `data:image/jpeg;base64,${latest.data}`, metadata: latest.metadata, sessionId: latest.sessionId });
        }
      }
    })().catch(() => {
      if (seal("viewer_authorization_failed")) void options.revoke().catch(() => undefined);
    }).finally(() => {
      framePump = null;
      if (!closed && pendingFrame) startFramePump();
    });
  };
  const rejectUnsafeTopLevelNavigation = (url: unknown) => {
    if (closed || typeof url !== "string" || isProtectedBrowserAllowedTopLevelUrl(url)) return;
    if (seal("input_attestation_failed")) void options.revoke().catch(() => undefined);
  };
  // Subscribe before Page.enable/startScreencast so committed top-level
  // navigation cannot pass through a gap between input and later attestation.
  // This also covers script navigation from pointer movement and transient
  // forbidden documents that return to HTTPS before settlement completes.
  offFrameNavigated = cdp.on("Page.frameNavigated", (params: any) => {
    const frame = params?.frame;
    if (!frame || frame.parentId) return;
    if (typeof frame.id === "string") topFrameId = frame.id;
    rejectUnsafeTopLevelNavigation(frame.url);
  });
  offWithinDocument = cdp.on("Page.navigatedWithinDocument", (params: any) => {
    if (!topFrameId || params?.frameId !== topFrameId) return;
    rejectUnsafeTopLevelNavigation(params?.url);
  });
  // Subscribe before startScreencast so a synchronous initial emission cannot
  // fall into the construction gap. Retain only the latest unprocessed frame.
  offFrame = cdp.on("Page.screencastFrame", (params: any) => {
    if (closed) return;
    pendingFrame = params;
    startFramePump();
  });
  const authorizeConstruction = async () => {
    if (closed) throw new Error("Standard browser viewer closed during construction");
    await options.authorize();
  };
  try {
    await guardedSend(cdp, authorizeConstruction, "Page.enable");
    await guardedSend(cdp, authorizeConstruction, "Runtime.enable");
    await guardedSend(cdp, authorizeConstruction, "Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  } catch (error) {
    seal();
    throw error;
  }
  const authorizeInput = async (category: StandardViewerInputCategory) => {
    const startedAt = Date.now();
    try {
      if (closed) throw new StandardViewerInputError("viewer_closed");
      await options.authorize();
      if (closed) throw new StandardViewerInputError("viewer_closed");
      observe({ event: "authority", category, outcome: "accepted", latencyBucket: latencyBucket(startedAt) });
    } catch (error) {
      const reason = error instanceof StandardViewerInputError ? error.reason : "input_authorization_failed";
      observe({ event: "authority", category, outcome: "rejected", reason, latencyBucket: latencyBucket(startedAt) });
      throw error instanceof StandardViewerInputError ? error : new StandardViewerInputError(reason);
    }
  };
  const dispatchCdp = async (category: StandardViewerInputCategory, method: string, parameters: Record<string, unknown>) => {
    await authorizeInput(category);
    const startedAt = Date.now();
    try {
      await cdp.send(method, parameters);
      // A control transition can race an in-flight CDP command. Reauthorize
      // before reporting success or scheduling any follow-up attestation; the
      // remote effect cannot be undone, but the stale viewer is sealed.
      await authorizeInput(category);
      observe({ event: "cdp_dispatch", category, outcome: "accepted", latencyBucket: latencyBucket(startedAt) });
    } catch (error) {
      const reason = error instanceof StandardViewerInputError ? error.reason : "input_dispatch_failed";
      observe({ event: "cdp_dispatch", category, outcome: "rejected", reason, latencyBucket: latencyBucket(startedAt) });
      throw error instanceof StandardViewerInputError ? error : new StandardViewerInputError(reason);
    }
  };
  const attestAfterInput = async (category: StandardViewerInputCategory, publishPage = true) => {
    const startedAt = Date.now();
    try {
      const document = await settledTopLevelDocument(cdp, target, () => authorizeInput(category), SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
      if (closed) throw new StandardViewerInputError("viewer_closed");
      // The final Runtime.evaluate inside settlement may complete after a
      // control-generation change. Reauthorize before consuming or publishing
      // any result from that in-flight command.
      await authorizeInput(category);
      if (closed) throw new StandardViewerInputError("viewer_closed");
      topFrameId = document.frameId;
      if (!isProtectedBrowserAllowedTopLevelUrl(document.topLevelUrl)) {
        void options.revoke().catch(() => undefined);
        throw new StandardViewerInputError("input_attestation_failed");
      }
      if (publishPage) {
        const redacted = options.redact?.({ type: "page", url: document.topLevelUrl, title: document.title })
          ?? { type: "page", url: document.topLevelUrl, title: document.title };
        emit(redacted);
      }
      observe({ event: "attestation", category, outcome: "accepted", latencyBucket: latencyBucket(startedAt) });
    } catch (error) {
      const reason = error instanceof StandardViewerInputError ? error.reason : "input_attestation_failed";
      observe({
        event: "attestation",
        category,
        outcome: error instanceof Error && /did not settle/i.test(error.message) ? "timed_out" : "rejected",
        reason,
        latencyBucket: latencyBucket(startedAt),
      });
      throw error instanceof StandardViewerInputError ? error : new StandardViewerInputError(reason);
    }
  };
  const startAttestationPump = () => {
    if (closed || attestationPump || attestedGeneration === inputGeneration) return;
    attestationPump = (async () => {
      while (!closed && attestedGeneration !== inputGeneration) {
        const generation = inputGeneration;
        const category = pendingAttestationCategory;
        await attestAfterInput(category);
        attestedGeneration = generation;
      }
    })().catch((error) => {
      if (closed) return;
      const reason = error instanceof StandardViewerInputError ? error.reason : "input_attestation_failed";
      if (seal(reason)) void options.revoke().catch(() => undefined);
    }).finally(() => {
      attestationPump = null;
      startAttestationPump();
    });
  };
  const scheduleAttestation = (category: StandardViewerInputCategory) => {
    if (closed) return;
    inputGeneration += 1;
    pendingAttestationCategory = category;
    startAttestationPump();
  };
  const normalizeInputMessage = (message: any, category: StandardViewerInputCategory): any => {
    if (category === "frame_ack") {
      const sessionId = Number(message.sessionId);
      if (!Number.isSafeInteger(sessionId) || sessionId < 0) throw new StandardViewerInputError("input_invalid");
      return { type: "frame-ack", sessionId };
    }
    if (category === "paste") {
      if (Object.keys(message).sort().join("\0") !== "text\0type") throw new StandardViewerInputError("input_invalid");
      const text = exactPasteText(message.text);
      if (text === null) throw new StandardViewerInputError("input_invalid");
      return { type: "paste", text };
    }
    if (message.type === "mouse") {
      const x = Number(message.x);
      const y = Number(message.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) throw new StandardViewerInputError("input_invalid");
      const normalized = {
        type: "mouse",
        event: message.event,
        x,
        y,
        button: message.button === "right" ? "right" : message.button === "middle" ? "middle" : "left",
        deltaX: 0,
        deltaY: 0,
      };
      if (category === "wheel") {
        const deltaX = normalizedWheelDelta(message.deltaX);
        const deltaY = normalizedWheelDelta(message.deltaY);
        if (deltaX === null || deltaY === null) throw new StandardViewerInputError("input_invalid");
        normalized.deltaX = deltaX;
        normalized.deltaY = deltaY;
      }
      return normalized;
    }
    const key = typeof message.key === "string" ? message.key : "";
    if (!key) throw new StandardViewerInputError("input_invalid");
    return {
      type: "key",
      event: message.event,
      key,
      code: message.code || key,
      altKey: Boolean(message.altKey),
      ctrlKey: Boolean(message.ctrlKey),
      metaKey: Boolean(message.metaKey),
      shiftKey: Boolean(message.shiftKey),
    };
  };
  const processQueuedInput = async (entry: QueuedViewerInput) => {
    const { category, message } = entry;
    if (category === "frame_ack") {
      await dispatchCdp(category, "Page.screencastFrameAck", { sessionId: message.sessionId });
      return;
    }
    if (category === "paste") {
      await dispatchCdp(category, "Input.insertText", { text: message.text });
      // Input handlers may navigate synchronously, just like ordinary key
      // input, so paste joins the same coalesced document-attestation lane.
      scheduleAttestation(category);
      return;
    }
    if (message.type === "mouse") {
      const type = message.event === "down" ? "mousePressed" : message.event === "up" ? "mouseReleased" : message.event === "wheel" ? "mouseWheel" : "mouseMoved";
      await dispatchCdp(category, "Input.dispatchMouseEvent", {
        type,
        x: message.x,
        y: message.y,
        button: message.button,
        clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
        deltaX: message.deltaX,
        deltaY: message.deltaY,
      });
      // Every pointer event can trigger page script navigation. Mark the
      // document dirty, but keep verification on a genuinely coalescing
      // generation lane so release is never held behind press settlement.
      scheduleAttestation(category);
      return;
    }
    if (message.event === "down" && message.key.length === 1 && !message.ctrlKey && !message.metaKey && !message.altKey) {
      await dispatchCdp(category, "Input.insertText", { text: message.key });
    } else {
      await dispatchCdp(category, "Input.dispatchKeyEvent", {
        type: message.event === "up" ? "keyUp" : "rawKeyDown",
        key: message.key,
        code: message.code,
        windowsVirtualKeyCode: keyCodeFor(message.key),
        nativeVirtualKeyCode: keyCodeFor(message.key),
        modifiers: (message.altKey ? 1 : 0) | (message.ctrlKey ? 2 : 0) | (message.metaKey ? 4 : 0) | (message.shiftKey ? 8 : 0),
      });
    }
    // Key press and release can each trigger script or browser navigation.
    // Keep their attestation off the dispatch lane so key-up is not delayed.
    scheduleAttestation(category);
  };
  const releaseDiscreteDepth = (entry: QueuedViewerInput) => {
    if (!entry.counted) return;
    entry.counted = false;
    discreteInputDepth -= 1;
  };
  const startInputPump = () => {
    if (closed || inputPump || inputQueue.length === 0) return;
    inputPump = (async () => {
      while (!closed && inputQueue.length > 0) {
        const entry = inputQueue.shift()!;
        activeInput = entry;
        try {
          await processQueuedInput(entry);
          if (closed) throw new StandardViewerInputError("viewer_closed");
          entry.resolve();
        } catch (error) {
          const reason = error instanceof StandardViewerInputError ? error.reason : "input_dispatch_failed";
          const stableError = error instanceof StandardViewerInputError ? error : new StandardViewerInputError(reason);
          if (!closed) seal(reason);
          entry.reject(stableError);
        } finally {
          releaseDiscreteDepth(entry);
          if (activeInput === entry) activeInput = null;
        }
      }
    })().finally(() => {
      inputPump = null;
      startInputPump();
    });
  };
  try {
    // No retained frame becomes observable until the current top-level
    // document has passed the same bounded attestation used after input.
    await attestAfterInput("viewer_open", false);
  } catch (error) {
    const reason = error instanceof StandardViewerInputError ? error.reason : "input_attestation_failed";
    if (seal(reason)) await options.revoke().catch(() => undefined);
    throw error;
  }
  return {
    dispatch(raw, isBinary) {
      try {
        const fail = (reason: StandardViewerFailureReason): never => {
          seal(reason);
          throw new StandardViewerInputError(reason);
        };
        if (closed) throw new StandardViewerInputError("viewer_closed");
        if (isBinary) fail("input_invalid");
        let message: any;
        try { message = JSON.parse(raw.toString("utf8")); } catch { fail("input_invalid"); }
        const parsedCategory = inputCategory(message);
        if (parsedCategory === null) {
          seal("input_invalid");
          throw new StandardViewerInputError("input_invalid");
        }
        const category = parsedCategory;
        const discrete = category !== "mouse_move" && category !== "wheel";
        if (discrete && discreteInputDepth >= MAX_VIEWER_INPUT_QUEUE) fail("input_queue_full");
        try {
          message = normalizeInputMessage(message, category);
        } catch (error) {
          fail(error instanceof StandardViewerInputError ? error.reason : "input_invalid");
        }
        observe({ event: "input_received", category, outcome: "accepted" });

        if (!discrete) {
          for (let index = inputQueue.length - 1; index >= 0; index -= 1) {
            const queued = inputQueue[index]!;
            if (queued.discrete) break;
            if (queued.category !== category) continue;
            if (category === "wheel") {
              queued.message = {
                ...message,
                deltaX: aggregateWheelDelta(queued.message.deltaX, message.deltaX),
                deltaY: aggregateWheelDelta(queued.message.deltaY, message.deltaY),
              };
            } else {
              queued.message = message;
            }
            // Keep the two continuous categories ordered by their newest
            // occurrence while retaining at most one pending slot for each.
            inputQueue.splice(index, 1);
            inputQueue.push(queued);
            return queued.done;
          }
        }

        let settleResolve!: () => void;
        let settleReject!: (error: StandardViewerInputError) => void;
        const done = new Promise<void>((resolvePromise, rejectPromise) => {
          settleResolve = resolvePromise;
          settleReject = rejectPromise;
        });
        const entry: QueuedViewerInput = {
          category,
          message,
          discrete,
          counted: discrete,
          settled: false,
          done,
          resolve() {
            if (this.settled) return;
            this.settled = true;
            settleResolve();
          },
          reject(error) {
            if (this.settled) return;
            this.settled = true;
            settleReject(error);
          },
        };
        inputQueue.push(entry);
        if (entry.counted) discreteInputDepth += 1;
        startInputPump();
        return done;
      } catch (error) {
        return Promise.reject(error);
      }
    },
    async close() {
      // Seal and release retained frame data synchronously. Closing the exact
      // attachment terminates its screencast/CDP session without waiting on a
      // potentially stalled authorization callback.
      seal();
    },
    onMessage(listener) {
      if (closed) throw new Error("Standard browser viewer is closed");
      listeners.add(listener);
      const pending = pendingMessage;
      pendingMessage = null;
      if (pending) listener(pending.bytes, pending.isBinary);
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      if (closed) {
        queueMicrotask(() => listener("viewer_closed"));
        return () => undefined;
      }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
}
