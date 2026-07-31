import { useCallback, useEffect, useRef, useState } from "react";
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
  onPasteText?: (text: string) => void;
}

interface ScreencastMetadata {
  deviceWidth?: number;
  deviceHeight?: number;
  pageScaleFactor?: number;
}

interface FrameEnvelope {
  metadata: ScreencastMetadata | null;
  sessionId?: number;
}

interface PresentableFrame extends FrameEnvelope {
  src: string;
  revoke: boolean;
}

export function BrowserViewer(props: BrowserViewerProps) {
  if (props.transport === "vnc") return <VncBrowserViewer {...props} />;
  return <CdpBrowserViewer {...props} />;
}

function directPaste(event: React.ClipboardEvent, onPasteText?: (text: string) => void) {
  if (!onPasteText) return;
  const text = event.clipboardData.getData("text/plain");
  if (!text) return;
  event.preventDefault();
  onPasteText(text);
}

function VncBrowserViewer({ sessionId, projectCwd, running, onPasteText }: BrowserViewerProps) {
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

    let rfb: RFB;
    try {
      rfb = new RFB(host, browserVncWsUrl(sessionId, projectCwd));
    } catch {
      setError("Full browser viewer could not connect.");
      return;
    }
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
      if (detail && detail.clean === false) setError(detail.reason || "Full browser viewer disconnected");
      void canRetryAuthenticatedTransport();
    };
    const handleCredentials = () => setError("The Full browser viewer requested unexpected VNC credentials.");
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
    <div className="flex h-full min-h-0 flex-col bg-black" onPaste={(event) => directPaste(event, onPasteText)}>
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400">
        <span>{connected ? "Full browser connected" : "Full browser connecting…"}</span>
        <span className="hidden truncate sm:block">Browser chrome and extensions. Click inside to focus.</span>
      </div>
      {error && <div className="shrink-0 border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div
        ref={hostRef}
        className="min-h-0 flex-1 overflow-hidden bg-black [&_canvas]:mx-auto [&_canvas]:block"
        onMouseDown={() => rfbRef.current?.focus()}
      />
    </div>
  );
}

