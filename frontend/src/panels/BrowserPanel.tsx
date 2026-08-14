import { useCallback, useEffect, useRef, useState } from "react";
import {
  ApiError,
  type BrowserAgentDiagnostic,
  type BrowserControlMode,
  type BrowserSessionState,
  type BrowserSurfaceMode,
  type BrowserViewerTransport,
  closeBrowserTab,
  fetchBrowserProfiles,
  fetchBrowserStatus,
  fetchSessionBrowserProfileState,
  navigateBrowser,
  updateSessionBrowserProfileState,
  type NamedBrowserProfile,
  type SessionBrowserProfileState,
  openBrowserTab,
  selectBrowserTab,
  pasteTextBrowser,
  resetBrowserProfile,
  restartBrowser,
  setBrowserControlMode,
  startBrowser,
  stopBrowser,
} from "../api/client";
import { BrowserCredentialsDrawer } from "../components/browser/BrowserCredentialsDrawer";
import { BrowserToolbar } from "../components/browser/BrowserToolbar";
import { BrowserViewer } from "../components/browser/BrowserViewer";

interface BrowserPanelProps {
  sessionId: string | null;
  sessionCwd: string | null;
  browserMode: BrowserSurfaceMode;
  browserAgent: BrowserAgentDiagnostic | null;
}

