import { useCallback, useEffect, useState } from "react";
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels";
import {
  Columns3,
  FolderOpen,
  LogOut,
  MessageSquare,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
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

type MobileTab = "sessions" | "chat" | "tools";

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
  const [sessionChangeTrigger, setSessionChangeTrigger] = useState(0);
  const [showNewSession, setShowNewSession] = useState(false);
  const [activeScheduledJobId, setActiveScheduledJobId] = useState<string | null>(null);
  const [showScheduledJobs, setShowScheduledJobs] = useState(false);

  const isMobile = useMediaQuery("(max-width: 768px)");
  const [mobileTab, setMobileTab] = useState<MobileTab>("chat");

  const handleSessionChange = useCallback(() => {
    setSessionChangeTrigger((n) => n + 1);
  }, []);

  const handleSelectSession = useCallback(
    (session: Session) => {
      setActiveSession(session);
      setActiveProjectCwd(session.cwd.replace(/\/+$/, "") || "/");
      setShowScheduledJobs(false);
      // Clear any prior scroll target when switching through the normal flow.
      setScrollToMessageId(null);
      if (isMobile) setMobileTab("chat");
    },
    [isMobile],
  );

  const handleSelectSearchResult = useCallback(
    (session: Session, messageId: string | null) => {
      // Navigate immediately with search-owned metadata. Runtime enrichment is
      // asynchronous and can only update the still-selected row.
      setActiveSession(session);
      setActiveProjectCwd(session.cwd.replace(/\/+$/, "") || "/");
      setShowScheduledJobs(false);
      setScrollToMessageId(messageId);
      if (isMobile) setMobileTab("chat");
      void getSession(session.id).then((resolved) => {
        setActiveSession((current) => current?.id === session.id ? resolved : current);
      }).catch(() => {});
    },
    [isMobile],
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
    },
    [handleSelectSession, handleSessionChange],
  );

  const leftPanelRef = usePanelRef();
  const rightPanelRef = usePanelRef();
  const [leftCollapsed, setLeftCollapsed] = useState(false);
  const [rightCollapsed, setRightCollapsed] = useState(false);

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
        created_at: Date.now(),
        last_active: Date.now(),
        archived: 0,
        goal: null,
        goal_status: null,
        scheduled_job_id: null,
        scheduled_run_id: null,
        error: null,
        runtime_status: "stopped",
        runtime_is_streaming: false,
        runtime_subscriber_count: 0,
        runtime_last_activity_at: null,
      };
      handleSelectSession(placeholder);
      void getSession(sessionId).then((session) => {
        setActiveSession((current) => {
          if (current?.id !== sessionId) return current;
          setActiveProjectCwd(session.cwd.replace(/\/+$/, "") || "/");
          return session;
        });
        handleSessionChange();
      }).catch(() => {});
    },
    [handleSelectSession, handleSessionChange],
  );

  const sessionsPanel = (
    <SessionsPanel
      activeSessionId={activeSessionId}
      active={!isMobile || mobileTab === "sessions"}
      activeProjectCwd={activeProjectCwd}
      activeScheduledJobId={showScheduledJobs ? activeScheduledJobId : null}
      onSelect={handleSelectSession}
      onSelectSearchResult={handleSelectSearchResult}
      onSelectProject={handleSelectProject}
      onNewSessionForProject={handleCreateSessionForProject}
      onSelectScheduledJob={handleSelectScheduledJob}
      onArchiveActive={() => setActiveSession(null)}
      refreshTrigger={sessionChangeTrigger}
      onNewSession={() => {
        setShowNewSession(true);
        setShowScheduledJobs(false);
        if (isMobile) setMobileTab("chat");
      }}
    />
  );

  const centerPanel = (
    <div className="relative h-full w-full overflow-hidden">
      {/* Keep ChatPanel mounted so its browser-level WebSocket survives local
          navigation between center-pane tools. Session changes still use the
          existing switch_session message instead of constructing a new socket. */}
      <div className={`h-full ${showNewSession || showScheduledJobs ? "hidden" : ""}`}>
        <ChatPanel
          activeSession={activeSession}
          onSessionChange={handleSessionChange}
          onSessionUpdate={setActiveSession}
          scrollToMessageId={scrollToMessageId}
          onScrollToMessageHandled={() => setScrollToMessageId(null)}
        />
      </div>
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
    </div>
  );

  const rightPanel = (
    <RightPanel
      sessionId={activeSessionId}
      sessionCwd={activeSession?.cwd ?? null}
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
              className={`absolute inset-0 ${mobileTab === "sessions" ? "" : "hidden"}`}
              aria-hidden={mobileTab !== "sessions"}
              inert={mobileTab !== "sessions"}
            >
              {sessionsPanel}
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
    </div>
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
