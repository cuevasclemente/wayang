import { useCallback, useEffect, useState } from "react";
import {
  ArrowLeft,
  Bot,
  ChevronDown,
  Folder,
  FolderPlus,
  GitBranch,
  Loader2,
  Lock,
  Plus,
  SlidersHorizontal,
} from "lucide-react";
import {
  ApiError,
  createProject as createWorkspaceProject,
  createSession,
  fetchAgentProfiles,
  fetchDiscoveredProjects,
  fetchModels,
  fetchProjects as fetchWorkspaceProjects,
  joinSessionsIntoProjects,
  listSessions,
  type AgentProfileSummary,
  type DiscoveredProject,
  type ModelOption,
  type Project,
  type Session,
  type WorkspaceProject,
} from "../api/client";

interface NewSessionPanelProps {
  onCreated: (session: Session) => void;
  onCancel: () => void;
}

type LoadState = "loading" | "ready" | "error";

export function NewSessionPanel({ onCreated, onCancel }: NewSessionPanelProps) {
  const [projects, setProjects] = useState<Project[]>([]);
  const [durableProjects, setDurableProjects] = useState<WorkspaceProject[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [discovered, setDiscovered] = useState<DiscoveredProject[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [errorMsg, setErrorMsg] = useState("");

  const [showNewProjectInput, setShowNewProjectInput] = useState(false);
  const [newProjectPath, setNewProjectPath] = useState("");
  const [newProjectName, setNewProjectName] = useState("");
  const [newProjectTitle, setNewProjectTitle] = useState("");
  const [advancedOpen, setAdvancedOpen] = useState(false);
  const [agentProfileId, setAgentProfileId] = useState("");
  const [modelSelection, setModelSelection] = useState("");

  const [creating, setCreating] = useState(false);
  const [createError, setCreateError] = useState("");

  const fetchProjects = useCallback(async () => {
    setLoadState("loading");
    setErrorMsg("");
    try {
      const [sessions, discoveredProjects, projectRows, profileRows, modelResult] = await Promise.all([
        listSessions(),
        fetchDiscoveredProjects(),
        fetchWorkspaceProjects(),
        fetchAgentProfiles(),
        fetchModels(),
      ]);
      const existingCwds = new Set([...sessions.map((session) => session.cwd), ...projectRows.map((project) => project.cwd)]);
      // Filter discovered to only show dirs that don't already have sessions
      const newDiscoveries = discoveredProjects.filter(
        (d) => !existingCwds.has(d.cwd),
      );
      setDiscovered(newDiscoveries);
      setDurableProjects(projectRows);
      setProfiles(profileRows.filter((profile) => profile.enabled));
      setModels(modelResult.models.filter((model) => model.available));
      setProjects(joinSessionsIntoProjects(sessions, projectRows));
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
        const project = durableProjects.find((candidate) => candidate.cwd === cwd);
        const allowed = project?.access_policy.allowed_agent_profile_ids;
        if (agentProfileId && allowed && !allowed.includes(agentProfileId)) {
          const profile = profiles.find((candidate) => candidate.id === agentProfileId);
          throw new Error(`${profile?.name ?? "The selected agent"} is not allowed for ${project?.name ?? cwd}.`);
        }
        let provider: string | undefined;
        let model: string | undefined;
        if (modelSelection) {
          const parsed = JSON.parse(modelSelection) as [string, string];
          [provider, model] = parsed;
        }
        const session = await createSession(cwd, title, model, provider, agentProfileId || undefined);
        onCreated(session);
      } catch (err) {
        setCreateError(
          err instanceof ApiError ? err.message || `HTTP ${err.status}` : String(err),
        );
      } finally {
        setCreating(false);
      }
    },
    [agentProfileId, durableProjects, modelSelection, onCreated, profiles],
  );

  const handleNewProjectSubmit = useCallback(
    async (e: React.FormEvent) => {
      e.preventDefault();
      const trimmed = newProjectPath.trim();
      if (!trimmed) return;
      setCreating(true);
      setCreateError("");
      try {
        await createWorkspaceProject({ cwd: trimmed, name: newProjectName.trim() || undefined });
      } catch (error) {
        // Canonical cwd uniqueness makes retries safe after a project was
        // created but its first session failed (or another tab registered it).
        if (!(error instanceof ApiError && error.status === 409)) {
          setCreateError(error instanceof ApiError ? error.message : String(error));
          setCreating(false);
          return;
        }
      }
      await handleCreateSession(trimmed, newProjectTitle.trim() || undefined);
    },
    [handleCreateSession, newProjectName, newProjectPath, newProjectTitle],
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

        <p className="text-sm text-neutral-400 mb-4">
          Choose a project to create a session with its defaults. Ordinary sessions remain one click.
        </p>

        <div className="mb-6 rounded-lg border border-neutral-800 bg-neutral-900/30">
          <button
            type="button"
            onClick={() => setAdvancedOpen((open) => !open)}
            aria-expanded={advancedOpen}
            className="flex w-full items-center gap-2 px-4 py-3 text-left text-sm font-medium text-neutral-300 hover:text-neutral-100"
          >
            <SlidersHorizontal size={15} />
            <span className="flex-1">Advanced</span>
            <span className="text-xs font-normal text-neutral-500">optional agent/model override</span>
            <ChevronDown size={14} className={`transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
          </button>
          {advancedOpen && (
            <div className="grid gap-4 border-t border-neutral-800 px-4 py-4 sm:grid-cols-2">
              <label className="space-y-1.5 text-xs font-medium text-neutral-300">
                <span className="block">Agent</span>
                <select value={agentProfileId} onChange={(event) => setAgentProfileId(event.target.value)} className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none">
                  <option value="">Project default</option>
                  {profiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name} — {profile.memory_access.replace("read_write", "read/write")}</option>)}
                </select>
                <span className="block font-normal leading-relaxed text-neutral-500">A project allowlist still applies. With no override, the project&apos;s default profile is used.</span>
              </label>
              <label className="space-y-1.5 text-xs font-medium text-neutral-300">
                <span className="block">Provider/model</span>
                <select value={modelSelection} onChange={(event) => setModelSelection(event.target.value)} className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-blue-600 focus:outline-none">
                  <option value="">Project / agent default</option>
                  {models.map((model) => <option key={`${model.provider}:${model.id}`} value={JSON.stringify([model.provider, model.id])}>{model.name || model.id} — {model.provider}</option>)}
                </select>
              </label>
            </div>
          )}
        </div>

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
                  Project name (optional)
                </label>
                <input
                  type="text"
                  value={newProjectName}
                  onChange={(e) => setNewProjectName(e.target.value)}
                  placeholder="Defaults to the folder name"
                  className="w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-neutral-500 focus:outline-none"
                  disabled={creating}
                />
                <label className="text-xs font-medium text-neutral-400">
                  First session title (optional)
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
                      setNewProjectName("");
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
          <div className="flex items-center gap-1.5 text-sm font-medium text-neutral-100">
            <span className="truncate">{project.name}</span>
            {project.access_policy.privacy_mode === "protected" && <Lock size={12} className="shrink-0 text-amber-400" aria-label="Protected project" />}
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