function CdpBrowserViewer({ sessionId, projectCwd, running, onStatus, onPageChange, onPasteText }: BrowserViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const metadataRef = useRef<ScreencastMetadata | null>(null);
  const pendingEnvelopeRef = useRef<FrameEnvelope | null>(null);
  const queuedFrameRef = useRef<PresentableFrame | null>(null);
  const presentingRef = useRef(false);
  const displayedObjectUrlRef = useRef<string | null>(null);
  const moveRef = useRef<Record<string, unknown> | null>(null);
  const moveAnimationRef = useRef<number | null>(null);
  const wheelRef = useRef<(Record<string, unknown> & { deltaX: number; deltaY: number }) | null>(null);
  const wheelAnimationRef = useRef<number | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = useCallback((payload: Record<string, unknown>) => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify(payload));
  }, []);

  const presentFrame = useCallback((frame: PresentableFrame) => {
    const img = imgRef.current;
    if (!img) {
      if (frame.revoke) URL.revokeObjectURL(frame.src);
      return;
    }
    if (presentingRef.current) {
      const replaced = queuedFrameRef.current;
      if (replaced?.revoke) URL.revokeObjectURL(replaced.src);
      queuedFrameRef.current = frame;
      return;
    }

    presentingRef.current = true;
    metadataRef.current = frame.metadata;
    const finish = (presented: boolean) => {
      window.requestAnimationFrame(() => {
        if (presented) {
          setHasFrame(true);
          if (frame.sessionId !== undefined) send({ type: "frame-ack", sessionId: frame.sessionId });
          const previousUrl = displayedObjectUrlRef.current;
          displayedObjectUrlRef.current = frame.revoke ? frame.src : null;
          if (previousUrl && previousUrl !== frame.src) URL.revokeObjectURL(previousUrl);
        } else if (frame.revoke) {
          URL.revokeObjectURL(frame.src);
        }
        presentingRef.current = false;
        const next = queuedFrameRef.current;
        queuedFrameRef.current = null;
        if (next) presentFrame(next);
      });
    };
    img.onload = () => finish(true);
    img.onerror = () => finish(false);
    img.src = frame.src;
  }, [send]);

  useEffect(() => {
    if (!running || (!sessionId && !projectCwd)) return;
    const image = imgRef.current;
    const ws = new WebSocket(browserWsUrl(sessionId, projectCwd));
    ws.binaryType = "blob";
    wsRef.current = ws;
    setError(null);
    setConnected(false);
    setHasFrame(false);

    ws.onopen = () => setConnected(true);
    ws.onclose = () => {
      setConnected(false);
      void canRetryAuthenticatedTransport();
    };
    ws.onerror = () => setError("Fast page viewer websocket error");
    ws.onmessage = (event) => {
      if (typeof event.data !== "string") {
        const blob = event.data instanceof Blob ? event.data : new Blob([event.data], { type: "image/jpeg" });
        const envelope = pendingEnvelopeRef.current;
        pendingEnvelopeRef.current = null;
        presentFrame({
          src: URL.createObjectURL(blob),
          revoke: true,
          metadata: envelope?.metadata ?? null,
          sessionId: envelope?.sessionId,
        });
        return;
      }

      let msg: Record<string, any>;
      try {
        msg = JSON.parse(event.data) as Record<string, any>;
      } catch {
        return;
      }
      if (msg.type === "frame" || msg.type === "frame-metadata") {
        const envelope = {
          metadata: msg.metadata && typeof msg.metadata === "object" ? msg.metadata as ScreencastMetadata : null,
          sessionId: typeof msg.sessionId === "number" ? msg.sessionId : undefined,
        };
        if (typeof msg.dataUrl === "string") {
          presentFrame({ ...envelope, src: msg.dataUrl, revoke: false });
        } else {
          // The optimized protocol sends a small JSON envelope followed by one
          // binary JPEG. The next frame is withheld until presentation ACK.
          pendingEnvelopeRef.current = envelope;
        }
      } else if (msg.type === "status") {
        onStatus?.();
      } else if (msg.type === "page") {
        onPageChange?.({
          url: typeof msg.url === "string" ? msg.url : undefined,
          title: typeof msg.title === "string" ? msg.title : undefined,
        });
      } else if (msg.type === "error") {
        setError(String(msg.error || "Fast page viewer error"));
      }
    };

    return () => {
      ws.close();
      if (wsRef.current === ws) wsRef.current = null;
      pendingEnvelopeRef.current = null;
      const queued = queuedFrameRef.current;
      if (queued?.revoke) URL.revokeObjectURL(queued.src);
      queuedFrameRef.current = null;
      if (displayedObjectUrlRef.current) URL.revokeObjectURL(displayedObjectUrlRef.current);
      displayedObjectUrlRef.current = null;
      if (image) {
        image.onload = null;
        image.onerror = null;
        image.removeAttribute("src");
      }
      presentingRef.current = false;
    };
  }, [sessionId, projectCwd, running, onStatus, onPageChange, presentFrame]);

  useEffect(() => () => {
    if (moveAnimationRef.current !== null) window.cancelAnimationFrame(moveAnimationRef.current);
    if (wheelAnimationRef.current !== null) window.cancelAnimationFrame(wheelAnimationRef.current);
  }, []);

  const flushMove = () => {
    if (moveAnimationRef.current !== null) {
      window.cancelAnimationFrame(moveAnimationRef.current);
      moveAnimationRef.current = null;
    }
    const payload = moveRef.current;
    moveRef.current = null;
    if (payload) send(payload);
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

  const pointerPayload = (event: React.PointerEvent, kind: "down" | "up" | "move") => {
    const point = toBrowserCoordinates(event.clientX, event.clientY);
    if (!point) return null;
    return {
      type: "mouse",
      event: kind,
      x: point.x,
      y: point.y,
      button: event.button === 2 ? "right" : event.button === 1 ? "middle" : "left",
    };
  };

  const handlePointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
    const payload = pointerPayload(event, "down");
    if (!payload) return;
    containerRef.current?.focus();
    event.currentTarget.setPointerCapture(event.pointerId);
    flushMove();
    send(payload);
  };

  const handlePointerMove = (event: React.PointerEvent<HTMLDivElement>) => {
    const payload = pointerPayload(event, "move");
    if (!payload) return;
    moveRef.current = payload;
    if (moveAnimationRef.current !== null) return;
    moveAnimationRef.current = window.requestAnimationFrame(() => {
      moveAnimationRef.current = null;
      const latest = moveRef.current;
      moveRef.current = null;
      if (latest) send(latest);
    });
  };

  const handlePointerUp = (event: React.PointerEvent<HTMLDivElement>) => {
    const payload = pointerPayload(event, "up");
    if (!payload) return;
    flushMove();
    send(payload);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
  };

  const handleWheel = (event: React.WheelEvent) => {
    const point = toBrowserCoordinates(event.clientX, event.clientY);
    if (!point) return;
    event.preventDefault();
    const current = wheelRef.current;
    wheelRef.current = {
      type: "mouse",
      event: "wheel",
      x: point.x,
      y: point.y,
      deltaX: (current?.deltaX ?? 0) + event.deltaX,
      deltaY: (current?.deltaY ?? 0) + event.deltaY,
    };
    if (wheelAnimationRef.current !== null) return;
    wheelAnimationRef.current = window.requestAnimationFrame(() => {
      wheelAnimationRef.current = null;
      const payload = wheelRef.current;
      wheelRef.current = null;
      if (payload) send(payload);
    });
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
    <div className="flex h-full min-h-0 flex-col bg-black">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400">
        <span>{connected ? "Fast page connected" : "Fast page connecting…"}</span>
        <span className="hidden truncate sm:block">Fast CDP page view. Click inside to focus.</span>
      </div>
      {error && <div className="shrink-0 border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div>}
      <div
        ref={containerRef}
        tabIndex={0}
        className="relative min-h-0 flex-1 touch-none overflow-hidden outline-none focus:ring-2 focus:ring-inset focus:ring-sky-500/60"
        onPointerDown={handlePointerDown}
        onPointerUp={handlePointerUp}
        onPointerMove={handlePointerMove}
        onWheel={handleWheel}
        onKeyDown={handleKeyDown}
        onKeyUp={handleKeyUp}
        onPaste={(event) => directPaste(event, onPasteText)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <img
          ref={imgRef}
          alt="Chromium fast page"
          draggable={false}
          className={`mx-auto block max-h-full max-w-full select-none ${hasFrame ? "opacity-100" : "opacity-0"}`}
        />
        {!hasFrame && (
          <div className="absolute inset-0 flex items-center justify-center text-sm text-neutral-500">
            Waiting for browser frames…
          </div>
        )}
      </div>
    </div>
  );
}
