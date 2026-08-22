import { useCallback, useEffect, useRef, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import {
  AlertCircle,
  BellRing,
  Columns3,
  FolderOpen,
  Loader2,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  Settings as SettingsIcon,
  Terminal,
} from "lucide-react";
import {
  ApiError,
  fetchMe,
  createSession,
  getSession,
  type Me,
  type Session,
} from "./api/client";
import { SessionsPanel } from "./panels/SessionsPanel";
import { ChatPanel } from "./panels/ChatPanel";
import { NewSessionPanel } from "./panels/NewSessionPanel";
import { RightPanel } from "./panels/RightPanel";
import { ScheduledJobsPanel } from "./panels/ScheduledJobsPanel";
import { ProtectedAutomationsPanel } from "./panels/ProtectedAutomationsPanel";
import { isCurrentSessionPath, parseSessionPath, sessionPath } from "./routing/sessionRoute";
import { SettingsDialog, type SettingsTab } from "./components/settings/SettingsDialog";
import type { TranscriptOpenIntent } from "./transcript/windowController";

type MobileTab = "sessions" | "chat" | "tools";

type RouteResolution =
  | { kind: "idle" }
  | { kind: "loading"; requestedId: string }
  | { kind: "ready"; requestedId: string }
  | { kind: "not_found"; requestedId: string }
  | { kind: "error"; requestedId: string };

function createTranscriptOpenIntent(anchorId?: string | null): TranscriptOpenIntent {
  const requestKey = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
    ? crypto.randomUUID()
    : `transcript-intent-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return anchorId
    ? { kind: "around", anchorId, requestKey }
    : { kind: "latest", requestKey };
}

function initialRouteResolution(): RouteResolution {
  const route = parseSessionPath(window.location.pathname);
  if (route.kind === "root") return { kind: "idle" };
  if (route.kind === "session") return { kind: "loading", requestedId: route.sessionId };
  return { kind: "not_found", requestedId: route.requestedPath };
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );
  useEffect(() => {
    const mql = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, [query]);
  return matches;
}

function useVisualViewportHeightVariable(): void {
  useEffect(() => {
    if (typeof window === "undefined") return;

    const updateViewportHeight = () => {
      const height = window.visualViewport?.height ?? window.innerHeight;
      document.documentElement.style.setProperty("--wayang-viewport-height", `${height}px`);
    };

    updateViewportHeight();
    window.addEventListener("resize", updateViewportHeight);
    window.addEventListener("orientationchange", updateViewportHeight);
    window.visualViewport?.addEventListener("resize", updateViewportHeight);
    window.visualViewport?.addEventListener("scroll", updateViewportHeight);

    return () => {
      window.removeEventListener("resize", updateViewportHeight);
      window.removeEventListener("orientationchange", updateViewportHeight);
      window.visualViewport?.removeEventListener("resize", updateViewportHeight);
      window.visualViewport?.removeEventListener("scroll", updateViewportHeight);
    };
  }, []);
}

interface AppProps {
  authEnabled: boolean;
  onLogout: () => Promise<void>;
}

function App({ authEnabled, onLogout }: AppProps) {
  useVisualViewportHeightVariable();

  const [me, setMe] = useState<Me | null>(null);
  const [meError, setMeError] = useState<string>("");
  const [activeSession, setActiveSession] = useState<Session | null>(null);
  const [activeProjectCwd, setActiveProjectCwd] = useState<string | null>(null);
  const activeSessionId = activeSession?.id ?? null;
  const [scrollToMessageId, setScrollToMessageId] = useState<string | null>(null);
  const [transcriptOpenIntent, setTranscriptOpenIntent] = useState<TranscriptOpenIntent>(
    () => createTranscriptOpenIntent(),
  );
  const [sessionChangeTrigger, setSessionChangeTrigger] = useState(0);
  const [humanAttentionCount, setHumanAttentionCount] = useState(0);
  const [showNewSession, setShowNewSession] = useState(false);
  const [activeScheduledJobId, setActiveScheduledJobId] = useState<string | null>(null);
  const [showScheduledJobs, setShowScheduledJobs] = useState(false);
  const [activeProtectedAutomationJobId, setActiveProtectedAutomationJobId] = useState<string | null>(null);
  const [showProtectedAutomations, setShowProtectedAutomations] = useState(false);
  const [settingsRequest, setSettingsRequest] = useState<{ tab: SettingsTab; projectCwd: string | null } | null>(null);
  const [routeResolution, setRouteResolution] = useState<RouteResolution>(initialRouteResolution);
  const routeRequestGenerationRef = useRef(0);
  const sessionSelectionStartedAtRef = useRef<number | null>(null);

  const isMobile = useMediaQuery("(max-width: 768px)");
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");

  const handleSessionChange = useCallback(() => {
    setSessionChangeTrigger((n) => n + 1);
  }, []);

  const navigateToSession = useCallback(
    (session: Session, messageId: string | null = null) => {
      // Known metadata can render immediately. Any in-flight URL restoration
      // is stale as soon as the user makes an explicit selection.
      sessionSelectionStartedAtRef.current = performance.now();
      routeRequestGenerationRef.current += 1;
      setRouteResolution({ kind: "ready", requestedId: session.id });
      setActiveSession(session);
      setActiveProjectCwd(session.cwd.replace(/\/+$/, "") || "/");
      setShowNewSession(false);
      setShowScheduledJobs(false);
      setShowProtectedAutomations(false);
      setScrollToMessageId(messageId);
      setTranscriptOpenIntent(createTranscriptOpenIntent(messageId));
      if (!isCurrentSessionPath(session.id)) {
        window.history.pushState(window.history.state, "", sessionPath(session.id));
      }
      if (isMobile) setMobileTab("chat");
    },
    [isMobile],
  );

  const handleSelectSession = useCallback(
    (session: Session) => navigateToSession(session),
    [navigateToSession],
  );

  const handleSelectSearchResult = useCallback(
    (session: Session, messageId: string | null) => {
      // Navigate immediately with search-owned metadata. Runtime enrichment is
      // asynchronous and can only update the still-selected row.
      navigateToSession(session, messageId);
      void getSession(session.id).then((resolved) => {
        setActiveSession((current) => current?.id === session.id ? resolved : current);
      }).catch(() => {});
    },
    [navigateToSession],
  );

  const handleSelectProject = useCallback((cwd: string) => {
    setActiveProjectCwd(cwd);
  }, []);

  const handleCreateSessionForProject = useCallback(
    async (cwd: string) => {
      const session = await createSession(cwd);
      handleSelectSession(session);
      handleSessionChange();
      setShowNewSession(false);
      setShowScheduledJobs(false);
      setShowProtectedAutomations(false);
    },
    [handleSelectSession, handleSessionChange],
  );

  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

  const handleBrowseSessions = useCallback(() => {
    if (isMobile) {
      setMobileTab("sessions");
    } else {
      leftPanelRef.current?.expand();
    }
  }, [isMobile, leftPanelRef]);

  const handleRemovedActiveSession = useCallback(() => {
    routeRequestGenerationRef.current += 1;
    setActiveSession(null);
    setScrollToMessageId(null);
    setTranscriptOpenIntent(createTranscriptOpenIntent());
    setRouteResolution({ kind: "idle" });
    if (window.location.pathname !== "/") {
      window.history.replaceState(window.history.state, "", "/");
    }
  }, []);

  const resolveRoute = useCallback((pathname: string) => {
    const generation = ++routeRequestGenerationRef.current;
    const route = parseSessionPath(pathname);

    setShowNewSession(false);
    setShowScheduledJobs(false);
    setShowProtectedAutomations(false);
    setScrollToMessageId(null);
    setTranscriptOpenIntent(createTranscriptOpenIntent());

    if (route.kind === "root") {
      setActiveSession(null);
      setActiveProjectCwd(null);
      setRouteResolution({ kind: "idle" });
      return;
    }

    if (route.kind === "invalid") {
      setActiveSession(null);
      setActiveProjectCwd(null);
      setRouteResolution({ kind: "not_found", requestedId: route.requestedPath });
      if (window.matchMedia("(max-width: 768px)").matches) setMobileTab("sessions");
      return;
    }

    sessionSelectionStartedAtRef.current = performance.now();
    setActiveSession(null);
    setActiveProjectCwd(null);
    setRouteResolution({ kind: "loading", requestedId: route.sessionId });

    void getSession(route.sessionId).then((session) => {
      if (generation !== routeRequestGenerationRef.current) return;
      setActiveSession(session);
      setActiveProjectCwd(session.cwd.replace(/\/+$/, "") || "/");
      setRouteResolution({ kind: "ready", requestedId: session.id });
      setMobileTab((current) => window.matchMedia("(max-width: 768px)").matches ? "chat" : current);
      if (window.location.pathname !== route.canonicalPath) {
        window.history.replaceState(window.history.state, "", route.canonicalPath);
      }
    }).catch((error: unknown) => {
      if (generation !== routeRequestGenerationRef.current) return;
      setActiveSession(null);
      setActiveProjectCwd(null);
      if (error instanceof ApiError && error.status === 404) {
        setRouteResolution({ kind: "not_found", requestedId: route.sessionId });
        if (window.matchMedia("(max-width: 768px)").matches) setMobileTab("sessions");
        return;
      }
      setRouteResolution({ kind: "error", requestedId: route.sessionId });
    });
  }, []);

  useEffect(() => {
    const handlePopState = () => resolveRoute(window.location.pathname);
    resolveRoute(window.location.pathname);
    window.addEventListener("popstate", handlePopState);
    return () => {
      routeRequestGenerationRef.current += 1;
      window.removeEventListener("popstate", handlePopState);
    };
  }, [resolveRoute]);

  // Fetch user info
  useEffect(() => {
    let cancelled = false;
    fetchMe()
      .then((data) => {
        if (!cancelled) {
          setMe(data);
          setMeError("");
        }
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        setMeError(
          err instanceof ApiError ? `HTTP ${err.status}` : String(err),
        );
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const handleSelectScheduledJob = useCallback(
    (jobId: string | null) => {
      setActiveScheduledJobId(jobId);
      setShowScheduledJobs(true);
      setShowProtectedAutomations(false);
      setShowNewSession(false);
      if (isMobile) setMobileTab("chat");
    },
    [isMobile],
  );

  const handleSelectProtectedAutomation = useCallback(
    (jobId: string | null) => {
      setActiveProtectedAutomationJobId(jobId);
      setShowProtectedAutomations(true);
      setShowScheduledJobs(false);
      setShowNewSession(false);
      if (isMobile) setMobileTab("chat");
    },
    [isMobile],
  );

  const handleOpenScheduledSession = useCallback(
    (sessionId: string) => {
      // Scheduled run rows currently expose only the session id. Show the
      // selected-session loading shell immediately, then enrich metadata if the
      // user has not selected another session in the meantime.
      const placeholder: Session = {
        id: sessionId,
        pi_session_file: null,
        title: "Scheduled session",
        cwd: "",
        provider: null,
        model: null,
        agent_profile_id: null,
        pending_agent_switch: null,
        created_at: Date.now(),
        last_active: Date.now(),
        archived: 0,
        goal: null,
        goal_status: null,
        scheduled_job_id: null,
        scheduled_run_id: null,
        error: null,
        error_kind: null,
        runtime_status: "stopped",
        runtime_is_streaming: false,
        runtime_is_compacting: false,
        runtime_subscriber_count: 0,
        runtime_last_activity_at: null,
        bash_mode: "unavailable",
        browser_mode: "unavailable",
        humanAttention: [],
      };
      navigateToSession(placeholder);
      void getSession(sessionId).then((session) => {
        setActiveSession((current) => {
          if (current?.id !== sessionId) return current;
          setActiveProjectCwd(session.cwd.replace(/\/+$/, "") || "/");
          return session;
        });
        handleSessionChange();
      }).catch(() => {});
    },
    [navigateToSession, handleSessionChange],
  );

  const sessionsPanel = (
    <SessionsPanel
      activeSessionId={activeSessionId}
      active={!isMobile || mobileTab === "sessions"}
      activeProjectCwd={activeProjectCwd}
      activeScheduledJobId={showScheduledJobs ? activeScheduledJobId : null}
      activeProtectedAutomationJobId={showProtectedAutomations ? activeProtectedAutomationJobId : null}
      onSelect={handleSelectSession}
      onSelectSearchResult={handleSelectSearchResult}
      onSelectProject={handleSelectProject}
      onNewSessionForProject={handleCreateSessionForProject}
      onOpenProjectSettings={(cwd) => setSettingsRequest({ tab: "projects", projectCwd: cwd })}
      onSelectScheduledJob={handleSelectScheduledJob}
      onSelectProtectedAutomation={handleSelectProtectedAutomation}
      onArchiveActive={handleRemovedActiveSession}
      onAttentionCountChange={setHumanAttentionCount}
      refreshTrigger={sessionChangeTrigger}
      onNewSession={() => {
        setShowNewSession(true);
        setShowScheduledJobs(false);
        setShowProtectedAutomations(false);
        if (isMobile) setMobileTab("chat");
      }}
    />
  );

  const hasRouteNotice = routeResolution.kind === "loading"
    || routeResolution.kind === "not_found"
    || routeResolution.kind === "error";

  const centerPanel = (
    <div className="relative h-full w-full overflow-hidden">
      {/* Keep ChatPanel mounted so its browser-level WebSocket survives local
          navigation between center-pane tools. Session changes still use the
          existing switch_session message instead of constructing a new socket. */}
      <div className={`h-full ${showNewSession || showScheduledJobs || showProtectedAutomations || hasRouteNotice ? "hidden" : ""}`}>
        <ChatPanel
          activeSession={activeSession}
          sessionSelectionStartedAt={sessionSelectionStartedAtRef.current}
          onSessionChange={handleSessionChange}
          onSessionUpdate={setActiveSession}
          transcriptOpenIntent={transcriptOpenIntent}
          scrollToMessageId={scrollToMessageId}
          onScrollToMessageHandled={() => setScrollToMessageId(null)}
        />
      </div>
      {hasRouteNotice && (
        <div className="absolute inset-0 bg-neutral-950">
          <SessionRouteNotice
            resolution={routeResolution}
            onRetry={() => resolveRoute(window.location.pathname)}
            onBrowse={handleBrowseSessions}
          />
        </div>
      )}
      {showNewSession && (
        <div className="absolute inset-0 bg-neutral-950">
          <NewSessionPanel
            onCreated={(session) => {
              handleSelectSession(session);
              handleSessionChange();
              setShowNewSession(false);
            }}
            onCancel={() => setShowNewSession(false)}
          />
        </div>
      )}
      {showScheduledJobs && (
        <div className="absolute inset-0 bg-neutral-950">
          <ScheduledJobsPanel
            selectedJobId={activeScheduledJobId}
            onSelectJob={handleSelectScheduledJob}
            onOpenSession={handleOpenScheduledSession}
            onChanged={handleSessionChange}
            onClose={() => setShowScheduledJobs(false)}
          />
        </div>
      )}
      {showProtectedAutomations && (
        <div className="absolute inset-0 bg-neutral-950">
          <ProtectedAutomationsPanel
            selectedJobId={activeProtectedAutomationJobId}
            sourceSessionId={activeSessionId}
            onSelectJob={handleSelectProtectedAutomation}
            onChanged={handleSessionChange}
            onClose={() => setShowProtectedAutomations(false)}
          />
        </div>
      )}
    </div>
  );

  const rightPanel = (
    <RightPanel
      sessionId={activeSessionId}
      sessionCwd={activeSession?.cwd ?? null}
      browserMode={activeSession?.browser_mode ?? "unavailable"}
      browserAgent={activeSession?.browser_agent ?? null}
    />
  );

  return (
    <div className="h-full w-full overflow-hidden bg-neutral-950 text-neutral-100 flex flex-col">
      <HeaderBar
        me={me}
        meError={meError}
        authEnabled={authEnabled}
        onLogout={onLogout}
        leftCollapsed={leftCollapsed}
        rightCollapsed={rightCollapsed}
        isMobile={isMobile}
        onOpenSettings={() => setSettingsRequest({ tab: "projects", projectCwd: activeProjectCwd })}
        humanAttentionCount={humanAttentionCount}
        onOpenHumanAttention={handleBrowseSessions}
        onToggleLeft={() => {
          if (leftCollapsed) {
            leftPanelRef.current?.expand();
          } else {
            leftPanelRef.current?.collapse();
          }
        }}
        onToggleRight={() => {
          if (rightCollapsed) {
            rightPanelRef.current?.expand();
          } else {
            rightPanelRef.current?.collapse();
          }
        }}
      />

      {isMobile ? (
        <>
          <div className="relative flex-1 min-h-0 overflow-hidden">
            <div
              className={`absolute inset-0 flex flex-col ${mobileTab === "sessions" ? "" : "hidden"}`}
              aria-hidden={mobileTab !== "sessions"}
              inert={mobileTab !== "sessions"}
            >
              {routeResolution.kind === "not_found" && (
                <SessionRouteNotice
                  resolution={routeResolution}
                  onRetry={() => resolveRoute(window.location.pathname)}
                  onBrowse={handleBrowseSessions}
                  compact
                />
              )}
              <div className="min-h-0 flex-1">{sessionsPanel}</div>
            </div>
            <div
              className={`absolute inset-0 ${mobileTab === "chat" ? "" : "hidden"}`}
              aria-hidden={mobileTab !== "chat"}
              inert={mobileTab !== "chat"}
            >
              {centerPanel}
            </div>
            {mobileTab === "tools" && <div className="absolute inset-0">{rightPanel}</div>}
          </div>
          <MobileTabBar activeTab={mobileTab} onTabChange={setMobileTab} />
        </>
      ) : (
        <div className="flex-1 min-h-0 w-full">
          <Group orientation="horizontal" className="h-full w-full">
            <Panel
              panelRef={leftPanelRef}
              defaultSize={18}
              minSize={12}
              collapsedSize={0}
              collapsible={true}
              onResize={(size) => setLeftCollapsed(size.asPercentage === 0)}
            >
              {sessionsPanel}
            </Panel>
            <Separator className="w-0.5 bg-neutral-800 hover:bg-neutral-600 transition-colors" />
            <Panel defaultSize={52} minSize={30}>
              {centerPanel}
            </Panel>
            <Separator className="w-0.5 bg-neutral-800 hover:bg-neutral-600 transition-colors" />
            <Panel
              panelRef={rightPanelRef}
              defaultSize={30}
              minSize={20}
              collapsedSize={0}
              collapsible={true}
              onResize={(size) => setRightCollapsed(size.asPercentage === 0)}
            >
              {rightPanel}
            </Panel>
          </Group>
        </div>
      )}

      {settingsRequest && (
        <SettingsDialog
          initialTab={settingsRequest.tab}
          initialProjectCwd={settingsRequest.projectCwd}
          onClose={() => setSettingsRequest(null)}
          onChanged={handleSessionChange}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Session route status
// ---------------------------------------------------------------------------

function shortRequestedId(requestedId: string): string {
  if (requestedId.length <= 24) return requestedId;
  return `${requestedId.slice(0, 12)}…${requestedId.slice(-8)}`;
}

function SessionRouteNotice({
  resolution,
  onRetry,
  onBrowse,
  compact = false,
}: {
  resolution: RouteResolution;
  onRetry: () => void;
  onBrowse: () => void;
  compact?: boolean;
}) {
  if (resolution.kind === "idle" || resolution.kind === "ready") return null;

  const loading = resolution.kind === "loading";
  const notFound = resolution.kind === "not_found";
  const title = loading
    ? "Loading session…"
    : notFound
      ? "Session not found"
      : "Unable to load session";
  const description = notFound
    ? "It may have been deleted or is unavailable on this Wayang instance."
    : "Wayang could not load this session right now. Check the connection and try again.";

  return (
    <section
      role={loading ? "status" : "alert"}
      aria-live={loading ? "polite" : "assertive"}
      data-testid={`session-route-${loading ? "loading" : notFound ? "not-found" : "error"}`}
      className={compact
        ? "shrink-0 border-b border-neutral-800 bg-neutral-900/70 px-4 py-3"
        : "flex h-full items-center justify-center px-6 text-center"}
    >
      <div className={compact ? "mx-auto max-w-xl" : "max-w-md"}>
        <div className={`flex ${compact ? "items-start" : "flex-col items-center"} gap-3`}>
          {loading
            ? <Loader2 size={compact ? 18 : 24} className="shrink-0 animate-spin text-blue-400" />
            : <AlertCircle size={compact ? 18 : 28} className={notFound ? "shrink-0 text-amber-400" : "shrink-0 text-red-400"} />}
          <div className={compact ? "min-w-0 flex-1" : ""}>
            <h1 className={`${compact ? "text-sm" : "text-lg"} font-semibold text-neutral-100`}>{title}</h1>
            {!loading && (
              <>
                <p className="mt-1 break-all font-mono text-xs text-neutral-500">
                  {shortRequestedId(resolution.requestedId)}
                </p>
                <p className="mt-2 text-sm leading-relaxed text-neutral-400">{description}</p>
                <div className={`mt-3 flex flex-wrap gap-2 ${compact ? "" : "justify-center"}`}>
                  {!notFound && (
                    <button
                      type="button"
                      data-testid="session-route-retry"
                      onClick={onRetry}
                      className="rounded bg-blue-700 px-3 py-1.5 text-xs font-semibold text-white hover:bg-blue-600"
                    >
                      Retry
                    </button>
                  )}
                  <button
                    type="button"
                    data-testid="session-route-browse"
                    onClick={onBrowse}
                    className="rounded border border-neutral-700 px-3 py-1.5 text-xs font-semibold text-neutral-200 hover:bg-neutral-800"
                  >
                    Browse sessions
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

interface HeaderBarProps {
  me: Me | null;
  meError: string;
  authEnabled: boolean;
  onLogout: () => Promise<void>;
  leftCollapsed: boolean;
  rightCollapsed: boolean;
  isMobile: boolean;
  onOpenSettings: () => void;
  humanAttentionCount: number;
  onOpenHumanAttention: () => void;
  onToggleLeft: () => void;
  onToggleRight: () => void;
}

function HeaderBar({
  me,
  meError,
  authEnabled,
  onLogout,
  leftCollapsed,
  rightCollapsed,
  isMobile,
  onOpenSettings,
  humanAttentionCount,
  onOpenHumanAttention,
  onToggleLeft,
  onToggleRight,
}: HeaderBarProps) {
  const username = me?.username ?? (meError ? "unknown" : "…");

  return (
    <header className="h-10 flex items-center justify-between px-4 border-b border-neutral-900 bg-neutral-950 shrink-0">
      <div className="flex items-center gap-2">
        <Columns3 size={16} className="text-neutral-400" />
        <span className="text-sm font-semibold tracking-wide text-neutral-100">
          Wayang
        </span>
        {!isMobile && (
          <div className="flex items-center gap-0.5 ml-2">
            <button
              onClick={onToggleLeft}
              title={
                leftCollapsed ? "Show sessions panel" : "Hide sessions panel"
              }
              className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
            >
              {leftCollapsed ? (
                <PanelLeftOpen size={14} />
              ) : (
                <PanelLeftClose size={14} />
              )}
            </button>
            <button
              onClick={onToggleRight}
              title={
                rightCollapsed ? "Show files panel" : "Hide files panel"
              }
              className="p-1 rounded text-neutral-500 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
            >
              {rightCollapsed ? (
                <PanelRightOpen size={14} />
              ) : (
                <PanelRightClose size={14} />
              )}
            </button>
          </div>
        )}
      </div>
      <div className="flex items-center gap-2">
        {humanAttentionCount > 0 && (
          <button
            type="button"
            data-testid="global-human-attention-badge"
            onClick={onOpenHumanAttention}
            aria-label={`${humanAttentionCount} pending human-input ${humanAttentionCount === 1 ? "request" : "requests"}. Open sessions.`}
            className="inline-flex items-center gap-1 rounded border border-amber-800/70 bg-amber-950/70 px-2 py-0.5 text-xs font-semibold text-amber-200 hover:bg-amber-900/70"
          >
            <BellRing size={12} aria-hidden="true" />
            {humanAttentionCount}
          </button>
        )}
        <button
          type="button"
          onClick={onOpenSettings}
          title="Workspace and capability settings"
          aria-label="Open workspace and capability settings"
          className="rounded p-1.5 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-100"
        >
          <SettingsIcon size={15} />
        </button>
        <Chip title={meError ? `Error: ${meError}` : undefined}>
          <span className="text-neutral-500">user:</span>{" "}
          <span className="text-neutral-200">{username}</span>
        </Chip>
        {authEnabled && (
          <button
            type="button"
            onClick={() => void onLogout()}
            title="Log out of Wayang"
            className="flex items-center gap-1 rounded border border-neutral-700 bg-neutral-900 px-2 py-0.5 text-xs font-medium text-neutral-300 hover:border-neutral-600 hover:bg-neutral-800 hover:text-neutral-100"
          >
            <LogOut size={12} />
            Log out
          </button>
        )}
        <Chip>
          <span className="text-neutral-500">agent:</span>{" "}
          <span className="text-green-400">pi</span>
        </Chip>
      </div>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Mobile
// ---------------------------------------------------------------------------

const MOBILE_TABS: {
  key: MobileTab;
  label: string;
  icon: typeof MessageSquare;
}[] = [
  { key: "sessions", label: "Sessions", icon: FolderOpen },
  { key: "chat", label: "Chat", icon: MessageSquare },
  { key: "tools", label: "Tools", icon: Terminal },
];

function MobileTabBar({
  activeTab,
  onTabChange,
}: {
  activeTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}) {
  return (
    <nav
      data-testid="mobile-tab-bar"
      className="flex items-center justify-around border-t border-neutral-800 bg-neutral-950 shrink-0"
      style={{
        minHeight: "calc(3.5rem + env(safe-area-inset-bottom))",
        paddingBottom: "env(safe-area-inset-bottom)",
      }}
    >
      {MOBILE_TABS.map(({ key, label, icon: Icon }) => {
        const active = activeTab === key;
        return (
          <button
            key={key}
            onClick={() => onTabChange(key)}
            className={`flex flex-col items-center gap-0.5 px-4 py-1 rounded transition-colors ${
              active
                ? "text-blue-400"
                : "text-neutral-500 hover:text-neutral-300"
            }`}
          >
            <Icon size={20} />
            <span className="text-[10px] font-medium">{label}</span>
          </button>
        );
      })}
    </nav>
  );
}

function Chip({
  children,
  title,
}: {
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className="rounded border border-neutral-800 bg-neutral-900 px-2 py-0.5 text-xs font-medium"
    >
      {children}
    </span>
  );
}

export default App;
