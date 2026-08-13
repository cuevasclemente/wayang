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
}): Promise<ProtectedBrowserViewerTransport> {
  const { cdp, target } = options.attachment;
  const listeners = new Set<(message: Buffer, isBinary: boolean) => void>();
  let closed = false;
  const emit = (message: unknown) => {
    const bytes = Buffer.from(JSON.stringify(message));
    for (const listener of listeners) listener(bytes, false);
  };
  try {
    await guardedSend(cdp, options.authorize, "Page.enable");
    await guardedSend(cdp, options.authorize, "Runtime.enable");
    await guardedSend(cdp, options.authorize, "Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
  } catch (error) {
    options.attachment.close();
    throw error;
  }
  let frameAuthorization: Promise<void> = Promise.resolve();
  const offFrame = cdp.on("Page.screencastFrame", (params: any) => {
    frameAuthorization = frameAuthorization.then(async () => {
      await options.authorize();
      if (closed) return;
      emit({ type: "frame", dataUrl: `data:image/jpeg;base64,${params.data}`, metadata: params.metadata, sessionId: params.sessionId });
    }).catch(() => { void options.revoke().catch(() => undefined); });
  });
  const attestAfterInput = async () => {
    const document = await settledTopLevelDocument(cdp, target, options.authorize, SETTLE_TIMEOUT_MS, SETTLE_INTERVAL_MS);
    if (!isProtectedBrowserAllowedTopLevelUrl(document.topLevelUrl) && document.topLevelUrl !== "about:blank") {
      void options.revoke().catch(() => undefined);
      throw new Error("Standard browser viewer reached a forbidden top-level document");
    }
    emit({ type: "page", url: document.topLevelUrl, title: document.title });
  };
  return {
    async dispatch(raw, isBinary) {
      if (closed || isBinary) throw new Error("Standard browser viewer message is invalid");
      let message: any;
      try { message = JSON.parse(raw.toString("utf8")); } catch { throw new Error("Standard browser viewer message is invalid"); }
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
        await attestAfterInput();
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
    },
    async close() {
      if (closed) return;
      closed = true;
      offFrame();
      try { await guardedSend(cdp, options.authorize, "Page.stopScreencast"); } catch { /* best effort */ }
      listeners.clear();
      options.attachment.close();
    },
    onMessage(listener) {
      if (closed) throw new Error("Standard browser viewer is closed");
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
