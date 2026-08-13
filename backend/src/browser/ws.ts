import type { Server } from "node:http";
import * as net from "node:net";
import type { Duplex } from "node:stream";
import { WebSocket, WebSocketServer } from "ws";
import { CdpConnection } from "./cdp.js";
import { getBrowserStatus, getBrowserVncPort, getPageTarget, sanitizeBrowserErrorMessage, startBrowser, toPublicBrowserState } from "./manager.js";
import type { BrowserSessionLookup } from "./types.js";
import type { AuthService } from "../auth/service.js";
import { classifyGenericBrowserTarget } from "./request-auth.js";
import {
  attachSelectedProtectedViewer,
  selectProtectedBrowserWebSocket,
  type ProtectedBrowserIntegration,
  type ProtectedBrowserRouteSelection,
} from "../routes/protected-browser.js";
import {
  attachSelectedStandardViewer,
  selectStandardBrowserWebSocket,
  type StandardBrowserIntegration,
} from "../routes/standard-browser.js";

function sendSafe(ws: WebSocket, msg: unknown): void {
  try {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  } catch {
    // ignore disconnected clients
  }
}

function lookupFromUrl(url: URL): BrowserSessionLookup {
  return {
    sessionId: url.searchParams.get("session_id"),
    projectCwd: url.searchParams.get("project_cwd"),
    persistence: url.searchParams.get("persistence") === "session"
      ? "session"
      : url.searchParams.get("persistence") === "project" ? "project" : "shared",
  };
}

export function protectedGenericBrowserWsTargetDenied(
  url: URL,
  classify: (lookup: BrowserSessionLookup) => boolean = (lookup) => {
    const value = classifyGenericBrowserTarget(lookup);
    return value === "protected" || value === "quarantined";
  },
): boolean {
  return classify(lookupFromUrl(url));
}


