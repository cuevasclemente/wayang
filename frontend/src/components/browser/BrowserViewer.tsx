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
  vncTakeoverRequest?: number;
  vncTakeoverConsumed?: number;
  onVncTakeoverConsumed?: (request: number) => void;
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
  const websocketUrl = props.running && (props.sessionId || props.projectCwd)
    ? browserWsUrl(props.sessionId, props.projectCwd)
    : null;
  return (
    <CdpScreencastViewer
      websocketUrl={websocketUrl}
      running={props.running}
      onStatus={props.onStatus}
      onPageChange={props.onPageChange}
      onPasteText={props.onPasteText}
    />
  );
}

export interface CdpScreencastViewerProps {
  /** Backend-issued URL. This low-level viewer never constructs an authority endpoint. */
  websocketUrl: string | null;
  running: boolean;
  onStatus?: () => void;
  onPageChange?: (page: { url?: string; title?: string }) => void;
  onPasteText?: (text: string) => void;
  /** Human-only clipboard path for a focused protected viewer. */
  pasteThroughViewer?: boolean;
  /** Wait for the backend viewer-ready message before enabling human input. */
  requireReadyHandshake?: boolean;
  connectionLabel?: string;
  imageAlt?: string;
  testId?: string;
}

function directPaste(event: React.ClipboardEvent, onPasteText?: (text: string) => void) {
  if (!onPasteText) return;
  const text = event.clipboardData.getData("text/plain");
  if (!text) return;
  event.preventDefault();
  onPasteText(text);
}

