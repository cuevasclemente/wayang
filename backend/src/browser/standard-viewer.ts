import type { CdpConnection, ChromeTarget } from "./cdp.js";
import { guardedSend, settledTopLevelDocument } from "./guarded-page.js";
import { isProtectedBrowserAllowedTopLevelUrl } from "./protected-browser.js";
import type { ProtectedBrowserViewerTransport } from "../routes/protected-browser.js";

const SETTLE_TIMEOUT_MS = 10_000;
const SETTLE_INTERVAL_MS = 50;

function keyCodeFor(key: string): number | undefined {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  return ({ Enter: 13, Backspace: 8, Tab: 9, Escape: 27, ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40, Delete: 46 } as Record<string, number>)[key];
}

export async function openStandardCdpViewer(options: {
  attachment: { cdp: Pick<CdpConnection, "send" | "on" | "close">; target: ChromeTarget; close(): void };
  authorize(): Promise<void>;
  revoke(): Promise<void>;
  redact?(value: unknown): unknown;
}): Promise<ProtectedBrowserViewerTransport> {
  const { cdp, target } = options.attachment;
  const listeners = new Set<(message: Buffer, isBinary: boolean) => void>();
  let closed = false;
  let attachmentClosed = false;
  let pendingMessage: { bytes: Buffer; isBinary: boolean } | null = null;
  let pendingFrame: any | null = null;
  let framePump: Promise<void> | null = null;
  let offFrame: (() => void) | null = null;
  const seal = (): boolean => {
    if (closed) return false;
    closed = true;
    offFrame?.();
    offFrame = null;
    pendingFrame = null;
    pendingMessage = null;
    listeners.clear();
    if (!attachmentClosed) {
      attachmentClosed = true;
      options.attachment.close();
    }
    return true;
  };
  const emit = (message: unknown) => {
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
      if (seal()) void options.revoke().catch(() => undefined);
    }).finally(() => {
      framePump = null;
      if (!closed && pendingFrame) startFramePump();
    });
  };
  // Subscribe before startScreencast so a synchronous initial emission cannot
  // fall into the construction gap. Retain only the latest unprocessed frame.
  offFrame = cdp.on("Page.screencastFrame", (params: any) => {
    if (closed) return;
    pendingFrame = params;
    startFramePump();
  });
  try {
    await guardedSend(cdp, options.authorize, "Page.enable");
    await guardedSend(cdp, options.authorize, "Runtime.enable");
    await guardedSend(cdp, options.authorize, "Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  } catch (error) {
    seal();
    throw error;
  }
  let inputTail: Promise<void> = Promise.resolve();
  let inputDepth = 0;
  const MAX_VIEWER_INPUT_QUEUE = 64;
  const attestAfterInput = async () => {
    const document = await settledTopLevelDocument(cdp, target, options.authorize, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    if (!isProtectedBrowserAllowedTopLevelUrl(document.topLevelUrl) && document.topLevelUrl !== "about:blank") {
      void options.revoke().catch(() => undefined);
      throw new Error("Standard browser viewer reached a forbidden top-level document");
    }
    const redacted = options.redact?.({ type: "page", url: document.topLevelUrl, title: document.title })
      ?? { type: "page", url: document.topLevelUrl, title: document.title };
    emit(redacted);
  };
  return {
    async dispatch(raw, isBinary) {
      if (closed || isBinary) throw new Error("Standard browser viewer message is invalid");
      if (inputDepth >= MAX_VIEWER_INPUT_QUEUE) throw new Error("Standard browser viewer input queue is full");
      let message: any;
      try { message = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Standard browser viewer message is invalid"); }
      inputDepth += 1;
      const prior = inputTail;
      let release!: () => void;
      inputTail = new Promise<void>((resolve) => { release = resolve; });
      await prior.catch(() => undefined);
      try {
      if (message.type === "frame-ack") {
        const sessionId = Number(message.sessionId);
        if (!Number.isSafeInteger(sessionId) || sessionId < 0) throw new Error("Standard browser frame acknowledgement is invalid");
        await guardedSend(cdp, options.authorize, "Page.screencastFrameAck", { sessionId });
        return;
      }
      if (message.type === "mouse") {
        const x = Number(message.x); const y = Number(message.y);
        if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("Standard browser mouse input is invalid");
        const type = message.event === "down" ? "mousePressed" : message.event === "up" ? "mouseReleased" : message.event === "wheel" ? "mouseWheel" : "mouseMoved";
        await guardedSend(cdp, options.authorize, "Input.dispatchMouseEvent", {
          type, x, y,
          button: message.button === "right" ? "right" : message.button === "middle" ? "middle" : "left",
          clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
          deltaX: Number(message.deltaX) || 0,
          deltaY: Number(message.deltaY) || 0,
        });
        if (type !== "mouseMoved") await attestAfterInput();
        return;
      }
      if (message.type === "key") {
        const key = typeof message.key === "string" ? message.key : "";
        if (!key) throw new Error("Standard browser key input is invalid");
        if (message.event === "down" && key.length === 1 && !message.ctrlKey && !message.metaKey && !message.altKey) {
          await guardedSend(cdp, options.authorize, "Input.insertText", { text: key });
        } else {
          await guardedSend(cdp, options.authorize, "Input.dispatchKeyEvent", {
            type: message.event === "up" ? "keyUp" : "rawKeyDown",
            key,
            code: message.code || key,
            windowsVirtualKeyCode: keyCodeFor(key),
            nativeVirtualKeyCode: keyCodeFor(key),
            modifiers: (message.altKey ? 1 : 0) | (message.ctrlKey ? 2 : 0) | (message.metaKey ? 4 : 0) | (message.shiftKey ? 8 : 0),
          });
        }
        await attestAfterInput();
        return;
      }
      throw new Error("Standard browser viewer message is unsupported");
      } finally {
        inputDepth -= 1;
        release();
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
  };
}