export function BrowserPanel({ sessionId, sessionCwd, browserMode, browserAgent }: BrowserPanelProps) {
  const [state, setState] = useState<BrowserSessionState | null>(null);
  const [viewerTransport, setViewerTransport] = useState<BrowserViewerTransport>("cdp-screencast");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [clipboardCaptureOpen, setClipboardCaptureOpen] = useState(false);
  const [credentialsOpen, setCredentialsOpen] = useState(false);
  const [vncTakeoverGeneration, setVncTakeoverGeneration] = useState(0);
  const [vncTakeoverConsumed, setVncTakeoverConsumed] = useState(0);
  const [profileChoices, setProfileChoices] = useState<NamedBrowserProfile[]>([]);
  const [sessionProfileState, setSessionProfileState] = useState<SessionBrowserProfileState | null>(null);
  const clipboardCaptureRef = useRef<HTMLTextAreaElement | null>(null);
  const viewerChosenRef = useRef(false);

  const applyState = useCallback((next: BrowserSessionState) => {
    setState(next);
    if (next.profile.persistence === "named" && sessionId) {
      void fetchSessionBrowserProfileState(sessionId).then((current) => setSessionProfileState(current.state)).catch(() => undefined);
    }
    setViewerTransport((current) => {
      // Follow the backend's configured auto/cdp/vnc policy until the user
      // explicitly chooses a currently available viewer. Protected remains CDP.
      if (next.profile.persistence === "protected") return "cdp-screencast";
      if (!viewerChosenRef.current) return next.viewerTransport;
      if (current === "vnc" && next.vncReady === false && next.cdpReady) return "cdp-screencast";
      if (current === "cdp-screencast" && next.cdpReady === false && next.vncReady) return "vnc";
      return current;
    });
  }, [sessionId]);

  const refresh = useCallback(async () => {
    if (browserMode === "unavailable" || (!sessionId && !sessionCwd)) return;
    try {
      setError(null);
      const next = await fetchBrowserStatus(sessionId, sessionCwd);
      applyState(next);
    } catch (err: any) {
      if (browserMode === "protected") {
        setState(null);
        setCredentialsOpen(false);
      }
      setError(err?.message || String(err));
    }
  }, [sessionId, sessionCwd, browserMode, applyState]);

  useEffect(() => {
    let cancelled = false;
    if (browserMode === "standard" && sessionId) {
      setSessionProfileState(null);
      void Promise.all([fetchBrowserProfiles(), fetchSessionBrowserProfileState(sessionId)]).then(([catalog, current]) => {
        if (cancelled) return;
        setProfileChoices(catalog.profiles.filter((profile) => profile.state === "active"));
        setSessionProfileState(current.state);
      }).catch(() => { if (!cancelled) setProfileChoices([]); });
    }
    return () => { cancelled = true; };
  }, [browserMode, sessionId]);

  useEffect(() => {
    viewerChosenRef.current = false;
    setState(null);
    setCredentialsOpen(false);
    setClipboardCaptureOpen(false);
    setVncTakeoverGeneration(0);
    setVncTakeoverConsumed(0);
    void refresh();
    const interval = window.setInterval(refresh, 4_000);
    return () => window.clearInterval(interval);
  }, [refresh]);

  useEffect(() => {
    if (!clipboardCaptureOpen) return;
    const timeout = window.setTimeout(() => clipboardCaptureRef.current?.focus(), 0);
    return () => window.clearTimeout(timeout);
  }, [clipboardCaptureOpen]);

  const runAction = async (action: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await action();
      // Standard and capability-bound browser operations have different
      // internal result shapes. The common backend status projection is the
      // only state this generic panel renders.
      applyState(await fetchBrowserStatus(sessionId, sessionCwd));
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleResetProfile = () => {
    const profileKind = state?.profile.persistence === "protected" ? "protected capability browser" : "backend-selected browser";
    const ok = window.confirm(
      `Reset the ${profileKind} profile? Wayang will stop Chromium and move the profile to a private recovery directory. Saved browser login state will no longer be active.`,
    );
    if (!ok) return;
    void runAction(() => resetBrowserProfile(sessionId, sessionCwd));
  };

  const handleControlMode = async (mode: BrowserControlMode, reason?: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      await setBrowserControlMode(
        sessionId,
        sessionCwd,
        mode,
        state?.profile.persistence === "protected" ? undefined : reason,
      );
      applyState(await fetchBrowserStatus(sessionId, sessionCwd));
    } catch (err: any) {
      if (
        mode === "agent"
        && err instanceof ApiError
        && err.status === 409
        && /credential inspection/i.test(err.message)
      ) {
        setCredentialsOpen(true);
        setError("Generic Resume cannot bypass credential-fill protection. Credentials has been reopened; review the page and choose Allow agent read-only redacted inspection.");
      } else {
        setError(err?.message || String(err));
      }
    } finally {
      setBusy(false);
    }
  };

  const handleViewerTransport = (transport: BrowserViewerTransport) => {
    viewerChosenRef.current = true;
    setVncTakeoverGeneration(0);
    setVncTakeoverConsumed(0);
    setViewerTransport(transport);
    setNotice(transport === "vnc"
      ? "Full browser selected: browser chrome and extensions are visible."
      : "CDP screencast selected: page-only low-latency view is active.");
  };

  const ensureProtectedHumanControl = async (): Promise<boolean> => {
    if (state?.profile.persistence !== "protected" || state.controlMode !== "agent") return true;
    setBusy(true);
    try {
      // Protected paste is an owner-only human action. Establish the
      // handoff/baseline before accepting any clipboard text.
      await setBrowserControlMode(sessionId, sessionCwd, "user");
      applyState(await fetchBrowserStatus(sessionId, sessionCwd));
      return true;
    } catch (err: any) {
      setError(err?.message || String(err));
      return false;
    } finally {
      setBusy(false);
    }
  };

  const handlePasteClipboard = async () => {
    setError(null);
    if (!await ensureProtectedHumanControl()) return;
    setNotice("Paste into the capture target. Text is forwarded immediately to the focused page and is not retained in React state or agent tool parameters.");
    setClipboardCaptureOpen(true);
  };

  const handleViewerPasteText = async (text: string) => {
    setError(null);
    if (!await ensureProtectedHumanControl()) return;
    await handleDirectPasteText(text);
  };

  const handleDirectPasteText = async (text: string) => {
    if (!text) return;
    setBusy(true);
    setError(null);
    setClipboardCaptureOpen(false);
    try {
      applyState(await pasteTextBrowser(sessionId, sessionCwd, text));
      setNotice("Clipboard text pasted into the focused browser field.");
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setBusy(false);
    }
  };

  const handleReadSystemClipboard = async () => {
    if (!navigator.clipboard?.readText) {
      setError("This browser cannot read the system clipboard directly. Use Ctrl+V or middle-click in the capture target instead.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const text = await navigator.clipboard.readText();
      if (!text) throw new Error("System clipboard is empty or does not contain text");
      await handleDirectPasteText(text);
    } catch (err: any) {
      setError(err?.message || String(err));
      setBusy(false);
    }
  };

  const handleCredentialToggle = async () => {
    if (credentialsOpen) {
      setCredentialsOpen(false);
      return;
    }
    const protectedRuntime = state?.profile.persistence === "protected";
    if (protectedRuntime && state?.credentialBroker?.supported !== true) {
      setError("The backend did not advertise guarded credential support for this protected runtime.");
      return;
    }
    setClipboardCaptureOpen(false);
    setNotice("Credentials mode opened. The agent stays paused; after filling, review the page before explicitly allowing read-only redacted text and DOM inspection.");
    // Establish the exact backend control generation before the drawer can
    // request document-bound choices. Publishing the drawer first creates a
    // race in which matches are minted against the old agent-control epoch.
    if (state?.controlMode === "agent") {
      await runAction(() => setBrowserControlMode(
        sessionId,
        sessionCwd,
        "user",
        protectedRuntime ? undefined : "Private credential picker opened; explicit credential review required",
      ));
    }
    setCredentialsOpen(true);
  };

  const handleInspectionAllowed = (nextState: BrowserSessionState) => {
    applyState(nextState);
    setCredentialsOpen(false);
    setError(null);
  };

  const handlePageChange = useCallback((page: { url?: string; title?: string }) => {
    setState((previous) => previous
      // Page notifications update display metadata only. credentialInspection
      // remains backend-owned and changes only when a public state arrives.
      ? { ...previous, activeUrl: page.url ?? previous.activeUrl, activeTitle: page.title ?? previous.activeTitle }
      : previous,
    );
  }, []);

  const running = state?.status === "running";
  const cooperative = state?.controlMode === "agent";
  const credentialInspection = state?.credentialInspection;
  const protectedRuntime = state?.profile.persistence === "protected" || browserMode === "protected";
  // Standard support is the existing generic backend contract. Protected
  // support is positive metadata from the exact runtime and is never inferred
  // from a project/profile label or from Protected styling alone.
  const namedRuntime = state?.profile.persistence === "named";
  const credentialsSupported = state?.credentialBroker?.supported === true;
  const tabControlsDisabled = cooperative || credentialsOpen || credentialInspection !== undefined;
  const pasteSupported = !namedRuntime;
  const resetSupported = !namedRuntime;
  const restartSupported = !namedRuntime;
  const profileLabel = state?.profile.persistence === "named"
    ? state.profile.name || "Named Browser Profile"
    : state?.profile.persistence === "shared"
    ? "Wayang shared"
    : state?.profile.persistence === "session"
      ? "Session isolated"
      : protectedRuntime
        ? "Protected capability"
        : "Project persistent";

  if (!sessionId && !sessionCwd) {
    return <div className="p-4 text-sm text-neutral-500">Select or create a session before opening the Browser workbench.</div>;
  }

  if (browserMode === "unavailable") {
    return (
      <div className="h-full bg-neutral-950 p-4 text-sm text-neutral-200">
        <h2 className="font-medium">Browser agent access is unavailable</h2>
        {browserAgent ? (
          <div data-testid="browser-agent-diagnostic" className="mt-3 rounded border border-amber-900/60 bg-amber-950/25 p-3 text-xs text-amber-100">
            <div>{browserAgent.reason_code ?? "unavailable"}</div>
            <div data-testid="browser-agent-remediation" className="mt-1">{browserAgent.remediation ?? "Start a fresh authorized interactive runtime."}</div>
            <div className="mt-2 text-neutral-400">{browserAgent.tool_state} · {browserAgent.executable.state} · {browserAgent.executable.platform}/{browserAgent.executable.transport}</div>
          </div>
        ) : (
          <p className="mt-2 text-neutral-400">This session has no compatible managed-browser surface.</p>
        )}
      </div>
    );
  }

  return (
    <div className="relative flex h-full min-h-0 min-w-0 flex-col overflow-hidden bg-neutral-950 text-neutral-100">
      {browserMode === "standard" && sessionId && profileChoices.length > 0 && (
        <div className="shrink-0 border-b border-blue-900/50 bg-blue-950/25 px-3 py-3 text-xs text-blue-100">
          <label className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <span className="font-medium">{state?.profile.persistence === "named" ? "Session Browser Profile" : "This session needs a named Browser Profile."}</span>
            <select className="rounded border border-blue-800 bg-neutral-950 px-2 py-1.5 text-neutral-100" value={sessionProfileState?.active_profile_id ?? ""} disabled={busy} onChange={(event) => {
              const profileId = event.target.value;
              if (!profileId) return;
              void runAction(async () => {
                const result = await updateSessionBrowserProfileState(sessionId, profileId, sessionProfileState?.revision ?? null);
                setSessionProfileState(result.state);
                await refresh();
              });
            }}>
              <option value="">Choose profile…</option>
              {profileChoices.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
            </select>
            <span className="text-blue-200/70">This switches only this session; authenticated profile state is shared across approved Standard-browser pairs.</span>
          </label>
        </div>
      )}

      {browserAgent && (
        <div
          data-testid="browser-agent-diagnostic"
          className={`shrink-0 border-b px-3 py-2 text-xs ${browserAgent.available
            ? "border-emerald-900/50 bg-emerald-950/25 text-emerald-100"
            : "border-amber-900/50 bg-amber-950/25 text-amber-100"}`}
        >
          <div className="font-medium">
            Agent browser tools: {browserAgent.available ? "available" : "unavailable"}
            <span className="ml-2 font-normal text-neutral-400">
              {browserAgent.tool_state} · {browserAgent.executable.state} · {browserAgent.executable.platform}/{browserAgent.executable.transport}
            </span>
          </div>
          {!browserAgent.available && browserAgent.remediation && (
            <div className="mt-1" data-testid="browser-agent-remediation">
              {browserAgent.reason_code ? `${browserAgent.reason_code}: ` : ""}{browserAgent.remediation}
            </div>
          )}
        </div>
      )}

      <BrowserToolbar
        state={state}
        busy={busy}
        viewerTransport={viewerTransport}
        credentialsOpen={credentialsOpen}
        credentialsSupported={credentialsSupported}
        pasteSupported={pasteSupported}
        resetSupported={resetSupported}
        restartSupported={restartSupported}
        onStart={() => void runAction(() => startBrowser(sessionId, sessionCwd))}
        onStop={() => void runAction(() => stopBrowser(sessionId, sessionCwd))}
        onRestart={() => void runAction(() => restartBrowser(sessionId, sessionCwd))}
        onResetProfile={handleResetProfile}
        onControlMode={handleControlMode}
        onViewerTransport={handleViewerTransport}
        onCredentials={() => void handleCredentialToggle()}
        onNavigate={(url) => void runAction(() => navigateBrowser(sessionId, sessionCwd, url))}
        onPasteClipboard={() => void handlePasteClipboard()}
      />

      {namedRuntime && viewerTransport === "vnc" && (
        <div role="note" className="shrink-0 border-b border-amber-800/60 bg-amber-950/30 px-3 py-2 text-xs leading-5 text-amber-100">
          <strong>Profile-wide Full browser:</strong> this view can display and control every visible tab in the shared named profile, including tabs owned by other session workspaces. Pixels, clipboard data, cookies, and login state are not session-isolated. Agent tools remain bound to their exact owned targets.
          {state?.fullBrowser?.controllerActive && <button type="button" className="ml-2 rounded border border-amber-600 px-2 py-1 text-[11px] font-semibold" onClick={() => {
            if (window.confirm("Take over profile-wide Full browser control? The previous controller will be disconnected.")) setVncTakeoverGeneration((value) => value + 1);
          }}>Take over controller</button>}
        </div>
      )}

      {state?.profile.persistence === "named" && state.tabs && (
        <div className="flex shrink-0 items-center gap-1 overflow-x-auto border-b border-neutral-900 bg-neutral-950 px-2 py-1.5" role="tablist" aria-label="Session-owned browser tabs">
          {state.tabs.map((tab) => <div key={tab.tab} className={`inline-flex max-w-56 shrink-0 items-center rounded border ${state.activeTab === tab.tab ? "border-blue-600 bg-blue-950/50" : "border-neutral-800 bg-neutral-900"}`}>
            <button type="button" role="tab" aria-selected={state.activeTab === tab.tab} disabled={tabControlsDisabled} onClick={() => void runAction(async () => applyState(await selectBrowserTab(sessionId, sessionCwd, tab.tab)))} className="truncate px-2 py-1 text-xs text-neutral-200" title={tab.title || tab.url || "Untitled tab"}>{tab.title || tab.url || "Untitled tab"}</button>
            <button type="button" aria-label={`Close ${tab.title || "tab"}`} disabled={tabControlsDisabled} onClick={() => void runAction(async () => applyState(await closeBrowserTab(sessionId, sessionCwd, tab.tab)))} className="px-1.5 py-1 text-xs text-neutral-500 hover:text-neutral-100">×</button>
          </div>)}
          <button type="button" disabled={tabControlsDisabled} onClick={() => void runAction(async () => applyState(await openBrowserTab(sessionId, sessionCwd)))} className="shrink-0 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800" aria-label="Open browser tab">＋</button>
        </div>
      )}

      {(state?.profile.persistence === "protected" || state?.profile.persistence === "named") && (
        <div data-testid="protected-downloads" className="shrink-0 border-b border-neutral-900 bg-neutral-950 px-3 py-1.5 text-xs text-neutral-500">
          Completed bounded downloads from exactly owned tabs publish to <code className="text-neutral-300">.wayang/browser-downloads/</code>.
          {state?.download && (
            <span className="ml-2" data-testid="protected-download-status">
              Latest: <span className="text-neutral-300">{state.download.status}</span>
              {state.download.bytes !== undefined && <> · {formatBytes(state.download.bytes)}</>}
            </span>
          )}
        </div>
      )}

      <div className={`shrink-0 border-b px-3 py-2 text-xs ${
        credentialInspection === "text-allowed"
          ? "border-sky-900/60 bg-sky-950/35 text-sky-100"
          : cooperative
            ? "border-emerald-900/50 bg-emerald-950/25 text-emerald-100"
            : "border-amber-800/60 bg-amber-950/35 text-amber-100"
      }`}>
        {credentialInspection === "blocked"
          ? "Credential fill protection: the agent remains paused. Reopen Credentials to allow read-only redacted text and DOM inspection after reviewing the page."
          : credentialInspection === "text-allowed"
            ? "Agent read-only inspection: redacted text and DOM only. Agent screenshots and all agent navigation, click, type, and mutations remain blocked until the backend confirms a new top-level document."
            : protectedRuntime && cooperative
              ? "Protected agent control is active. Choose Human control before login, MFA, CAPTCHA, payment, or other secret-bearing steps."
              : protectedRuntime
                ? "Protected human control: use the viewer or owner-only Paste. Resume is allowed only after the browser reaches a fresh, safe top-level document."
                : cooperative
                  ? "Shared control: you and the agent may act in this browser at the same time. Pause the agent before sensitive or irreversible steps."
                  : "Agent paused: your viewer input remains active, but agent browser inspection and actions are blocked until Resume agent."}
      </div>

      <details className="shrink-0 border-b border-neutral-900 bg-neutral-950 text-xs text-neutral-400">
        <summary className="cursor-pointer px-3 py-1.5 text-neutral-500 hover:text-neutral-300">
          {protectedRuntime ? "Safety, privacy, and browser details" : "Privacy and browser details"}
        </summary>
        <div className="border-t border-neutral-900 px-3 py-2" role={protectedRuntime ? "note" : undefined}>
          {protectedRuntime
            ? "Protected browser capability: the agent can inspect authenticated pages, click, type non-secret text, download, and cause remote effects. Existing cookies may permit purchases, deletions, exports, account changes, logout, or passkey flows; human-only login and payment do not make later agent actions read-only."
            : "The agent may see page content and cause browser-mediated remote effects when browser tools are used."}
          {" "}Handle login, MFA, CAPTCHA, payment, booking, account changes, and other sensitive or irreversible steps with the agent paused. An authenticated remote Wayang controller has the same browser UI authority as a local controller.
        </div>
        {protectedRuntime && !cooperative && (
          <div data-testid="protected-human-handoff" className="border-t border-amber-900/50 bg-amber-950/20 px-3 py-2 text-amber-100">
            Enter passwords, MFA codes, CAPTCHA answers, passkeys, payment details, and other secrets only in the human-controlled viewer. {credentialsSupported ? "Guarded saved-login fill sends values only from the backend broker to this exact CDP document." : "Guarded saved-login support is unavailable."} Owner-only Direct Paste uses an authenticated route and is never exposed as an agent operation. Navigate to a fresh safe page before resuming the agent.
          </div>
        )}
        <div className="grid grid-cols-2 gap-x-3 gap-y-2 border-t border-neutral-900 px-3 py-2 sm:grid-cols-4">
          <StatusItem label="Browser" value={state?.status || "unknown"} />
          <StatusItem
            label="Control"
            value={credentialInspection === "text-allowed" ? "agent read-only" : cooperative ? "shared / cooperative" : "agent paused"}
          />
          <StatusItem
            label="Inspection"
            value={credentialInspection === "blocked"
              ? "credential-blocked"
              : credentialInspection === "text-allowed"
                ? "read-only redacted text / DOM"
                : "standard"}
          />
          <StatusItem label="Viewer" value={viewerTransport === "vnc" ? "Full browser" : "CDP screencast"} />
          <StatusItem label="Profile" value={profileLabel} />
          <StatusItem label="Title" value={state?.activeTitle || "—"} wide />
          <StatusItem label="URL" value={state?.activeUrl || "about:blank"} wide />
        </div>
      </details>

      {notice && <div className="shrink-0 border-b border-sky-900/50 bg-sky-950/30 px-3 py-2 text-xs text-sky-100">{notice}</div>}
      {clipboardCaptureOpen && (
        <div className="shrink-0 border-b border-neutral-800 bg-neutral-950 px-3 py-3 text-xs text-neutral-300">
          <label className="mb-2 block font-medium text-neutral-200" htmlFor="browser-clipboard-capture">
            Direct paste target
          </label>
          <textarea
            id="browser-clipboard-capture"
            ref={clipboardCaptureRef}
            defaultValue=""
            onPaste={(event) => {
              const text = event.clipboardData.getData("text/plain");
              if (!text) return;
              event.preventDefault();
              event.currentTarget.value = "";
              void handleDirectPasteText(text);
            }}
            onInput={(event) => {
              // Linux PRIMARY/middle-click paste may arrive only as an input
              // event. Read the uncontrolled DOM value once, clear it
              // immediately, and never copy it into React state.
              const text = event.currentTarget.value;
              event.currentTarget.value = "";
              if (text) void handleDirectPasteText(text);
            }}
            placeholder="Ctrl+V or middle-click here. Text is sent immediately and not displayed or retained."
            className="mb-2 h-16 w-full resize-none rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500 focus:outline-none"
          />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void handleReadSystemClipboard()}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
            >
              Read and paste system clipboard
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => setClipboardCaptureOpen(false)}
              className="rounded border border-neutral-700 bg-neutral-900 px-3 py-1.5 text-xs font-medium text-neutral-200 hover:bg-neutral-800 disabled:opacity-40"
            >
              Cancel
            </button>
          </div>
        </div>
      )}
      {error && <div className="shrink-0 border-b border-red-900/50 bg-red-950/40 px-3 py-2 text-sm text-red-200">{error}</div>}
      {state?.lastError && <div className="shrink-0 border-b border-red-900/50 bg-red-950/30 px-3 py-2 text-xs text-red-200">{state.lastError}</div>}

      {state?.needsUser && !cooperative && (
        <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-sky-900/60 bg-sky-950/40 px-3 py-2 text-sm text-sky-100">
          <span>{credentialInspection === "blocked"
            ? "Credentials were filled. Generic Resume is blocked; reopen Credentials to review the page and explicitly allow read-only redacted text and DOM inspection."
            : protectedRuntime
              ? "Human control is active. Finish the sensitive step and navigate to a fresh safe document before resuming the agent."
              : state.needsUserReason || "Agent is waiting while you handle this browser step."}</span>
          <button
            type="button"
            className="rounded border border-sky-500 bg-sky-500/20 px-3 py-1 text-xs font-semibold text-sky-100 hover:bg-sky-500/30"
            onClick={() => handleControlMode("agent")}
          >
            Resume agent
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1">
        {running ? (
          namedRuntime && cooperative && viewerTransport !== "vnc" ? (
            <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
              <div><div className="mb-2 text-base text-neutral-300">Viewer paused during agent control</div><div>Choose Pause agent to take explicit human control and attach the exact session tab viewer.</div></div>
            </div>
          ) : <BrowserViewer
            sessionId={sessionId}
            projectCwd={sessionCwd}
            running
            key={viewerTransport === "vnc"
              ? "vnc"
              : `${viewerTransport}:${state?.controlMode ?? "unknown"}:${state?.activeTab ?? "none"}`}
            transport={viewerTransport}
            vncTakeoverRequest={vncTakeoverGeneration}
            vncTakeoverConsumed={vncTakeoverConsumed}
            onVncTakeoverConsumed={setVncTakeoverConsumed}
            onStatus={refresh}
            onPageChange={handlePageChange}
            onPasteText={pasteSupported ? (text) => void handleViewerPasteText(text) : undefined}
          />
        ) : (
          <div className="flex h-full items-center justify-center p-6 text-center text-sm text-neutral-500">
            <div>
              <div className="mb-2 text-base text-neutral-300">Browser workbench is stopped</div>
              <div>{protectedRuntime ? "Start the backend-issued protected browser runtime." : "Start Chromium to use the backend-selected browser runtime."}</div>
            </div>
          </div>
        )}
      </div>

      {credentialsSupported && (
        <BrowserCredentialsDrawer
          open={credentialsOpen}
          sessionId={sessionId}
          projectCwd={sessionCwd}
          pageIdentity={state?.activeUrl}
          credentialInspection={credentialInspection}
          onClose={() => setCredentialsOpen(false)}
          onCredentialFilled={refresh}
          onInspectionAllowed={handleInspectionAllowed}
          onNotice={setNotice}
          onError={setError}
        />
      )}
    </div>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function StatusItem({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? "col-span-2 min-w-0" : "min-w-0"}>
      <div className="uppercase tracking-wide text-neutral-600">{label}</div>
      <div className="truncate text-neutral-200" title={value}>{value}</div>
    </div>
  );
}
