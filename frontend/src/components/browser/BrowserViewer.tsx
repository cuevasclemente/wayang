import { useEffect, useRef, useState } from "react";
import RFB from "@novnc/novnc";
import {
  browserVncWsUrl,
  browserWsUrl,
  canRetryAuthenticatedTransport,
  type BrowserViewerTransport,
} from "../../api/client";

interface BrowserViewerProps {
  sessionId: string | null;
  projectCwd: string | null;
  running: boolean;
  transport?: BrowserViewerTransport;
  onStatus?: () => void;
  onPageChange?: (page: { url?: string; title?: string }) => void;
}

interface ScreencastMetadata {
  deviceWidth?: number;
  deviceHeight?: number;
  pageScaleFactor?: number;
}

export function BrowserViewer(props: BrowserViewerProps) {
  if (props.transport === "vnc") return <VncBrowserViewer {...props} />;
  return <CdpBrowserViewer {...props} />;
}

function VncBrowserViewer({ sessionId, projectCwd, running }: BrowserViewerProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!running || (!sessionId && !projectCwd) || !hostRef.current) return;
    const host = hostRef.current;
    host.replaceChildren();
    setConnected(false);
    setError(null);

    const rfb = new RFB(host, browserVncWsUrl(sessionId, projectCwd));
    rfbRef.current = rfb;
    rfb.viewOnly = false;
    rfb.scaleViewport = true;
    rfb.resizeSession = false;
    rfb.background = "#000000";
    rfb.qualityLevel = 6;
    rfb.compressionLevel = 2;

    const handleConnect = () => setConnected(true);
    const handleDisconnect = (event: Event) => {
      setConnected(false);
      const detail = (event as CustomEvent<{ clean?: boolean; reason?: string }>).detail;
      if (detail && detail.clean === false) setError(detail.reason || "VNC viewer disconnected");
      void canRetryAuthenticatedTransport();
    };
    const handleCredentials = () => setError("VNC server requested credentials unexpectedly.");
    rfb.addEventListener("connect", handleConnect);
    rfb.addEventListener("disconnect", handleDisconnect);
    rfb.addEventListener("credentialsrequired", handleCredentials);
    rfb.focus();

    return () => {
      rfb.removeEventListener("connect", handleConnect);
      rfb.removeEventListener("disconnect", handleDisconnect);
      rfb.removeEventListener("credentialsrequired", handleCredentials);
      rfb.disconnect();
      if (rfbRef.current === rfb) rfbRef.current = null;
    };
  }, [sessionId, projectCwd, running]);

  return (
    <div className="h-full min-h-0 flex flex-col bg-black">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
        <span>{connected ? "VNC viewer connected" : "VNC viewer connecting…"}</span>
        <span>Human-friendly headed Chromium. Click inside the browser to focus keyboard input.</span>
      </div>
      {error && <div className="border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden bg-black [&_canvas]:mx-auto [&_canvas]:block"
        onMouseDown={() => rfbRef.current?.focus()}
      />
    </div>
  );
}

function CdpBrowserViewer({ sessionId, projectCwd, running, onStatus, onPageChange }: BrowserViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const metadataRef = useRef<ScreencastMetadata | null>(null);
  const [frameUrl, setFrameUrl] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!running || (!sessionId && !projectCwd)) return;
    const ws = new WebSocket(browserWsUrl(sessionId, projectCwd));
    wsRef.current = ws;
    setError(null);
    setConnected(false);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      void canRetryAuthenticatedTransport();
    };
    ws.onerror = () => setError("Browser viewer websocket error");
    ws.onmessage = (event) => {
      let msg: any;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.type === "frame" && typeof msg.dataUrl === "string") {
        metadataRef.current = msg.metadata ?? null;
        setFrameUrl(msg.dataUrl);
      } else if (msg.type === "status") {
        onStatus?.();
      } else if (msg.type === "page") {
        onPageChange?.({ url: msg.url, title: msg.title });
      } else if (msg.type === "error") {
        setError(String(msg.error || "Browser viewer error"));
      }
    };

    return () => {
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
    };
  }, [sessionId, projectCwd, running, onStatus, onPageChange]);

  const send = (payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  };

  const toBrowserCoordinates = (clientX: number, clientY: number): { x: number; y: number } | null => {
    const img = imgRef.current;
    if (!img) return null;
    const rect = img.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return null;
    const metadata = metadataRef.current;
    const browserWidth = metadata?.deviceWidth || img.naturalWidth || rect.width;
    const browserHeight = metadata?.deviceHeight || img.naturalHeight || rect.height;
    return {
      x: Math.max(0, Math.min(browserWidth, ((clientX - rect.left) / rect.width) * browserWidth)),
      y: Math.max(0, Math.min(browserHeight, ((clientY - rect.top) / rect.height) * browserHeight)),
    };
  };

  const handleMouse = (event: React.MouseEvent, kind: "down" | "up" | "move") => {
    const point = toBrowserCoordinates(event.clientX, event.clientY);
    if (!point) return;
    containerRef.current?.focus();
    send({
      type: "mouse",
      event: kind,
      x: point.x,
      y: point.y,
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    });
  };

  const handleWheel = (event: React.WheelEvent) => {
    const point = toBrowserCoordinates(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    send({ type: "mouse", event: "wheel", x: point.x, y: point.y, deltaX: event.deltaX, deltaY: event.deltaY });
  };

  const handleKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === "F5") return;
    event.preventDefault();
    send({
      type: "key",
      event: "down",
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  };

  const handleKeyUp = (event: React.KeyboardEvent) => {
    event.preventDefault();
    send({
      type: "key",
      event: "up",
      key: event.key,
      code: event.code,
      altKey: event.altKey,
      ctrlKey: event.ctrlKey,
      metaKey: event.metaKey,
      shiftKey: event.shiftKey,
    });
  };

  return (
    <div className="h-full min-h-0 flex flex-col bg-black">
      <div className="flex items-center justify-between border-b border-neutral-800 px-3 py-2 text-xs text-neutral-400">
        <span>{connected ? "CDP viewer connected" : "CDP viewer connecting…"}</span>
        <span>Fallback screencast mode. Click the browser area first to send keyboard input.</span>
      </div>
      {error && <div className="border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div
        ref={containerRef}
        tabIndex={0}
        className="min-h-0 flex-1 overflow-auto outline-none focus:ring-2 focus:ring-sky-500/60"
        onMouseDown={(event) => handleMouse(event, "down")}
        onMouseUp={(event) => handleMouse(event, "up")}
        onMouseMove={(event) => handleMouse(event, "move")}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onContextMenu={(event) => event.preventDefault()}
      >
        {frameUrl ? (
          <img
            ref={imgRef}
            src={frameUrl}
            alt="Chromium screencast"
            draggable={false}
            className="mx-auto max-h-full max-w-full select-none"
          />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-500">
            Waiting for browser frames…
          </div>
        )}
      </div>
    </div>
  );
}
