import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import type { RegisteredApp } from "../../api/client";
import { useAppBridge } from "../../hooks/useAppBridge";

interface AppFrameProps {
  app: RegisteredApp;
  sessionId: string;
  onEvent: () => void;
  reloadToken?: number;
  chromeHidden?: boolean;
}

export function AppFrame({ app, sessionId, onEvent, reloadToken = 0, chromeHidden = false }: AppFrameProps) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const [stateDraft, setStateDraft] = useState("{}");
  const [stateError, setStateError] = useState("");
  const [bridgeHeight, setBridgeHeight] = useState(156);
  const [bridgeCollapsed, setBridgeCollapsed] = useState(false);
  const { stateRecord, bridgeError, setState, sendStateToFrame } = useAppBridge({ app, sessionId, iframeRef, onEvent });

  const src = useMemo(() => {
    if (!app.url) return "about:blank";
    return `/api/apps/${encodeURIComponent(app.id)}/proxy/${encodeURIComponent(sessionId)}/`;
  }, [app.id, app.url, sessionId]);

  useEffect(() => {
    if (stateRecord) setStateDraft(JSON.stringify(redactSensitiveState(stateRecord.state), null, 2));
  }, [stateRecord]);

  if (!app.url) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-neutral-500">
        App is not running. Launch or restart it to load the iframe.
      </div>
    );
  }

  async function applyState() {
    try {
      const parsed = stateDraft.trim() ? JSON.parse(stateDraft) : null;
      await setState(restoreSensitiveState(parsed, stateRecord?.state));
      setStateError("");
    } catch (err: any) {
      setStateError(err?.message || String(err));
    }
  }

  function startBridgeResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = bridgeHeight;
    const onMove = (moveEvent: MouseEvent) => {
      const nextHeight = Math.max(32, Math.min(Math.max(420, window.innerHeight - 160), startHeight + startY - moveEvent.clientY));
      setBridgeCollapsed(false);
      setBridgeHeight(nextHeight);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <iframe
        key={`${reloadToken}:${reloadKey}`}
        ref={iframeRef}
        src={src}
        title={app.manifest?.name || app.id}
        className="min-h-0 flex-1 border-0 bg-white"
        onLoad={() => sendStateToFrame(stateRecord?.state ?? null)}
      />
      {!chromeHidden && (
        <>
          <div
            role="separator"
            aria-label="Resize bridge state panel"
            onMouseDown={startBridgeResize}
            className="group flex h-2 cursor-row-resize items-center justify-center border-t border-neutral-900 bg-neutral-950 hover:bg-neutral-900"
          >
            <div className="h-0.5 w-10 rounded bg-neutral-800 group-hover:bg-neutral-600" />
          </div>
          <div
            className="shrink-0 overflow-hidden border-t border-neutral-900 bg-neutral-950 p-3"
            style={{ height: bridgeCollapsed ? 36 : bridgeHeight }}
          >
        <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <div className="min-w-0">
            <div className="text-xs font-semibold text-neutral-300">Bridge state</div>
            {!bridgeCollapsed && (
              <div className="max-w-full text-[11px] text-neutral-600 sm:max-w-md">
                Apps can post <code>source: "pi-app"</code> messages; parent sends <code>state:update</code>.
              </div>
            )}
          </div>
          <div className="flex gap-2 overflow-x-auto pb-1 [-webkit-overflow-scrolling:touch] sm:shrink-0">
            <button
              type="button"
              onClick={() => setBridgeCollapsed((value) => !value)}
              className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900"
            >
              {bridgeCollapsed ? "Show state" : "Hide state"}
            </button>
            <button
              type="button"
              onClick={() => setReloadKey((n) => n + 1)}
              className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900"
            >
              Reload iframe
            </button>
            <button
              type="button"
              onClick={() => sendStateToFrame()}
              className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900"
            >
              Send current state
            </button>
            <button
              type="button"
              onClick={applyState}
              className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900"
            >
              Save + send draft
            </button>
          </div>
        </div>
        {!bridgeCollapsed && (
          <>
            <textarea
              value={stateDraft}
              onChange={(e) => setStateDraft(e.target.value)}
              className="h-[calc(100%-42px)] min-h-10 w-full resize-none rounded border border-neutral-800 bg-neutral-900 p-2 font-mono text-xs text-neutral-200 outline-none focus:border-neutral-600"
              spellCheck={false}
            />
            {(bridgeError || stateError) && <div className="mt-2 text-xs text-red-300">{bridgeError || stateError}</div>}
          </>
        )}
          </div>
        </>
      )}
    </div>
  );
}

function isSensitiveKey(key: string): boolean {
  return /(token|secret|password|credential|api[_-]?key)/i.test(key);
}

function redactSensitiveState(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSensitiveState);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveKey(key) && typeof entry === "string" ? "<redacted>" : redactSensitiveState(entry),
    ]),
  );
}

function restoreSensitiveState(next: unknown, current: unknown): unknown {
  if (Array.isArray(next)) {
    return next.map((entry, index) => restoreSensitiveState(entry, Array.isArray(current) ? current[index] : undefined));
  }
  if (!next || typeof next !== "object") return next;
  const currentObject = current && typeof current === "object" ? (current as Record<string, unknown>) : {};
  return Object.fromEntries(
    Object.entries(next as Record<string, unknown>).map(([key, entry]) => [
      key,
      isSensitiveKey(key) && entry === "<redacted>" ? currentObject[key] : restoreSensitiveState(entry, currentObject[key]),
    ]),
  );
}
