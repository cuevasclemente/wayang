import type { Server } from "node:http";
import * as net from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { CdpConnection } from "./cdp.js";
import { getBrowserStatus, getBrowserVncPort, getPageTarget, startBrowser } from "./manager.js";
import type { BrowserSessionLookup } from "./types.js";
import type { AuthService } from "../auth/service.js";

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
    persistence: url.searchParams.get("persistence") === "session" ? "session" : "project",
  };
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

export function attachBrowserWs(httpServer: Server, auth: AuthService): void {
  const wss = new WebSocketServer({ noServer: true });
  const vncWss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const pathname = new URL(req.url || "", "http://localhost").pathname;
    if (pathname === "/ws/browser") {
      const decision = auth.authorizeWebSocket(req);
      if (!decision.allowed) {
        auth.rejectWebSocket(socket, decision);
        return;
      }
      wss.handleUpgrade(req, socket, head, (ws) => {
        wss.emit("connection", ws, req);
      });
      return;
    }
    if (pathname === "/ws/browser-vnc") {
      const decision = auth.authorizeWebSocket(req);
      if (!decision.allowed) {
        auth.rejectWebSocket(socket, decision);
        return;
      }
      vncWss.handleUpgrade(req, socket, head, (ws) => {
        vncWss.emit("connection", ws, req);
      });
    }
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
      tcp.on("data", (chunk) => {
        if (ws.readyState === WebSocket.OPEN) ws.send(chunk, { binary: true });
      });
      tcp.on("error", (err) => {
        if (ws.readyState === WebSocket.OPEN) ws.close(1011, err.message.slice(0, 120));
      });
      tcp.on("close", () => {
        if (ws.readyState === WebSocket.OPEN) ws.close();
      });
      ws.on("message", (raw) => {
        if (tcp && !tcp.destroyed) tcp.write(Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any));
      });
      ws.on("close", () => tcp?.destroy());
      ws.on("error", () => tcp?.destroy());
    } catch (err: any) {
      ws.close(1011, (err?.message || String(err)).slice(0, 120));
      tcp?.destroy();
    }
  });

  wss.on("connection", async (ws: WebSocket, req) => {
    const url = new URL(req.url || "", "http://localhost");
    const lookup = lookupFromUrl(url);
    let cdp: CdpConnection | null = null;
    let screencastActive = false;

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
      sendSafe(ws, { type: "status", state });

      const target = await getPageTarget(state);
      cdp = await CdpConnection.connect(target.webSocketDebuggerUrl!);
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      await cdp.send("Page.startScreencast", { format: "jpeg", quality: 70, everyNthFrame: 1 });
      screencastActive = true;

      cdp.on("Page.screencastFrame", (params) => {
        sendSafe(ws, {
          type: "frame",
          dataUrl: `data:image/jpeg;base64,${params.data}`,
          metadata: params.metadata,
          sessionId: params.sessionId,
        });
        cdp?.send("Page.screencastFrameAck", { sessionId: params.sessionId }).catch(() => undefined);
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
      sendSafe(ws, { type: "error", error: err?.message || String(err) });
    }

    ws.on("message", (raw) => {
      if (!cdp) return;
      let msg: any;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === "mouse") {
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
        }).catch((err) => sendSafe(ws, { type: "error", error: err.message }));
        return;
      }

      if (msg.type === "key") {
        const key = typeof msg.key === "string" ? msg.key : "";
        if (!key) return;
        if (msg.event === "down" && key.length === 1 && !msg.ctrlKey && !msg.metaKey && !msg.altKey) {
          cdp.send("Input.insertText", { text: key }).catch((err) => sendSafe(ws, { type: "error", error: err.message }));
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
        }).catch((err) => sendSafe(ws, { type: "error", error: err.message }));
      }
    });

    ws.on("close", () => {
      stopScreencast().finally(() => cdp?.close());
    });
    ws.on("error", () => {
      stopScreencast().finally(() => cdp?.close());
    });
  });
}
