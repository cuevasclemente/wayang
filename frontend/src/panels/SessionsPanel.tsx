import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Archive,
  ChevronDown,
  CalendarClock,
  ChevronRight,
  ShieldCheck,
  Filter,
  Folder,
  FolderOpen,
  Loader2,
  Lock,
  Plus,
  Search,
  Settings,
  Square,
  Trash2,
  X,
  AlertCircle,
} from "lucide-react";
import {
  ApiError,
  archiveSession,
  canRetryAuthenticatedTransport,
  deleteSession,
  fetchProjects,
  listProtectedAutomations,
  listScheduledAgentJobs,
  listSessions,
  joinSessionsIntoProjects,
  searchSessions,
  stopSession,
  updateSessionTitle,
  type Project,
  type ProtectedAutomationCatalog,
  type ScheduledAgentJob,
  type Session,
  type SessionSearchFilters,
  type SessionSearchResponse,
  type SessionSearchResult,
  type WorkspaceProject,
} from "../api/client";
import { formatRelativeTime } from "../utils/time";
import { SessionResultSnippet } from "../components/SessionResultSnippet";

type LoadState = "loading" | "ready" | "error";

interface SessionsPanelProps {
  activeSessionId: string | null;
  active: boolean;
  activeProjectCwd: string | null;
  activeScheduledJobId?: string | null;
  activeProtectedAutomationJobId?: string | null;
  onSelect: (session: Session) => void;
  /**
   * Same as `onSelect`, but also passes the pi `message_id` we matched on so
   * the chat panel can scroll to that message. Used only for search-result
   * clicks; falls back to onSelect when this prop is undefined.
   */
  onSelectSearchResult?: (session: Session, messageId: string | null) => void;
  onSelectProject: (cwd: string) => void;
  onNewSessionForProject?: (cwd: string) => Promise<void> | void;
  onOpenProjectSettings?: (cwd: string) => void;
  onSelectScheduledJob?: (jobId: string | null) => void;
  onSelectProtectedAutomation?: (jobId: string | null) => void;
  onArchiveActive?: () => void;
  refreshTrigger?: number;
  onNewSession?: () => void;
}

const SEARCH_DEBOUNCE_MS = 250;
const MIN_SEARCH_LEN = 2;
const PROJECT_SHOW_SCHEDULED_RUNS_KEY = "wayang:projects:show-scheduled-runs";

function isScheduledRunSession(session: Pick<Session, "scheduled_job_id" | "scheduled_run_id">): boolean {
  return Boolean(session.scheduled_job_id || session.scheduled_run_id);
}

function readProjectShowScheduledRuns(): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(PROJECT_SHOW_SCHEDULED_RUNS_KEY) === "1";
  } catch {
    return false;
  }
}

function sessionListsEqual(a: Session[], b: Session[]): boolean {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index++) {
    const left = a[index];
    const right = b[index];
    if (
      left.id !== right.id || left.title !== right.title || left.cwd !== right.cwd
      || left.last_active !== right.last_active || left.archived !== right.archived
      || left.model !== right.model || left.provider !== right.provider
      || left.agent_profile_id !== right.agent_profile_id
      || left.pending_agent_switch?.switch_id !== right.pending_agent_switch?.switch_id
      || left.goal !== right.goal || left.goal_status !== right.goal_status
      || left.error !== right.error || left.runtime_status !== right.runtime_status
      || left.runtime_is_streaming !== right.runtime_is_streaming
      || left.runtime_subscriber_count !== right.runtime_subscriber_count
      || left.runtime_last_activity_at !== right.runtime_last_activity_at
      || left.bash_mode !== right.bash_mode
    ) return false;
  }
  return true;
}