function VncBrowserViewer({ sessionId, projectCwd, running, onPasteText, vncTakeoverRequest = 0, vncTakeoverConsumed = 0, onVncTakeoverConsumed }: BrowserViewerProps) {
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
      const takeover = vncTakeoverRequest > vncTakeoverConsumed;
      if (takeover) onVncTakeoverConsumed?.(vncTakeoverRequest);
      rfb = new RFB(host, browserVncWsUrl(sessionId, projectCwd, takeover));
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
  // vncTakeoverConsumed is intentionally read only when this connection
  // attempt starts; acknowledging it must not itself reconnect the viewer.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, projectCwd, running, vncTakeoverRequest]);

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

export function CdpScreencastViewer({
  websocketUrl,
  running,
  onStatus,
  onPageChange,
  onPasteText,
  pasteThroughViewer = false,
  requireReadyHandshake = false,
  connectionLabel = "Fast page",
  imageAlt = "Chromium fast page",
  testId,
}: CdpScreencastViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const imgRef = useRef<HTMLImageElement | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const readyRef = useRef(false);
  const metadataRef = useRef<ScreencastMetadata | null>(null);
  const pendingEnvelopeRef = useRef<FrameEnvelope | null>(null);
  const queuedFrameRef = useRef<PresentableFrame | null>(null);
  const presentingRef = useRef(false);
  const displayedObjectUrlRef = useRef<string | null>(null);
  const moveRef = useRef<Record<string, unknown> | null>(null);
  const moveAnimationRef = useRef<number | null>(null);
  const wheelRef = useRef<(Record<string, unknown> & { deltaX: number; deltaY: number }) | null>(null);
  const wheelAnimationRef = useRef<number | null>(null);
  const onStatusRef = useRef(onStatus);
  const onPageChangeRef = useRef(onPageChange);
  const pasteCaptureRef = useRef<HTMLTextAreaElement | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pasteCaptureOpen, setPasteCaptureOpen] = useState(false);
  const [pasteNotice, setPasteNotice] = useState<string | null>(null);

  useEffect(() => { onStatusRef.current = onStatus; }, [onStatus]);
  useEffect(() => { onPageChangeRef.current = onPageChange; }, [onPageChange]);
  useEffect(() => {
    if (!pasteCaptureOpen) return;
    const timeout = window.setTimeout(() => pasteCaptureRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [pasteCaptureOpen]);

  const send = useCallback((payload: Record<string, unknown>): boolean => {
    const ws = wsRef.current;
    if (!ws || ws.readyState !== WebSocket.OPEN
      || (!readyRef.current && payload.type !== "frame-ack")) return false;
    ws.send(JSON.stringify(payload));
    return true;
  }, []);

  const handlePasteText = useCallback((text: string) => {
    if (onPasteText) { onPasteText(text); return; }
    if (pasteThroughViewer) send({ type: "paste", text });
  }, [onPasteText, pasteThroughViewer, send]);

  const submitCapturedPaste = useCallback((text: string) => {
    if (!text) return;
    setPasteCaptureOpen(false);
    if (text.length > 4_096 || new TextEncoder().encode(text).byteLength > 16_384 || text.includes("\0")) {
      setPasteNotice("Clipboard text exceeds the protected preparation paste limit.");
      return;
    }
    setPasteNotice(send({ type: "paste", text })
      ? "Clipboard text was sent to the focused browser field."
      : "The preparation viewer is not connected.");
  }, [send]);

  const readSystemClipboard = useCallback(async () => {
    if (!navigator.clipboard?.readText) {
      setPasteNotice("This browser cannot read the system clipboard. Paste into the capture target instead.");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) throw new Error("empty clipboard");
      submitCapturedPaste(text);
    } catch {
      setPasteNotice("Clipboard access was denied or the clipboard did not contain text.");
    }
  }, [submitCapturedPaste]);

  const presentFrame = useCallback((frame: PresentableFrame) => {
    const acknowledge = (candidate: PresentableFrame) => {
      if (candidate.sessionId !== undefined) send({ type: "frame-ack", sessionId: candidate.sessionId });
    };
    const img = imgRef.current;
    if (!img) {
      acknowledge(frame);
      if (frame.revoke) URL.revokeObjectURL(frame.src);
      return;
    }
    if (presentingRef.current) {
      const replaced = queuedFrameRef.current;
      if (replaced) acknowledge(replaced);
      if (replaced?.revoke) URL.revokeObjectURL(replaced.src);
      queuedFrameRef.current = frame;
      return;
    }

    presentingRef.current = true;
    metadataRef.current = frame.metadata;
    let finished = false;
    const finish = (presented: boolean) => {
      if (finished) return;
      finished = true;
      acknowledge(frame);
      window.requestAnimationFrame(() => {
        if (presented) {
          setHasFrame(true);
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
    if (!running || !websocketUrl) return;
    const image = imgRef.current;
    const ws = new WebSocket(websocketUrl);
    ws.binaryType = "blob";
    wsRef.current = ws;
    readyRef.current = false;
    setError(null);
    setConnected(false);
    setHasFrame(false);

    ws.onopen = () => {
      if (wsRef.current !== ws) return;
      if (!requireReadyHandshake) {
        readyRef.current = true;
        setConnected(true);
      }
    };
    ws.onclose = () => {
      if (wsRef.current !== ws) return;
      readyRef.current = false;
      setConnected(false);
      void canRetryAuthenticatedTransport();
    };
    ws.onerror = () => {
      if (wsRef.current !== ws) return;
      setError(`${connectionLabel} websocket error`);
    };
    ws.onmessage = (event) => {
      if (wsRef.current !== ws) return;
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
      if (msg.type === "ready") {
        readyRef.current = true;
        setConnected(true);
      } else if (msg.type === "frame" || msg.type === "frame-metadata") {
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
        onStatusRef.current?.();
      } else if (msg.type === "page") {
        onPageChangeRef.current?.({
          url: typeof msg.url === "string" ? msg.url : undefined,
          title: typeof msg.title === "string" ? msg.title : undefined,
        });
      } else if (msg.type === "error") {
        setError(String(msg.error || "Fast page viewer error"));
      }
    };

    return () => {
      if (wsRef.current === ws) wsRef.current = null;
      readyRef.current = false;
      ws.onopen = null;
      ws.onclose = null;
      ws.onerror = null;
      ws.onmessage = null;
      ws.close();
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
  }, [websocketUrl, running, presentFrame, connectionLabel, requireReadyHandshake]);

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
    <div data-testid={testId} className="flex h-full min-h-0 flex-col bg-black">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-neutral-800 px-3 py-1.5 text-[11px] text-neutral-400">
        <span>{connected ? `${connectionLabel} connected` : `${connectionLabel} connecting…`}</span>
        <div className="flex min-w-0 items-center gap-2">
          <span className="hidden truncate sm:block">Interactive CDP page view. Click inside to focus.</span>
          {pasteThroughViewer && (
            <button
              type="button"
              data-testid={testId ? `${testId}-paste-open` : undefined}
              disabled={!connected}
              onClick={() => { setPasteNotice(null); setPasteCaptureOpen(true); }}
              className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-[11px] text-neutral-200 hover:bg-neutral-800"
            >Paste text</button>
          )}
        </div>
      </div>
      {pasteCaptureOpen && (
        <div className="shrink-0 border-b border-neutral-800 bg-neutral-950 px-3 py-3 text-xs text-neutral-300">
          <label className="mb-2 block font-medium text-neutral-200">Direct paste target</label>
          <textarea
            ref={pasteCaptureRef}
            data-testid={testId ? `${testId}-paste-capture` : undefined}
            defaultValue=""
            onPaste={(event) => {
              const text = event.clipboardData.getData("text/plain");
              if (!text) return;
              event.preventDefault();
              event.currentTarget.value = "";
              submitCapturedPaste(text);
            }}
            onInput={(event) => {
              const text = event.currentTarget.value;
              event.currentTarget.value = "";
              if (text) submitCapturedPaste(text);
            }}
            placeholder="Ctrl+V or middle-click here. Text is sent immediately and not displayed or retained."
            className="mb-2 h-16 w-full resize-none rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button type="button" onClick={() => void readSystemClipboard()} className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800">Read and paste system clipboard</button>
            <button type="button" onClick={() => setPasteCaptureOpen(false)} className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800">Cancel</button>
          </div>
        </div>
      )}
      {pasteNotice && <div className="shrink-0 border-b border-sky-900/50 bg-sky-950/30 px-3 py-2 text-xs text-sky-100">{pasteNotice}</div>}
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
        onPaste={(event) => directPaste(event, onPasteText || pasteThroughViewer ? handlePasteText : undefined)}
        onContextMenu={(event) => event.preventDefault()}
      >
        <img
          ref={imgRef}
          alt={imageAlt}
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