function rejectBrowserUpgrade(socket: Duplex, message = "Protected browser transport is unavailable", status = 403): void {
  const body = JSON.stringify({ error: message });
  const reason = status === 503 ? "Service Unavailable" : "Forbidden";
  socket.write(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nCache-Control: no-store\r\nContent-Type: application/json\r\n` +
    `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`,
  );
  socket.destroy();
}

function keyCodeFor(key: string): number | undefined {
  if (key.length === 1) return key.toUpperCase().charCodeAt(0);
  const codes: Record<string, number> = {
    Enter: 13,
    Backspace: 8,
    Tab: 9,
    Escape: 27,
    ArrowLeft: 37,
    ArrowUp: 38,
    ArrowRight: 39,
    ArrowDown: 40,
    Delete: 46,
    Home: 36,
    End: 35,
    PageUp: 33,
    PageDown: 34,
  };
  return codes[key];
}

const MAX_PROXY_BUFFER_BYTES = 2 * 1024 * 1024;
const RESUME_PROXY_BUFFER_BYTES = 512 * 1024;

export function proxyBufferAction(bufferedBytes: number): "continue" | "pause" | "close" {
  if (bufferedBytes > MAX_PROXY_BUFFER_BYTES * 2) return "close";
  if (bufferedBytes > MAX_PROXY_BUFFER_BYTES) return "pause";
  return "continue";
}

interface CoalescedMouseMessage {
  type: "mouse";
  event?: string;
  x?: unknown;
  y?: unknown;
  button?: unknown;
  deltaX?: unknown;
  deltaY?: unknown;
}

export class BrowserInputCoalescer {
  private move: CoalescedMouseMessage | null = null;
  private wheel: CoalescedMouseMessage | null = null;
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dispatch: (message: CoalescedMouseMessage) => void, private readonly intervalMs = 16) {}

  push(message: CoalescedMouseMessage): void {
    if (message.event === "move" || !message.event) {
      this.move = message;
      this.schedule();
      return;
    }
    if (message.event === "wheel") {
      this.wheel = {
        ...message,
        deltaX: Number(this.wheel?.deltaX || 0) + Number(message.deltaX || 0),
        deltaY: Number(this.wheel?.deltaY || 0) + Number(message.deltaY || 0),
      };
      this.schedule();
      return;
    }
    this.flush();
    this.dispatch(message);
  }

  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (this.move) this.dispatch(this.move);
    if (this.wheel) this.dispatch(this.wheel);
    this.move = null;
    this.wheel = null;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.move = null;
    this.wheel = null;
  }

  private schedule(): void {
    if (this.timer) return;
    this.timer = setTimeout(() => this.flush(), this.intervalMs);
  }
}

export function attachBrowserWs(
  httpServer: Server,
  auth: AuthService,
  protectedBrowser?: ProtectedBrowserIntegration,
  standardBrowser?: StandardBrowserIntegration,
): void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const vncWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });

  const attachProtected = (
    ws: WebSocket,
    selection: ProtectedBrowserRouteSelection,
    kind: "vnc" | "cdp",
  ) => {
    void attachSelectedProtectedViewer(ws, selection, kind, protectedBrowser!).then((viewer) => {
      ws.on("message", (raw, isBinary) => {
        const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
        void viewer.handleMessage(bytes, isBinary).catch(() => viewer.dispose());
      });
      ws.on("close", () => { void viewer.dispose(); });
      ws.on("error", () => { void viewer.dispose(); });
    }).catch(() => ws.close(1008, "Protected browser transport denied"));
  };

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "", "http://localhost");
    const pathname = url.pathname;
    const kind = pathname === "/ws/browser" ? "cdp" : pathname === "/ws/browser-vnc" ? "vnc" : null;
    if (!kind) return;

    // Exact durable capability selection occurs before auth-session lookup and
    // before any legacy browser registry. Standard selection is enabled only
    // with the startup-immutable named-profile composition.
    void Promise.resolve().then(async () => {
      const decision = auth.authorizeWebSocket(req);
      if (!decision.allowed) {
        auth.rejectWebSocket(socket, decision);
        return;
      }
      const standardSelection = selectStandardBrowserWebSocket(req, kind, standardBrowser);
      const protectedSelection = standardSelection
        ? null
        : await selectProtectedBrowserWebSocket(req, kind, protectedBrowser);
      const server = kind === "cdp" ? wss : vncWss;
      server.handleUpgrade(req, socket, head, (ws) => {
        if (standardSelection) attachSelectedStandardViewer(ws, standardSelection, kind, standardBrowser!);
        else if (protectedSelection) attachProtected(ws, protectedSelection, kind);
        else if (standardBrowser) ws.close(1008, "Named Browser Profile selection required");
        else server.emit("connection", ws, req);
      });
    }).catch((error) => {
      const status = error && typeof error === "object" && "statusCode" in error
        ? Number((error as { statusCode?: unknown }).statusCode) : 403;
      rejectBrowserUpgrade(socket, "Protected browser transport is unavailable", status === 503 ? 503 : 403);
    });
  });

  vncWss.on("connection", async (ws: WebSocket, req) => {
    const url = new URL(req.url || "", "http://localhost");
    const lookup = lookupFromUrl(url);
    let tcp: net.Socket | null = null;
    try {
      let state = getBrowserStatus(lookup);
      if (state.status !== "running") state = await startBrowser(lookup);
      const port = getBrowserVncPort(lookup);
      tcp = net.createConnection({ host: "127.0.0.1", port });
      let resumeTimer: NodeJS.Timeout | null = null;
      const stopResumeTimer = () => {
        if (resumeTimer) clearInterval(resumeTimer);
        resumeTimer = null;
      };
      const waitForViewerDrain = () => {
        if (!tcp || tcp.destroyed) return;
        tcp.pause();
        if (resumeTimer) return;
        resumeTimer = setInterval(() => {
          if (!tcp || tcp.destroyed || ws.readyState !== WebSocket.OPEN) {
            stopResumeTimer();
            return;
          }
          if (ws.bufferedAmount <= RESUME_PROXY_BUFFER_BYTES) {
            stopResumeTimer();
            tcp.resume();
          } else if (proxyBufferAction(ws.bufferedAmount) === "close") {
            stopResumeTimer();
            ws.close(1013, "Viewer transport is not draining");
            tcp.destroy();
          }
        }, 20);
      };
      tcp.on("data", (chunk) => {
        if (ws.readyState !== WebSocket.OPEN) return;
        const action = proxyBufferAction(ws.bufferedAmount);
        if (action === "close") {
          ws.close(1013, "Viewer transport buffer exceeded");
          tcp?.destroy();
          return;
        }
        if (action === "pause") waitForViewerDrain();
        ws.send(chunk, { binary: true }, () => {
          if (ws.bufferedAmount > MAX_PROXY_BUFFER_BYTES) waitForViewerDrain();
        });
      });
      tcp.on("error", () => {
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, "VNC transport failed");
      });
      tcp.on("close", () => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      ws.on("message", (raw) => {
        if (!tcp || tcp.destroyed) return;
        if (proxyBufferAction(tcp.writableLength) === "close") {
          ws.close(1013, "VNC transport buffer exceeded");
          tcp.destroy();
          return;
        }
        if (!tcp.write(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any))) {
          req.socket.pause();
          tcp.once("drain", () => req.socket.resume());
        }
      });
      ws.on("close", () => { stopResumeTimer(); tcp?.destroy(); });
      ws.on("error", () => { stopResumeTimer(); tcp?.destroy(); });
    } catch {
      ws.close(1011, "VNC transport failed");
      tcp?.destroy();
    }
  });

  wss.on("connection", async (ws: WebSocket, req) => {
    const url = new URL(req.url || "", "http://localhost");
    const lookup = lookupFromUrl(url);
    let cdp: CdpConnection | null = null;
    let screencastActive = false;
    let frameInFlight = false;
    let pendingFrameAck: { sessionId: number; timer: NodeJS.Timeout } | null = null;
    const binaryFrames = url.searchParams.get("frames") === "binary";

    const acknowledgeFrame = (sessionId: number) => {
      if (pendingFrameAck) clearTimeout(pendingFrameAck.timer);
      pendingFrameAck = null;
      cdp?.send("Page.screencastFrameAck", { sessionId }).catch(() => undefined);
      frameInFlight = false;
    };

    const stopScreencast = async () => {
      if (!cdp || !screencastActive) return;
      try { await cdp.send("Page.stopScreencast"); } catch {}
      screencastActive = false;
    };

    try {
      let state = getBrowserStatus(lookup);
      if (state.status !== "running") {
        state = await startBrowser(lookup);
      }
      if (state.status !== "running") throw new Error(state.lastError || "Browser is not running");
      sendSafe(ws, { type: "status", state: toPublicBrowserState(state) });

      const target = await getPageTarget(state);
      cdp = await CdpConnection.connect(target.webSocketDebuggerUrl!);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
      screencastActive = true;

      cdp.on("Page.screencastFrame", (params) => {
        if (frameInFlight || ws.readyState !== WebSocket.OPEN) return;
        frameInFlight = true;
        const acknowledge = () => acknowledgeFrame(params.sessionId);
        if (binaryFrames) {
          sendSafe(ws, { type: "frame-metadata", metadata: params.metadata, sessionId: params.sessionId });
          pendingFrameAck = {
            sessionId: params.sessionId,
            timer: setTimeout(acknowledge, 2_000),
          };
          ws.send(Buffer.from(params.data, "base64"), { binary: true }, (error) => {
            if (error) acknowledge();
          });
        } else {
          ws.send(JSON.stringify({
            type: "frame",
            dataUrl: `data:image/jpeg;base64,${params.data}`,
            metadata: params.metadata,
            sessionId: params.sessionId,
          }), acknowledge);
        }
      });

      cdp.on("Page.frameNavigated", () => {
        cdp?.send("Runtime.evaluate", {
          expression: "({ url: location.href, title: document.title })",
          returnByValue: true,
        }).then((result: any) => {
          const value = result?.result?.value;
          if (value) sendSafe(ws, { type: "page", url: value.url, title: value.title });
        }).catch(() => undefined);
      });
    } catch (err: any) {
      sendSafe(ws, { type: "error", error: sanitizeBrowserErrorMessage(err) });
    }

    const coalescer = new BrowserInputCoalescer((msg) => {
      if (!cdp) return;
      const x = Number(msg.x);
      const y = Number(msg.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) return;
      const button = msg.button === "right" ? "right" : msg.button === "middle" ? "middle" : "left";
      const type = msg.event === "down" ? "mousePressed" : msg.event === "up" ? "mouseReleased" : msg.event === "wheel" ? "mouseWheel" : "mouseMoved";
      cdp.send("Input.dispatchMouseEvent", {
        type,
        x,
        y,
        button,
        clickCount: type === "mousePressed" || type === "mouseReleased" ? 1 : 0,
        deltaX: Number(msg.deltaX) || 0,
        deltaY: Number(msg.deltaY) || 0,
      }).catch(() => sendSafe(ws, { type: "error", error: "Browser input failed" }));
    });

    ws.on("message", (raw) => {
      if (!cdp) return;
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "frame-ack") {
        const sessionId = Number(msg.sessionId);
        if (pendingFrameAck && sessionId === pendingFrameAck.sessionId) acknowledgeFrame(sessionId);
        return;
      }

      if (msg.type === "mouse") {
        coalescer.push(msg);
        return;
      }

      if (msg.type === "key") {
        const key = typeof msg.key === "string" ? msg.key : "";
        if (!key) return;
        if (msg.event === "down" && key.length === 1 && !msg.ctrlKey && !msg.metaKey && !msg.altKey) {
          cdp.send("Input.insertText", { text: key }).catch(() => sendSafe(ws, { type: "error", error: "Browser input failed" }));
          return;
        }
        const type = msg.event === "up" ? "keyUp" : "rawKeyDown";
        cdp.send("Input.dispatchKeyEvent", {
          type,
          key,
          code: msg.code || key,
          windowsVirtualKeyCode: keyCodeFor(key),
          nativeVirtualKeyCode: keyCodeFor(key),
          modifiers: (msg.altKey ? 1 : 0) | (msg.ctrlKey ? 2 : 0) | (msg.metaKey ? 4 : 0) | (msg.shiftKey ? 8 : 0),
        }).catch(() => sendSafe(ws, { type: "error", error: "Browser input failed" }));
      }
    });

    ws.on("close", () => {
      if (pendingFrameAck) clearTimeout(pendingFrameAck.timer);
      pendingFrameAck = null;
      coalescer.stop();
      stopScreencast().finally(() => cdp?.close());
    });
    ws.on("error", () => {
      if (pendingFrameAck) clearTimeout(pendingFrameAck.timer);
      pendingFrameAck = null;
      coalescer.stop();
      stopScreencast().finally(() => cdp?.close());
    });
  });
}
