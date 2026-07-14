import { useCallback, useEffect, useRef, useState } from "react";
import {
  type BrowserControlMode,
  type BrowserSessionState,
  fetchBrowserStatus,
  navigateBrowser,
  pasteTextBrowser,
  resetBrowserProfile,
  restartBrowser,
  setBrowserControlMode,
  startBrowser,
  stopBrowser,
} from "../api/client";
import { BrowserToolbar } from "../components/browser/BrowserToolbar";
import { BrowserViewer } from "../components/browser/BrowserViewer";

interface BrowserPanelProps {
  sessionId: string | null;
  sessionCwd: string | null;
}

export function BrowserPanel({ sessionId, sessionCwd }: BrowserPanelProps) {
  const [state, setState] = useState<BrowserSessionState | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clipboardCaptureOpen, setClipboardCaptureOpen] = useState(false);
  const [clipboardText, setClipboardText] = useState("");
  const clipboardCaptureRef = useRef<HTMLTextAreaElement | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId && !sessionCwd) return;
    try {
      setError(null);
      setState(await fetchBrowserStatus(sessionId, sessionCwd));
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }, [sessionId, sessionCwd]);

  useEffect(() => {
    refresh();
    const interval = window.setInterval(refresh, 4_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!clipboardCaptureOpen) return;
    const timeout = window.setTimeout(() => clipboardCaptureRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [clipboardCaptureOpen]);

  const runAction = async (action: () => Promise<BrowserSessionState>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      setState(await action());
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleResetProfile = () => {
    const ok = window.confirm(
      "Reset this browser profile? Wayang will stop Chromium and move the profile directory into .pi/browser-workbench/profile-trash so cookies/login state are no longer active.",
    );
    if (!ok) return;
    runAction(() => resetBrowserProfile(sessionId, sessionCwd));
  };

  const handleControlMode = (mode: BrowserControlMode, reason?: string) => {
    runAction(() => setBrowserControlMode(sessionId, sessionCwd, mode, reason));
  };

  const handlePasteClipboard = () => {
    setError(null);
    setNotice("Middle-click the capture box for Linux mouse-selection paste, or Ctrl+V / Read system clipboard, then paste it into the focused browser field.");
    setClipboardText("");
    setClipboardCaptureOpen(true);
  };

  const handleReadSystemClipboard = async () => {
    if (!navigator.clipboard?.readText) {
      setError("This browser cannot read the system clipboard directly. Use Ctrl+V or middle-click in the capture box instead.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text) throw new Error("System clipboard is empty or does not contain text");
      setClipboardText(text);
      setNotice("System clipboard text captured locally. Review the destination field, then press Paste captured text.");
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePasteCapturedText = async () => {
    if (!clipboardText) {
      setError("Capture text first with middle-click, Ctrl+V, or Read system clipboard.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setState(await pasteTextBrowser(sessionId, sessionCwd, clipboardText));
      setNotice("Pasted captured text into the focused browser page.");
      setClipboardCaptureOpen(false);
      setClipboardText("");
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handlePageChange = useCallback((page: { url?: string; title?: string }) => {
    setState((prev) => prev
      ? { ...prev, activeUrl: page.url ?? prev.activeUrl, activeTitle: page.title ?? prev.activeTitle }
      : prev,
    );
  }, []);

  const running = state?.status === "running";
  const providerLabel = state ? "Active session model/provider applies" : "No browser session yet";

  if (!sessionId && !sessionCwd) {
    return <div className="p-4 text-sm text-neutral-500">Select or create a session before opening the Browser workbench.</div>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-neutral-950 text-neutral-100">
      <BrowserToolbar
        state={state}
        busy={busy}
        onStart={() => runAction(() => startBrowser(sessionId, sessionCwd))}
        onStop={() => runAction(() => stopBrowser(sessionId, sessionCwd))}
        onRestart={() => runAction(() => restartBrowser(sessionId, sessionCwd))}
        onResetProfile={handleResetProfile}
        onControlMode={handleControlMode}
        onNavigate={(url) => runAction(() => navigateBrowser(sessionId, sessionCwd, url))}
        onPasteClipboard={handlePasteClipboard}
      />

      <div className="border-b border-amber-900/50 bg-amber-950/30 px-3 py-2 text-xs text-amber-100">
        The agent may see page text/screenshots when browser tools are used. Type passwords, MFA, CAPTCHA, and payment details only directly in this browser surface, and only with a model/provider you trust for the active page.
      </div>

      {notice && <div className="border-b border-sky-900/50 bg-sky-950/30 px-3 py-2 text-xs text-sky-100">{notice}</div>}
      {clipboardCaptureOpen && (
        <form
          className="border-b border-neutral-800 bg-neutral-950 px-3 py-3 text-xs text-neutral-300"
          onSubmit={(event) => {
            event.preventDefault();
            handlePasteCapturedText();
          }}
        >
          <label className="mb-2 block font-medium text-neutral-200" htmlFor="browser-clipboard-capture">
            Clipboard / mouse-selection capture
          </label>
          <textarea
            id="browser-clipboard-capture"
            ref={clipboardCaptureRef}
            value={clipboardText}
            onChange={(event) => setClipboardText(event.currentTarget.value)}
            placeholder="Middle-click here for Linux mouse selection, or Ctrl+V to capture clipboard text. Contents stay local to Wayang and are sent only to the browser paste endpoint."
            className="mb-2 h-20 w-full resize-y rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="submit"
              disabled={busy || !clipboardText}
              className="rounded border border-sky-600 bg-sky-600/20 px-3 py-1.5 text-xs font-semibold text-sky-100 hover:bg-sky-600/30 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Paste captured text
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={handleReadSystemClipboard}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Read system clipboard
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => {
                setClipboardCaptureOpen(false);
                setClipboardText("");
              }}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:cursor-not-allowed disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </form>
      )}
      {error && <div className="border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</div>}
      {state?.lastError && <div className="border-b border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">{state.lastError}</div>}

      <div className="grid grid-cols-2 gap-2 border-b border-neutral-900 px-3 py-2 text-xs text-neutral-400 md:grid-cols-4">
        <StatusItem label="Status" value={state?.status || "unknown"} />
        <StatusItem label="Control" value={state?.controlMode || "agent"} />
        <StatusItem label="Viewer" value={state?.viewerTransport === "vnc" ? "VNC/noVNC" : "CDP screencast"} />
        <StatusItem label="Profile" value={state?.profile.persistence === "session" ? "session" : "project-persistent"} />
        <StatusItem label="Model" value={providerLabel} />
        <StatusItem label="Title" value={state?.activeTitle || "—"} wide />
        <StatusItem label="URL" value={state?.activeUrl || "about:blank"} wide />
      </div>

      {state?.needsUser && (
        <div className="flex items-center justify-between gap-3 border-b border-sky-900/60 bg-sky-950/40 px-3 py-2 text-sm text-sky-100">
          <span>{state.needsUserReason || "Agent is waiting for user action."}</span>
          <button
            type="button"
            className="rounded border border-sky-500 bg-sky-500/20 px-3 py-1 text-xs font-semibold text-sky-100 hover:bg-sky-500/30"
            onClick={() => handleControlMode("agent")}
          >
            I handled it — resume agent
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {running ? (
          <BrowserViewer
            sessionId={sessionId}
            projectCwd={sessionCwd}
            running={running}
            transport={state?.viewerTransport}
            onStatus={refresh}
            onPageChange={handlePageChange}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
            <div>
              <div className="mb-2 text-base text-neutral-300">Browser workbench is stopped</div>
              <div>Start Chromium to create a persistent project browser profile under <code className="text-neutral-400">.pi/browser-workbench/</code>.</div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

function StatusItem({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <div className="uppercase tracking-wide text-neutral-600">{label}</div>
      <div className="truncate text-neutral-200" title={value}>{value}</div>
    </div>
  );
}