function scheduledJobListsEqual(a: ScheduledAgentJob[], b: ScheduledAgentJob[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((job, index) => {
    const other = b[index];
    return job.id === other.id && job.updated_at === other.updated_at
      && job.last_run_at === other.last_run_at && job.next_run_at === other.next_run_at
      && job.enabled === other.enabled;
  });
}

type SearchState =
  | { kind: "idle" }
  | { kind: "loading"; query: string }
  | { kind: "ready"; query: string; response: SessionSearchResponse }
  | { kind: "error"; query: string; message: string };

export function SessionsPanel({
  activeSessionId,
  active,
  activeProjectCwd,
  activeScheduledJobId,
  activeProtectedAutomationJobId,
  onSelect,
  onSelectSearchResult,
  onSelectProject,
  onNewSessionForProject,
  onOpenProjectSettings,
  onSelectScheduledJob,
  onSelectProtectedAutomation,
  onArchiveActive,
  refreshTrigger,
  onNewSession,
}: SessionsPanelProps) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [durableProjects, setDurableProjects] = useState<WorkspaceProject[]>([]);
  const [scheduledJobs, setScheduledJobs] = useState<ScheduledAgentJob[]>([]);
  const [protectedAutomations, setProtectedAutomations] = useState<ProtectedAutomationCatalog>({
    status: { milestone: 0, activationAvailable: false, production_services: false },
    jobs: [],
  });
  const [protectedAutomationsLoading, setProtectedAutomationsLoading] = useState(true);
  const [protectedAutomationsUnavailable, setProtectedAutomationsUnavailable] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(
    new Set(),
  );
  const [creatingProjectCwd, setCreatingProjectCwd] = useState<string | null>(
    null,
  );

  // ----- Search state ----------------------------------------------------
  const [searchInput, setSearchInput] = useState("");
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterScope, setFilterScope] = useState<string>(""); // "" = All projects
  const [filterArchived, setFilterArchived] = useState(false);
  const [filterHasGoal, setFilterHasGoal] = useState<boolean | null>(null);
  const [filterHasError, setFilterHasError] = useState<boolean | null>(null);
  const [filterModel, setFilterModel] = useState<string>("");
  const [filterDateRange, setFilterDateRange] = useState<"all" | "7d" | "30d" | "90d">(
    "all",
  );
  const [showScheduledProjectRuns, setShowScheduledProjectRuns] = useState(
    readProjectShowScheduledRuns,
  );
  const [searchState, setSearchState] = useState<SearchState>({ kind: "idle" });
  const [pendingDeleteSession, setPendingDeleteSession] = useState<Session | null>(null);
  const [deletePin, setDeletePin] = useState("");
  const [deleteSubmitting, setDeleteSubmitting] = useState(false);
  const [deleteError, setDeleteError] = useState("");

  const projectListSessions = useMemo(
    () => (showScheduledProjectRuns ? sessions : sessions.filter((s) => !isScheduledRunSession(s))),
    [sessions, showScheduledProjectRuns],
  );
  const projects = useMemo(
    () => joinSessionsIntoProjects(projectListSessions, durableProjects),
    [durableProjects, projectListSessions],
  );
  const hiddenScheduledProjectRuns = sessions.length - projectListSessions.length;
  const hiddenScheduledRunsByCwd = useMemo(() => {
    const counts = new Map<string, number>();
    if (showScheduledProjectRuns) return counts;
    for (const session of sessions) {
      if (!isScheduledRunSession(session)) continue;
      const cwd = session.cwd.replace(/\/+$/, "") || "/";
      counts.set(cwd, (counts.get(cwd) ?? 0) + 1);
    }
    return counts;
  }, [sessions, showScheduledProjectRuns]);

  const refreshInFlightRef = useRef(false);
  const refreshPendingRef = useRef(false);
  const refreshAbortRef = useRef<AbortController | null>(null);
  const activeRef = useRef(active);
  activeRef.current = active;

  const refresh = useCallback(async () => {
    if (!activeRef.current || document.visibilityState === "hidden") {
      refreshPendingRef.current = true;
      return;
    }
    if (refreshInFlightRef.current) {
      refreshPendingRef.current = true;
      return;
    }
    refreshInFlightRef.current = true;
    try {
      do {
        refreshPendingRef.current = false;
        const controller = new AbortController();
        refreshAbortRef.current = controller;
        setLoadState((prev) => (prev === "ready" ? prev : "loading"));
        setErrorMsg("");
        try {
          const list = await listSessions(controller.signal);
          if (controller.signal.aborted) return;
          const normalized = Array.isArray(list) ? list : [];
          setSessions((previous) => sessionListsEqual(previous, normalized) ? previous : normalized);
          setLoadState("ready");
          // Project metadata is independent from the session catalog. A
          // transient settings failure must not blank session navigation.
          void fetchProjects().then((rows) => {
            if (!controller.signal.aborted) setDurableProjects(rows);
          }).catch(() => {});
        } catch (err) {
          if (controller.signal.aborted) return;
          setLoadState((prev) => (prev === "ready" ? prev : "error"));
          setErrorMsg(err instanceof ApiError ? `HTTP ${err.status}` : String(err));
        }
      } while (refreshPendingRef.current && activeRef.current);
    } finally {
      refreshAbortRef.current = null;
      refreshInFlightRef.current = false;
    }
  }, []);

  const jobsRefreshInFlightRef = useRef(false);
  const refreshJobs = useCallback(async () => {
    if (!activeRef.current || document.visibilityState === "hidden" || jobsRefreshInFlightRef.current) return;
    jobsRefreshInFlightRef.current = true;
    try {
      const result = await listScheduledAgentJobs();
      const normalized = Array.isArray(result.jobs) ? result.jobs : [];
      setScheduledJobs((previous) => scheduledJobListsEqual(previous, normalized) ? previous : normalized);
    } catch {
      // Scheduled jobs have independent best-effort state; session rows remain usable.
    } finally {
      jobsRefreshInFlightRef.current = false;
    }
  }, []);

  const automationsRefreshInFlightRef = useRef(false);
  const refreshProtectedAutomations = useCallback(async () => {
    if (!activeRef.current || document.visibilityState === "hidden" || automationsRefreshInFlightRef.current) return;
    automationsRefreshInFlightRef.current = true;
    try {
      setProtectedAutomations(await listProtectedAutomations());
      setProtectedAutomationsUnavailable(false);
    } catch {
      setProtectedAutomations((previous) => ({ ...previous, jobs: [] }));
      setProtectedAutomationsUnavailable(true);
    } finally {
      setProtectedAutomationsLoading(false);
      automationsRefreshInFlightRef.current = false;
    }
  }, []);

  useEffect(() => {
    if (active) {
      void refresh();
      void refreshJobs();
      void refreshProtectedAutomations();
    } else {
      refreshAbortRef.current?.abort();
    }
  }, [active, refresh, refreshJobs, refreshProtectedAutomations]);

  useEffect(() => {
    if (refreshTrigger !== undefined && refreshTrigger > 0) {
      refreshPendingRef.current = true;
      if (active) {
        void refresh();
        void refreshProtectedAutomations();
      }
    }
  }, [active, refreshTrigger, refresh, refreshProtectedAutomations]);

  useEffect(() => {
    if (typeof window === "undefined") return;
    try {
      window.localStorage.setItem(PROJECT_SHOW_SCHEDULED_RUNS_KEY, showScheduledProjectRuns ? "1" : "0");
    } catch {
      // Ignore private-mode/quota failures; the in-memory toggle still works.
    }
  }, [showScheduledProjectRuns]);

  useEffect(() => {
    const onVisibility = () => {
      if (active && document.visibilityState === "visible") {
        void refresh();
        void refreshJobs();
        void refreshProtectedAutomations();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    if (!active) return () => document.removeEventListener("visibilitychange", onVisibility);
    const events = new EventSource("/api/sessions/events");
    events.addEventListener("catalog_generation", () => {
      refreshPendingRef.current = true;
      if (document.visibilityState === "visible") void refresh();
    });
    events.onerror = () => {
      void canRetryAuthenticatedTransport().then((canRetry) => {
        if (!canRetry) events.close();
      });
    };
    const id = window.setInterval(() => {
      if (document.visibilityState === "visible") {
        void refresh();
        void refreshJobs();
        void refreshProtectedAutomations();
      }
    }, 60_000);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      events.close();
      window.clearInterval(id);
    };
  }, [active, refresh, refreshJobs, refreshProtectedAutomations]);

  // ----- Debounced server-side search -----------------------------------
  const searchSeqRef = useRef(0);
  const searchAbortRef = useRef<AbortController | null>(null);

  // Build the filter object that will be sent to the API.
  const activeFilters: SessionSearchFilters = useMemo(() => {
    const f: SessionSearchFilters = {
      cwd: filterScope || undefined,
      archived: filterArchived ? "any" : "false",
      model: filterModel || undefined,
      has_goal: filterHasGoal,
      has_error: filterHasError,
    };
    if (filterDateRange !== "all") {
      const days = filterDateRange === "7d" ? 7 : filterDateRange === "30d" ? 30 : 90;
      f.since = Date.now() - days * 24 * 60 * 60 * 1000;
    }
    return f;
  }, [filterScope, filterArchived, filterModel, filterHasGoal, filterHasError, filterDateRange]);

  const trimmedQuery = searchInput.trim();
  const searchActive = trimmedQuery.length >= MIN_SEARCH_LEN;

  useEffect(() => {
    if (!searchActive) {
      // Abort any in-flight request when query falls below the threshold.
      searchAbortRef.current?.abort();
      searchAbortRef.current = null;
      setSearchState({ kind: "idle" });
      return;
    }
    const seq = ++searchSeqRef.current;
    const handle = window.setTimeout(() => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      setSearchState({ kind: "loading", query: trimmedQuery });
      searchSessions(trimmedQuery, activeFilters, controller.signal)
        .then((response) => {
          if (seq !== searchSeqRef.current) return;
          setSearchState({ kind: "ready", query: trimmedQuery, response });
        })
        .catch((err) => {
          if (controller.signal.aborted) return;
          if (seq !== searchSeqRef.current) return;
          setSearchState({
            kind: "error",
            query: trimmedQuery,
            message: err instanceof ApiError ? `HTTP ${err.status}` : String(err),
          });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(handle);
  }, [searchActive, trimmedQuery, activeFilters]);

  // Distinct cwds + models for the filter dropdowns. Derived from the local
  // session list so they reflect what the user actually has.
  const filterChoices = useMemo(() => {
    const cwds = new Set<string>();
    const models = new Set<string>();
    for (const s of sessions) {
      cwds.add(s.cwd);
      if (s.model) models.add(s.model);
    }
    return {
      cwds: [...cwds].sort(),
      models: [...models].sort(),
    };
  }, [sessions]);

  const handleSelectSearchResult = useCallback(
    (result: SessionSearchResult) => {
      // Resolve a Session object to hand back. If the result isn't in the
      // local cache (e.g. archived sessions aren't loaded), synthesize a
      // minimal placeholder.
      const local = sessions.find((s) => s.id === result.session_id);
      const placeholder: Session = local ?? {
        id: result.session_id,
        pi_session_file: null,
        title: result.title,
        cwd: result.cwd,
        provider: null,
        model: result.model,
        agent_profile_id: null,
        pending_agent_switch: null,
        created_at: result.last_active,
        last_active: result.last_active,
        archived: result.archived ? 1 : 0,
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
      };
      if (onSelectSearchResult) {
        onSelectSearchResult(placeholder, result.best_message_id ?? null);
      } else {
        onSelect(placeholder);
      }
    },
    [onSelect, onSelectSearchResult, sessions],
  );

  const clearSearch = useCallback(() => {
    setSearchInput("");
    searchAbortRef.current?.abort();
    setSearchState({ kind: "idle" });
  }, []);

  // Auto-expand active project
  useEffect(() => {
    if (activeProjectCwd) {
      setExpandedProjects((prev) => {
        if (prev.has(activeProjectCwd)) return prev;
        const next = new Set(prev);
        next.add(activeProjectCwd);
        return next;
      });
    }
  }, [activeProjectCwd]);

  const toggleExpand = useCallback((cwd: string) => {
    setExpandedProjects((prev) => {
      const next = new Set(prev);
      if (next.has(cwd)) {
        next.delete(cwd);
      } else {
        next.add(cwd);
      }
      return next;
    });
  }, []);

  const handleCreateSessionForProject = useCallback(
    async (cwd: string) => {
      if (!onNewSessionForProject || creatingProjectCwd) return;
      setCreatingProjectCwd(cwd);
      try {
        await onNewSessionForProject(cwd);
      } catch (err) {
        window.alert(
          `Create session failed: ${err instanceof ApiError ? `HTTP ${err.status}` : String(err)}`,
        );
      } finally {
        setCreatingProjectCwd(null);
      }
    },
    [creatingProjectCwd, onNewSessionForProject],
  );

  const handleArchive = useCallback(
    async (id: string) => {
      if (!window.confirm("Archive this session?")) return;
      try {
        await archiveSession(id);
        setSessions((prev) => prev.filter((s) => s.id !== id));
        if (id === activeSessionId) {
          onArchiveActive?.();
        }
      } catch (err) {
        window.alert(
          `Archive failed: ${err instanceof ApiError ? `HTTP ${err.status}` : String(err)}`,
        );
      }
    },
    [activeSessionId, onArchiveActive],
  );

  const openDeleteDialog = useCallback((session: Session) => {
    setPendingDeleteSession(session);
    setDeletePin("");
    setDeleteError("");
  }, []);

  const closeDeleteDialog = useCallback(() => {
    if (deleteSubmitting) return;
    setPendingDeleteSession(null);
    setDeletePin("");
    setDeleteError("");
  }, [deleteSubmitting]);

  const submitDelete = useCallback(async () => {
    if (!pendingDeleteSession || deleteSubmitting) return;
    setDeleteSubmitting(true);
    setDeleteError("");
    try {
      await deleteSession(pendingDeleteSession.id, deletePin);
      setSessions((prev) => prev.filter((s) => s.id !== pendingDeleteSession.id));
      if (pendingDeleteSession.id === activeSessionId) {
        onArchiveActive?.();
      }
      setPendingDeleteSession(null);
      setDeletePin("");
    } catch (err) {
      if (err instanceof ApiError) {
        const body = err.body as { error?: unknown } | null;
        setDeleteError(typeof body?.error === "string" ? body.error : `HTTP ${err.status}`);
      } else {
        setDeleteError(String(err));
      }
    } finally {
      setDeleteSubmitting(false);
    }
  }, [activeSessionId, deletePin, deleteSubmitting, onArchiveActive, pendingDeleteSession]);

  const handleStop = useCallback(async (id: string) => {
    try {
      const stopped = await stopSession(id);
      setSessions((prev) => prev.map((s) => (s.id === id ? stopped : s)));
    } catch (err) {
      window.alert(
        `Stop failed: ${err instanceof ApiError ? `HTTP ${err.status}` : String(err)}`,
      );
    }
  }, []);

  const activeFilterCount =
    (filterScope ? 1 : 0) +
    (filterArchived ? 1 : 0) +
    (filterHasGoal != null ? 1 : 0) +
    (filterHasError != null ? 1 : 0) +
    (filterModel ? 1 : 0) +
    (filterDateRange !== "all" ? 1 : 0) +
    (showScheduledProjectRuns ? 1 : 0);

  return (
    <aside className="h-full flex flex-col bg-neutral-950">
      <header className="px-4 py-3 flex items-center justify-between border-b border-neutral-900">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-400">
          Projects
        </h2>
        <button
          type="button"
          onClick={() => onNewSession?.()}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-800 hover:text-neutral-100 transition-colors"
          title="New session"
        >
          <Plus size={14} />
          New
        </button>
      </header>

      <div role="search" className="border-b border-neutral-900 px-3 py-2">
        <div className="relative">
          <Search
            size={12}
            className="pointer-events-none absolute left-2 top-1/2 -translate-y-1/2 text-neutral-500"
          />
          <input
            type="search"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            placeholder="Search sessions…"
            aria-label="Search session history"
            data-testid="session-search-input"
            className="w-full rounded bg-neutral-900 border border-neutral-800 pl-7 pr-7 py-1.5 text-xs text-neutral-100 placeholder:text-neutral-500 focus:outline-none focus:border-blue-600"
          />
          {searchInput && (
            <button
              type="button"
              onClick={clearSearch}
              className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded p-0.5 text-neutral-500 hover:text-neutral-200"
              title="Clear search"
              aria-label="Clear search"
            >
              <X size={12} />
            </button>
          )}
        </div>
        <div className="mt-1.5 flex items-center justify-between">
          <button
            type="button"
            onClick={() => setFiltersOpen((v) => !v)}
            className="inline-flex items-center gap-1 rounded px-1 py-0.5 text-[10px] uppercase tracking-wider text-neutral-500 hover:text-neutral-200"
            aria-expanded={filtersOpen}
          >
            <Filter size={10} />
            Filters{activeFilterCount > 0 ? ` (${activeFilterCount})` : ""}
          </button>
          {searchState.kind === "ready" && (
            <span className="text-[10px] text-neutral-600">
              {searchState.response.results.length} result
              {searchState.response.results.length === 1 ? "" : "s"} ·
              {" "}
              {searchState.response.took_ms.toFixed(0)} ms
              {searchState.response.degraded === "indexing_in_progress" && (
                <span className="ml-1 text-amber-400" title="Initial backfill still running">
                  · indexing…
                </span>
              )}
            </span>
          )}
          {searchState.kind === "loading" && (
            <span className="inline-flex items-center gap-1 text-[10px] text-neutral-500">
              <Loader2 size={10} className="animate-spin" /> searching…
            </span>
          )}
        </div>
        {filtersOpen && (
          <div className="mt-2 space-y-1.5 rounded bg-neutral-900/60 border border-neutral-900 p-2">
            <FilterRow label="Project">
              <select
                value={filterScope}
                onChange={(e) => setFilterScope(e.target.value)}
                className="min-w-0 flex-1 rounded bg-neutral-950 border border-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200"
              >
                <option value="">All projects</option>
                {filterChoices.cwds.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </select>
            </FilterRow>
            <FilterRow label="Runs">
              <label className="flex min-w-0 flex-1 items-center gap-1.5 text-[11px] text-neutral-300">
                <input
                  type="checkbox"
                  checked={showScheduledProjectRuns}
                  onChange={(e) => setShowScheduledProjectRuns(e.target.checked)}
                  className="accent-blue-500"
                />
                <span className="truncate">Show scheduled runs in project lists</span>
                {!showScheduledProjectRuns && hiddenScheduledProjectRuns > 0 && (
                  <span className="shrink-0 text-neutral-600">({hiddenScheduledProjectRuns} hidden)</span>
                )}
              </label>
            </FilterRow>
            <FilterRow label="Date">
              <select
                value={filterDateRange}
                onChange={(e) =>
                  setFilterDateRange(e.target.value as "all" | "7d" | "30d" | "90d")
                }
                className="min-w-0 flex-1 rounded bg-neutral-950 border border-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200"
              >
                <option value="all">Any time</option>
                <option value="7d">Last 7 days</option>
                <option value="30d">Last 30 days</option>
                <option value="90d">Last 90 days</option>
              </select>
            </FilterRow>
            <FilterRow label="Model">
              <select
                value={filterModel}
                onChange={(e) => setFilterModel(e.target.value)}
                className="min-w-0 flex-1 rounded bg-neutral-950 border border-neutral-800 px-1 py-0.5 text-[11px] text-neutral-200"
              >
                <option value="">Any</option>
                {filterChoices.models.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </FilterRow>
            <div className="flex flex-wrap gap-x-3 gap-y-1 pt-0.5 text-[11px] text-neutral-300">
              <TriToggle
                label="Has goal"
                value={filterHasGoal}
                onChange={setFilterHasGoal}
              />
              <TriToggle
                label="Has error"
                value={filterHasError}
                onChange={setFilterHasError}
              />
              <label className="inline-flex items-center gap-1">
                <input
                  type="checkbox"
                  checked={filterArchived}
                  onChange={(e) => setFilterArchived(e.target.checked)}
                  className="accent-blue-500"
                />
                Include archived
              </label>
            </div>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-y-auto">
        <ScheduledJobsSection
          jobs={scheduledJobs}
          projects={durableProjects}
          activeJobId={activeScheduledJobId ?? null}
          onSelectJob={onSelectScheduledJob}
        />
        <ProtectedAutomationsSection
          catalog={protectedAutomations}
          loading={protectedAutomationsLoading}
          unavailable={protectedAutomationsUnavailable}
          activeJobId={activeProtectedAutomationJobId ?? null}
          onSelectJob={onSelectProtectedAutomation}
        />

        {loadState === "loading" && (
          <div className="p-4 text-sm text-neutral-500">Loading…</div>
        )}

        {loadState === "error" && (
          <div className="p-4 text-sm text-red-400">
            Failed to load sessions ({errorMsg}).{" "}
            <button
              type="button"
              onClick={() => void refresh()}
              className="underline hover:text-red-300"
            >
              Retry
            </button>
          </div>
        )}

        {!searchActive && loadState === "ready" && projects.length === 0 && (
          <div className="p-4 text-sm text-neutral-500">
            {!showScheduledProjectRuns && hiddenScheduledProjectRuns > 0 ? (
              <>
                Scheduled run sessions are hidden from project lists.
                <button
                  type="button"
                  onClick={() => setShowScheduledProjectRuns(true)}
                  className="ml-1 underline hover:text-neutral-300"
                >
                  Show {hiddenScheduledProjectRuns} scheduled run
                  {hiddenScheduledProjectRuns === 1 ? "" : "s"}
                </button>
                .
              </>
            ) : (
              <>No sessions yet. Click "New" to get started.</>
            )}
          </div>
        )}

        {searchActive && searchState.kind === "error" && (
          <div className="p-4 text-sm text-red-400">Search failed: {searchState.message}</div>
        )}

        {searchActive && searchState.kind === "ready" && (
          <SearchResultsList
            response={searchState.response}
            activeSessionId={activeSessionId}
            onSelect={handleSelectSearchResult}
          />
        )}

        {!searchActive && loadState === "ready" && projects.length > 0 && (
          <div className="py-1">
            {projects.map((project) => {
              const isActiveProject = project.cwd === activeProjectCwd;
              const isExpanded = expandedProjects.has(project.cwd);

              return (
                <div key={project.cwd}>
                  <ProjectHeader
                    project={project}
                    expanded={isExpanded}
                    active={isActiveProject}
                    creatingSession={creatingProjectCwd === project.cwd}
                    hiddenScheduledCount={hiddenScheduledRunsByCwd.get(project.cwd) ?? 0}
                    onShowScheduledRuns={() => setShowScheduledProjectRuns(true)}
                    onToggle={() => {
                      toggleExpand(project.cwd);
                      onSelectProject(project.cwd);
                    }}
                    onNewSession={
                      onNewSessionForProject
                        ? () => void handleCreateSessionForProject(project.cwd)
                        : undefined
                    }
                    onSettings={project.id && onOpenProjectSettings
                      ? () => onOpenProjectSettings(project.cwd)
                      : undefined}
                  />

                  {isExpanded &&
                    project.sessions.map((session) => (
                      <SessionRow
                        key={session.id}
                        session={session}
                        active={session.id === activeSessionId}
                        onSelect={onSelect}
                        onArchive={handleArchive}
                        onDelete={openDeleteDialog}
                        onStop={handleStop}
                        onTitleChanged={refresh}
                      />
                    ))}
                </div>
              );
            })}
          </div>
        )}
      </div>

      {pendingDeleteSession && (
        <DeleteSessionDialog
          session={pendingDeleteSession}
          pin={deletePin}
          error={deleteError}
          submitting={deleteSubmitting}
          onPinChange={setDeletePin}
          onCancel={closeDeleteDialog}
          onSubmit={submitDelete}
        />
      )}
    </aside>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function FilterRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-center gap-2">
      <span className="w-16 shrink-0 text-[10px] uppercase tracking-wider text-neutral-500">
        {label}
      </span>
      {children}
    </div>
  );
}

function TriToggle({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean | null;
  onChange: (v: boolean | null) => void;
}) {
  const next = value === null ? true : value === true ? false : null;
  const stateLabel = value === null ? "·" : value ? "yes" : "no";
  const stateClass =
    value === null
      ? "text-neutral-500"
      : value
        ? "text-emerald-400"
        : "text-amber-400";
  return (
    <button
      type="button"
      onClick={() => onChange(next)}
      className={"inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-neutral-800 " + stateClass}
      title={`Cycle ${label}: null → yes → no → null`}
    >
      {label}: <span className="font-medium">{stateLabel}</span>
    </button>
  );
}

function SearchResultsList({
  response,
  activeSessionId,
  onSelect,
}: {
  response: SessionSearchResponse;
  activeSessionId: string | null;
  onSelect: (result: SessionSearchResult) => void;
}) {
  if (response.results.length === 0) {
    const empty =
      response.degraded === "indexing_in_progress"
        ? "Indexing in progress… try again in a moment."
        : "No matches.";
    return <div className="p-4 text-sm text-neutral-500" data-testid="session-search-empty">{empty}</div>;
  }
  // Group by cwd for visual consistency with the default tree.
  const groups = new Map<string, SessionSearchResult[]>();
  for (const r of response.results) {
    const list = groups.get(r.cwd) ?? [];
    list.push(r);
    groups.set(r.cwd, list);
  }
  const ordered = [...groups.entries()].sort((a, b) => {
    const aLast = Math.max(...a[1].map((r) => r.last_active));
    const bLast = Math.max(...b[1].map((r) => r.last_active));
    return bLast - aLast;
  });
  return (
    <div className="py-1" data-testid="session-search-results">
      {ordered.map(([cwd, items]) => (
        <div key={cwd}>
          <div className="flex items-center gap-1.5 px-3 py-1 text-[10px] uppercase tracking-wider text-neutral-500">
            <Folder size={11} />
            <span className="truncate" title={cwd}>
              {cwd}
            </span>
          </div>
          {items.map((r) => (
            <SearchResultRow
              key={r.session_id + ":" + (r.best_message_id ?? "")}
              result={r}
              active={r.session_id === activeSessionId}
              onSelect={onSelect}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function SearchResultRow({
  result,
  active,
  onSelect,
}: {
  result: SessionSearchResult;
  active: boolean;
  onSelect: (result: SessionSearchResult) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(result)}
      data-testid="session-search-result"
      data-session-id={result.session_id}
      aria-current={active ? "page" : undefined}
      className={
        "group relative block w-full pl-8 pr-4 py-1.5 text-left transition-colors " +
        (active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-300 hover:bg-neutral-900")
      }
    >
      {active && (
        <div className="absolute left-2 top-2 w-1 h-4 rounded-full bg-blue-500" />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-xs font-medium" title={result.title}>
          {result.title || "(untitled)"}
        </span>
        <span className="shrink-0 text-[10px] text-neutral-600">
          {formatRelativeTime(result.last_active)}
        </span>
      </div>
      <SessionResultSnippet
        html={result.snippet_html}
        ariaLabel="matched excerpt"
        className="mt-0.5 line-clamp-2 text-[11px] leading-snug text-neutral-400 [&_mark]:bg-amber-900/60 [&_mark]:text-amber-100 [&_mark]:rounded-sm [&_mark]:px-0.5"
      />
      {(result.archived || result.best_role === "meta") && (
        <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-neutral-600">
          {result.archived && <span className="rounded bg-neutral-800 px-1 text-neutral-400">archived</span>}
          {result.best_role === "meta" && (
            <span className="rounded bg-neutral-800 px-1 text-neutral-400">metadata match</span>
          )}
        </div>
      )}
    </button>
  );
}

function ProtectedAutomationsSection({ catalog, loading, unavailable, activeJobId, onSelectJob }: {
  catalog: ProtectedAutomationCatalog;
  loading: boolean;
  unavailable: boolean;
  activeJobId: string | null;
  onSelectJob?: (jobId: string | null) => void;
}) {
  const jobs = Array.isArray(catalog.jobs) ? catalog.jobs : [];
  const productionAvailable = catalog.status?.production_services === true;
  const held = catalog.status?.activationAvailable === false;
  return (
    <section data-testid="protected-automations-navigation" className="border-b border-neutral-900 py-2">
      <button
        type="button"
        data-testid="protected-automations-open"
        onClick={() => onSelectJob?.(null)}
        className="flex w-full items-center justify-between gap-2 px-3 py-1 text-left hover:bg-neutral-900"
      >
        <span className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-violet-300">
          <ShieldCheck size={13} /> Protected Automations
        </span>
        <span className={`text-[10px] ${loading ? "text-neutral-600" : unavailable || held ? "text-amber-400" : "text-emerald-500"}`}>
          {loading ? "loading" : unavailable ? "unavailable" : held ? "held" : productionAvailable ? "available" : "unavailable"}
        </span>
      </button>
      {!loading && (unavailable || held) && (
        <button
          type="button"
          data-testid={unavailable ? "protected-automations-nav-unavailable" : "protected-automations-nav-held"}
          onClick={() => onSelectJob?.(null)}
          className="block w-full px-3 py-1.5 text-left text-xs leading-relaxed text-amber-300/70 hover:bg-neutral-900"
        >
          {unavailable ? "Production integration unavailable" : "Activation held · owner emergency controls only"}
        </button>
      )}
      {!loading && !unavailable && jobs.length === 0 && (
        <button type="button" onClick={() => onSelectJob?.(null)} className="block w-full px-3 py-1.5 text-left text-xs text-neutral-600 hover:bg-neutral-900 hover:text-neutral-400">
          No captured jobs
        </button>
      )}
      {!loading && !unavailable && jobs.length > 0 && (
        <div className="mt-1">
          {jobs.slice(0, 8).map((job) => (
            <button
              key={job.id}
              type="button"
              data-testid="protected-automation-nav-job"
              data-job-id={job.id}
              onClick={() => onSelectJob?.(job.id)}
              className={`block w-full px-3 py-1.5 text-left transition-colors ${job.id === activeJobId ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900"}`}
            >
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium">{job.name}</span>
                <span className={`shrink-0 text-[10px] ${job.attention ? "text-sky-300" : job.deleted_at !== null || job.blocked_reason ? "text-amber-400" : job.enabled ? "text-emerald-500" : "text-neutral-600"}`}>
                  {job.deleted_at !== null ? "tombstoned" : job.attention ? "attention" : job.blocked_reason === "paused" ? "paused" : job.blocked_reason ? "blocked" : job.enabled ? "enabled" : "paused"}
                </span>
              </div>
              <div className="truncate font-mono text-[10px] text-neutral-600">{job.cron_expr}</div>
            </button>
          ))}
          {jobs.length > 8 && <div className="px-3 py-1 text-[10px] text-neutral-600">+{jobs.length - 8} more</div>}
        </div>
      )}
    </section>
  );
}

function ScheduledJobsSection({ jobs, projects, activeJobId, onSelectJob }: {
  jobs: ScheduledAgentJob[];
  projects: WorkspaceProject[];
  activeJobId: string | null;
  onSelectJob?: (jobId: string | null) => void;
}) {
  const safeJobs = Array.isArray(jobs) ? jobs : [];
  return (
    <section className="border-b border-neutral-900 py-2">
      <div className="flex items-center justify-between px-3 py-1">
        <div className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-neutral-500">
          <CalendarClock size={13} /> Scheduled Jobs
        </div>
        <button
          type="button"
          onClick={() => onSelectJob?.(null)}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-neutral-200"
          title="New scheduled job"
        >
          <Plus size={13} />
        </button>
      </div>
      {safeJobs.length === 0 ? (
        <button
          type="button"
          onClick={() => onSelectJob?.(null)}
          className="block w-full px-3 py-1.5 text-left text-xs text-neutral-600 hover:bg-neutral-900 hover:text-neutral-400"
        >
          No jobs yet
        </button>
      ) : (
        <div className="mt-1">
          {safeJobs.slice(0, 8).map((job) => {
            const cwd = job.cwd.replace(/\/+$/, "") || "/";
            const blocked = projects.some((project) => (
              (project.cwd.replace(/\/+$/, "") || "/") === cwd
              && project.access_policy.privacy_mode === "protected"
            ));
            return (
              <button
                key={job.id}
                type="button"
                onClick={() => onSelectJob?.(job.id)}
                className={
                  "block w-full px-3 py-1.5 text-left transition-colors " +
                  (job.id === activeJobId ? "bg-neutral-800 text-neutral-100" : "text-neutral-300 hover:bg-neutral-900")
                }
                title={blocked ? "Retained job; cannot run while its project is Protected" : `${job.cron_expr} · ${job.cwd}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="truncate text-xs font-medium">{job.name}</span>
                  <span className={blocked ? "inline-flex items-center gap-0.5 text-[10px] text-amber-400" : job.enabled ? "text-[10px] text-emerald-500" : "text-[10px] text-neutral-600"}>
                    {blocked && <Lock size={9} />}{blocked ? "blocked" : job.enabled ? "on" : "off"}
                  </span>
                </div>
                <div className="truncate font-mono text-[10px] text-neutral-600">{job.cron_expr}</div>
              </button>
            );
          })}
          {safeJobs.length > 8 && <div className="px-3 py-1 text-[10px] text-neutral-600">+{safeJobs.length - 8} more</div>}
        </div>
      )}
    </section>
  );
}

interface ProjectHeaderProps {
  project: Project;
  expanded: boolean;
  active: boolean;
  creatingSession?: boolean;
  hiddenScheduledCount?: number;
  onShowScheduledRuns?: () => void;
  onToggle: () => void;
  onNewSession?: () => void;
  onSettings?: () => void;
}

function ProjectHeader({
  project,
  expanded,
  active,
  creatingSession = false,
  hiddenScheduledCount = 0,
  onShowScheduledRuns,
  onToggle,
  onNewSession,
  onSettings,
}: ProjectHeaderProps) {
  const Chevron = expanded ? ChevronDown : ChevronRight;
  const FolderIcon = expanded ? FolderOpen : Folder;

  return (
    <div
      className={
        "group flex items-center gap-1.5 px-3 py-2 cursor-pointer transition-colors " +
        (active
          ? "bg-neutral-900 text-neutral-100"
          : "text-neutral-300 hover:bg-neutral-900/60")
      }
      onClick={onToggle}
      title={project.cwd}
    >
      <Chevron size={12} className="shrink-0 text-neutral-500" />
      <span
        className="h-2 w-2 shrink-0 rounded-full border border-white/10"
        style={{ backgroundColor: project.color ?? "#525252" }}
        aria-hidden="true"
      />
      <FolderIcon size={14} className="shrink-0 text-neutral-400" />
      <div className="min-w-0 flex-1">
        <span className="flex items-center gap-1 truncate text-sm font-medium">
          <span className="truncate">{project.name}</span>
          {project.access_policy.privacy_mode === "protected" && (
            <Lock size={11} className="shrink-0 text-amber-400" aria-label="Protected project" />
          )}
        </span>
      </div>
      <span className="text-[10px] text-neutral-600 shrink-0">
        {formatRelativeTime(project.lastActive)}
      </span>
      {hiddenScheduledCount > 0 && onShowScheduledRuns && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onShowScheduledRuns();
          }}
          className="inline-flex shrink-0 items-center gap-0.5 rounded px-1 py-0.5 text-[10px] text-blue-300 opacity-80 hover:bg-blue-950/50 hover:text-blue-200 group-hover:opacity-100"
          title={`${hiddenScheduledCount} scheduled run${hiddenScheduledCount === 1 ? "" : "s"} hidden. Click to show scheduled runs in project lists.`}
          aria-label={`Show ${hiddenScheduledCount} hidden scheduled run${hiddenScheduledCount === 1 ? "" : "s"}`}
        >
          <CalendarClock size={10} />
          {hiddenScheduledCount}
        </button>
      )}
      {onSettings && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onSettings();
          }}
          className="rounded p-1 text-neutral-500 opacity-70 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-neutral-600 group-hover:opacity-100"
          title={`Settings for ${project.name}`}
          aria-label={`Settings for ${project.name}`}
        >
          <Settings size={13} />
        </button>
      )}
      {onNewSession && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onNewSession();
          }}
          disabled={creatingSession}
          className="rounded p-1 text-neutral-500 opacity-70 transition-colors hover:bg-neutral-800 hover:text-neutral-100 focus:opacity-100 focus:outline-none focus:ring-1 focus:ring-neutral-600 disabled:cursor-wait disabled:opacity-100 group-hover:opacity-100"
          title={`New session in ${project.name}`}
          aria-label={`New session in ${project.name}`}
        >
          {creatingSession ? (
            <Loader2 size={13} className="animate-spin" />
          ) : (
            <Plus size={13} />
          )}
        </button>
      )}
    </div>
  );
}

function DeleteSessionDialog({
  session,
  pin,
  error,
  submitting,
  onPinChange,
  onCancel,
  onSubmit,
}: {
  session: Session;
  pin: string;
  error: string;
  submitting: boolean;
  onPinChange: (pin: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}) {
  const title = session.title?.trim() || "(untitled)";
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="delete-session-title"
      onClick={onCancel}
    >
      <form
        className="w-full max-w-md rounded-lg border border-red-900/60 bg-neutral-950 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit();
        }}
      >
        <div className="border-b border-neutral-800 px-4 py-3">
          <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-red-400">
            Delete session
          </div>
          <h3 id="delete-session-title" className="text-sm font-semibold text-neutral-100">
            {title}
          </h3>
          <p className="mt-2 text-xs leading-relaxed text-neutral-400">
            This permanently deletes the pi transcript and removes the session from Wayang and search. Archiving does not require a PIN; deletion does.
          </p>
        </div>
        <div className="space-y-3 px-4 py-4">
          <label className="block text-xs text-neutral-300">
            Command guard identity PIN
            <input
              type="password"
              data-testid="delete-session-pin"
              inputMode="numeric"
              pattern="[0-9]{8}"
              maxLength={8}
              value={pin}
              onChange={(e) => onPinChange(e.target.value.replace(/\D/g, "").slice(0, 8))}
              className="mt-1 w-full rounded border border-neutral-700 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 focus:border-red-500 focus:outline-none"
              placeholder="8-digit PIN"
              autoComplete="off"
              autoFocus
            />
          </label>
          {error && <div className="rounded border border-red-900/60 bg-red-950/40 px-3 py-2 text-xs text-red-200">{error}</div>}
        </div>
        <div className="flex items-center justify-end gap-2 border-t border-neutral-800 px-4 py-3">
          <button
            type="button"
            onClick={onCancel}
            disabled={submitting}
            className="rounded px-3 py-2 text-xs text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100 disabled:opacity-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            data-testid="delete-session-confirm"
            disabled={submitting || pin.length !== 8}
            className="inline-flex items-center gap-2 rounded bg-red-700 px-3 py-2 text-xs font-semibold text-white hover:bg-red-600 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {submitting && <Loader2 size={12} className="animate-spin" />}
            Delete
          </button>
        </div>
      </form>
    </div>
  );
}

interface SessionRowProps {
  session: Session;
  active: boolean;
  onSelect: (session: Session) => void;
  onArchive: (id: string) => void;
  onDelete: (session: Session) => void;
  onStop: (id: string) => void;
  onTitleChanged: () => void;
}

function SessionRow({
  session,
  active,
  onSelect,
  onArchive,
  onDelete,
  onStop,
  onTitleChanged,
}: SessionRowProps) {
  const displayTitle =
    session.title && session.title.trim().length > 0
      ? session.title
      : "(untitled)";

  const [editing, setEditing] = useState(false);
  const [editValue, setEditValue] = useState(displayTitle);
  const inputRef = useRef<HTMLInputElement>(null);
  const isLive = session.runtime_status === "active" || session.runtime_status === "starting";
  const liveLabel = session.runtime_status === "starting"
    ? "starting"
    : session.runtime_is_streaming
      ? "running"
      : "active";

  const startEditing = (e: React.MouseEvent) => {
    e.stopPropagation();
    setEditValue(session.title || "");
    setEditing(true);
    setTimeout(() => inputRef.current?.select(), 0);
  };

  const commitEdit = async () => {
    setEditing(false);
    const newTitle = editValue.trim();
    if (newTitle === session.title) return;
    try {
      await updateSessionTitle(session.id, newTitle);
      onTitleChanged();
    } catch {
      // revert silently
    }
  };

  return (
    <div
      data-testid="session-row"
      data-session-id={session.id}
      aria-current={active ? "page" : undefined}
      className={
        "group relative flex items-start gap-2 pl-8 pr-4 py-1.5 cursor-pointer transition-colors " +
        (active
          ? "bg-neutral-800 text-neutral-100"
          : "text-neutral-300 hover:bg-neutral-900")
      }
      onClick={() => onSelect(session)}
    >
      {active && (
        <div className="absolute left-2 top-1/2 -translate-y-1/2 w-1 h-4 rounded-full bg-blue-500" />
      )}
      <div className="min-w-0 flex-1">
        {editing ? (
          <input
            ref={inputRef}
            className="w-full bg-neutral-900 border border-neutral-600 rounded px-1 py-0 text-xs text-neutral-100 focus:outline-none focus:border-blue-500"
            value={editValue}
            onChange={(e) => setEditValue(e.target.value)}
            onBlur={commitEdit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitEdit();
              if (e.key === "Escape") setEditing(false);
            }}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <div
            className="truncate text-xs font-medium"
            onDoubleClick={startEditing}
            title="Double-click to rename"
          >
            {displayTitle}
          </div>
        )}
        {session.error && (
          <div className="flex items-center gap-1 text-[10px] text-red-400" title={session.error}>
            <AlertCircle size={10} className="shrink-0" />
            <span className="truncate max-w-[100px]">{session.error}</span>
          </div>
        )}
        <div className="flex items-center gap-1.5 text-[10px] text-neutral-500">
          <span>{formatRelativeTime(session.last_active)}</span>
          {isLive && (
            <span
              className="inline-flex items-center gap-1 rounded bg-emerald-950/70 px-1 text-emerald-300"
              title="This session has an active in-memory pi AgentSession"
            >
              <span className="h-1.5 w-1.5 rounded-full bg-emerald-400" />
              {liveLabel}
            </span>
          )}
          {session.scheduled_job_id && (
            <span className="rounded bg-blue-950/70 px-1 text-blue-300">scheduled</span>
          )}
          {session.goal && (
            <span
              className={`truncate max-w-[120px] ${
                session.goal_status === "completed"
                  ? "text-green-500"
                  : session.goal_status === "in_progress"
                    ? "text-blue-400"
                    : "text-yellow-500"
              }`}
            >
              {session.goal.slice(0, 40)}
            </span>
          )}
        </div>
      </div>
      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {isLive && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onStop(session.id);
            }}
            className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-amber-300"
            title="Stop live session"
            aria-label="Stop live session"
          >
            <Square size={12} />
          </button>
        )}
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onArchive(session.id);
          }}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-blue-300"
          title="Archive session"
          aria-label="Archive session"
        >
          <Archive size={12} />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onDelete(session);
          }}
          className="rounded p-1 text-neutral-500 hover:bg-neutral-800 hover:text-red-400"
          title="Delete session"
          aria-label="Delete session"
        >
          <Trash2 size={12} />
        </button>
      </div>
    </div>
  );
}
