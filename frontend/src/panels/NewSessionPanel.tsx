import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Bot,
  Folder,
  FolderPlus,
  GitBranch,
  Loader2,
  Plus,
} from "lucide-react";
import {
  ApiError,
  createSession,
  fetchDiscoveredProjects,
  groupSessionsIntoProjects,
  listSessions,
  type DiscoveredProject,
  type Project,
  type Session,
} from "../api/client";

interface NewSessionPanelProps {
  onCreated: (session: Session) => void;
  onCancel: () => void;
}

type LoadState = "loading" | "ready" | "error";

export function NewSessionPanel({ onCreated, onCancel }: NewSessionPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredProject[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const [showNewProjectInput, setShowNewProjectInput] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectTitle, setNewProjectTitle] = useState("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const fetchProjects = useCallback(async () => {
    setLoadState("loading");
    setErrorMsg("");
    try {
      const [sessions, discoveredProjects] = await Promise.all([
        listSessions(),
        fetchDiscoveredProjects(),
      ]);
      const existingCwds = new Set(sessions.map((s) => s.cwd));
      // Filter discovered to only show dirs that don't already have sessions
      const newDiscoveries = discoveredProjects.filter(
        (d) => !existingCwds.has(d.cwd),
      );
      setDiscovered(newDiscoveries);
      setProjects(groupSessionsIntoProjects(sessions));
      setLoadState("ready");
    } catch (err) {
      setLoadState("error");
      setErrorMsg(
        err instanceof ApiError ? `HTTP ${err.status}` : String(err),
      );
    }
  }, []);

  useEffect(() => {
    void fetchProjects();
  }, [fetchProjects]);

  const handleCreateSession = useCallback(
    async (cwd: string, title?: string) => {
      setCreating(true);
      setCreateError("");
      try {
        const session = await createSession(cwd, title);
        onCreated(session);
      } catch (err) {
        setCreateError(
          err instanceof ApiError ? `HTTP ${err.status}` : String(err),
        );
      } finally {
        setCreating(false);
      }
    },
    [onCreated],
  );

  const handleNewProjectSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = newProjectPath.trim();
      if (!trimmed) return;
      await handleCreateSession(trimmed, newProjectTitle.trim() || undefined);
    },
    [newProjectPath, newProjectTitle, handleCreateSession],
  );

  const hasExistingProjects = projects.length > 0;
  const hasDiscovered = discovered.length > 0;

  return (
    <div className="h-full flex flex-col bg-neutral-950">
      {/* Header */}
      <header className="px-6 py-4 border-b border-neutral-900 flex items-center gap-3">
        <button
          type="button"
          onClick={onCancel}
          className="rounded p-1 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800 transition-colors"
          title="Go back"
        >
          <ArrowLeft size={18} />
        </button>
        <h1 className="text-lg font-semibold text-neutral-100">
          New Session
        </h1>
      </header>

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-6 py-6">
        {creating && (
          <div className="flex items-center gap-2 mb-4 text-sm text-neutral-400">
            <Loader2 size={16} className="animate-spin" />
            Creating session...
          </div>
        )}

        {createError && (
          <div className="mb-4 rounded border border-red-900 bg-red-950/50 px-4 py-2 text-sm text-red-400">
            {createError}
          </div>
        )}

        <p className="text-sm text-neutral-400 mb-6">
          Choose an existing project or create a new one. The session will use
          pi's AgentSession with structured chat.
        </p>

        {/* Loading state */}
        {loadState === "loading" && (
          <div className="flex items-center gap-2 text-sm text-neutral-500">
            <Loader2 size={16} className="animate-spin" />
            Loading projects...
          </div>
        )}

        {/* Error state */}
        {loadState === "error" && (
          <div className="text-sm text-red-400">
            Failed to load projects ({errorMsg}).{" "}
            <button
              type="button"
              onClick={() => void fetchProjects()}
              className="underline hover:text-red-300"
            >
              Retry
            </button>
          </div>
        )}

        {/* Project grid */}
        {loadState === "ready" && (
          <>
            {hasExistingProjects && (
              <>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-3">
                  Your Sessions
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
                  {projects.map((project) => (
                    <ProjectCard
                      key={project.cwd}
                      project={project}
                      disabled={creating}
                      onClick={() => void handleCreateSession(project.cwd)}
                    />
                  ))}
                </div>
              </>
            )}

            {hasDiscovered && (
              <>
                <h2 className="text-xs font-semibold uppercase tracking-wider text-neutral-500 mb-3">
                  Discovered Projects
                </h2>
                <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 mb-8">
                  {discovered.map((d) => (
                    <DiscoveredCard
                      key={d.cwd}
                      project={d}
                      disabled={creating}
                      onClick={() => void handleCreateSession(d.cwd)}
                    />
                  ))}
                </div>
              </>
            )}

            {/* New project card */}
            {showNewProjectInput ? (
              <form
                onSubmit={handleNewProjectSubmit}
                className="rounded-lg border border-neutral-700 bg-neutral-900/60 p-4 flex flex-col gap-3"
              >
                <label className="text-xs font-medium text-neutral-400">
                  Project folder path
                </label>
                <input
                  type="text"
                  value={newProjectPath}
                  onChange={(e) => setNewProjectPath(e.target.value)}
                  placeholder="/home/you/project"
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                  autoFocus
                  disabled={creating}
                />
                <label className="text-xs font-medium text-neutral-400">
                  Session title (optional)
                </label>
                <input
                  type="text"
                  value={newProjectTitle}
                  onChange={(e) => setNewProjectTitle(e.target.value)}
                  placeholder="e.g. Refactor auth module"
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                  disabled={creating}
                />
                <div className="flex gap-2">
                  <button
                    type="submit"
                    disabled={creating || !newProjectPath.trim()}
                    className="rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-50 transition-colors"
                  >
                    Create
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      setShowNewProjectInput(false);
                      setNewProjectPath("");
                      setNewProjectTitle("");
                    }}
                    disabled={creating}
                    className="rounded px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setShowNewProjectInput(true)}
                disabled={creating}
                className="rounded-lg border border-dashed border-neutral-700 bg-neutral-900/30 p-4 flex flex-col items-center justify-center gap-2 text-neutral-400 hover:text-neutral-200 hover:border-neutral-500 hover:bg-neutral-900/60 transition-colors disabled:opacity-50 min-h-[100px]"
              >
                <FolderPlus size={24} />
                <span className="text-sm font-medium">New project</span>
              </button>
            )}
          </>
        )}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

interface ProjectCardProps {
  project: Project;
  disabled: boolean;
  onClick: () => void;
}

function ProjectCard({ project, disabled, onClick }: ProjectCardProps) {
  const sessionCount = project.sessions.length;
  const sessionLabel =
    sessionCount === 1 ? "1 session" : `${sessionCount} sessions`;

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-left hover:border-neutral-600 hover:bg-neutral-900 transition-colors disabled:opacity-50 group"
    >
      <div className="flex items-start gap-3">
        <Folder
          size={20}
          className="shrink-0 text-neutral-500 group-hover:text-neutral-300 transition-colors mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-neutral-100 truncate">
            {project.name}
          </div>
          <div className="text-xs text-neutral-500 truncate mt-0.5">
            {project.cwd}
          </div>
          <div className="text-xs text-neutral-600 mt-1">{sessionLabel}</div>
        </div>
        <Plus
          size={16}
          className="shrink-0 text-neutral-600 group-hover:text-neutral-300 transition-colors mt-0.5"
        />
      </div>
    </button>
  );
}

interface DiscoveredCardProps {
  project: DiscoveredProject;
  disabled: boolean;
  onClick: () => void;
}

function DiscoveredCard({
  project,
  disabled,
  onClick,
}: DiscoveredCardProps) {
  const badges: string[] = [];
  if (project.hasPiSessions) badges.push("pi sessions");
  if (project.hasPiConfig) badges.push(".pi");
  if (project.hasGit) badges.push("git");
  if (project.hasPackageJson) badges.push("npm");

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-4 text-left hover:border-neutral-600 hover:bg-neutral-900 transition-colors disabled:opacity-50 group"
    >
      <div className="flex items-start gap-3">
        <Folder
          size={20}
          className="shrink-0 text-neutral-500 group-hover:text-neutral-300 transition-colors mt-0.5"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium text-neutral-100 truncate">
            {project.name}
          </div>
          <div className="text-xs text-neutral-500 truncate mt-0.5">
            {project.cwd}
          </div>
          <div className="flex items-center gap-1.5 mt-1.5 flex-wrap">
            {badges.map((b) => (
              <span
                key={b}
                className="text-[10px] px-1.5 py-0.5 rounded bg-neutral-800 text-neutral-400"
              >
                {b === "pi sessions" ? (
                  <span className="inline-flex items-center gap-1">
                    <Bot size={10} />
                    {b}
                  </span>
                ) : b === "git" ? (
                  <span className="inline-flex items-center gap-1">
                    <GitBranch size={10} />
                    {b}
                  </span>
                ) : (
                  b
                )}
              </span>
            ))}
          </div>
        </div>
        <Plus
          size={16}
          className="shrink-0 text-neutral-600 group-hover:text-neutral-300 transition-colors mt-0.5"
        />
      </div>
    </button>
  );
}
