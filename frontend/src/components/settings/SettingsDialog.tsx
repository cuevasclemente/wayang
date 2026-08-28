import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Bell, Bot, FolderCog, Globe2, Loader2, Lock, Settings, X } from "lucide-react";
import {
  ApiError,
  fetchAgentProfiles,
  fetchModels,
  fetchProjects,
  type AgentProfileSummary,
  type ModelOption,
  type WorkspaceProject,
} from "../../api/client";
import { AgentProfilesSettings } from "./AgentProfilesSettings";
import { ProjectSettingsForm } from "./ProjectSettingsForm";
import { BrowserNotificationsSettings } from "./BrowserNotificationsSettings";
import { BrowserProfilesSettings } from "./BrowserProfilesSettings";

export type SettingsTab = "projects" | "agents" | "browser" | "notifications";

interface SettingsDialogProps {
  initialTab?: SettingsTab;
  initialProjectCwd?: string | null;
  onClose: () => void;
  onChanged?: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message || `HTTP ${error.status}` : String(error);
}

export function SettingsDialog({ initialTab = "projects", initialProjectCwd = null, onClose, onChanged }: SettingsDialogProps) {
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileSummary[]>([]);
  const [models, setModels] = useState<ModelOption[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const closeRef = useRef<HTMLButtonElement>(null);

  const refreshProfiles = useCallback(async () => {
    const value = await fetchAgentProfiles();
    setProfiles(value);
  }, []);

  const refreshProjects = useCallback(async () => {
    const value = await fetchProjects();
    setProjects(value);
    return value;
  }, []);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError("");
    // Project/Profile RBAC is independent of model discovery; models remain
    // ordinary runtime defaults rather than authority inputs.
    void Promise.all([fetchProjects(), fetchAgentProfiles()]).then(([projectRows, profileRows]) => {
      if (cancelled) return;
      setProjects(projectRows);
      setProfiles(profileRows);
      const preferred = initialProjectCwd
        ? projectRows.find((project) => project.cwd === initialProjectCwd)
        : null;
      setSelectedProjectId(preferred?.id ?? projectRows[0]?.id ?? null);
    }).catch((caught: unknown) => {
      if (!cancelled) setError(errorMessage(caught));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus());
    return () => {
      cancelled = true;
      window.cancelAnimationFrame(frame);
    };
  }, [initialProjectCwd]);

  useEffect(() => {
    let cancelled = false;
    void fetchModels().then((result) => {
      if (!cancelled) setModels(result.models);
    }).catch(() => {
      // Project/profile model selectors remain usable with their stored values
      // when provider discovery is offline.
      if (!cancelled) setModels([]);
    });
    return () => { cancelled = true; };
  }, []);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );

  const handleProjectSaved = (updated: WorkspaceProject) => {
    setProjects((current) => current.map((project) => project.id === updated.id ? updated : project));
    onChanged?.();
  };

  const handleProfilesChanged = async () => {
    await Promise.all([refreshProfiles(), refreshProjects()]);
    onChanged?.();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-2 sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workspace-settings-title"
      onClick={onClose}
      onKeyDown={(event) => { if (event.key === "Escape") onClose(); }}
    >
      <div className="flex h-[min(92dvh,900px)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-neutral-700 bg-neutral-950 shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <header className="flex shrink-0 items-center gap-3 border-b border-neutral-800 px-4 py-3 sm:px-5">
          <Settings size={18} className="text-neutral-400" />
          <div className="min-w-0 flex-1"><h2 id="workspace-settings-title" className="text-sm font-semibold text-neutral-100">Workspace settings</h2><p className="truncate text-xs text-neutral-500">Projects, agent profiles, Browser Profiles, and notification preferences</p></div>
          <button ref={closeRef} type="button" onClick={onClose} className="rounded p-2 text-neutral-400 hover:bg-neutral-800 hover:text-neutral-100" aria-label="Close settings"><X size={17} /></button>
        </header>

        <div className="flex shrink-0 overflow-x-auto border-b border-neutral-800 px-3 sm:px-5" role="tablist" aria-label="Settings sections">
          <TabButton active={tab === "projects"} onClick={() => setTab("projects")} icon={FolderCog}>Projects</TabButton>
          <TabButton active={tab === "agents"} onClick={() => setTab("agents")} icon={Bot}>Agents</TabButton>
          <TabButton active={tab === "browser"} onClick={() => setTab("browser")} icon={Globe2}>Browser Profiles</TabButton>
          <TabButton active={tab === "notifications"} onClick={() => setTab("notifications")} icon={Bell}>Notifications</TabButton>
        </div>

        {tab !== "notifications" && tab !== "browser" && loading ? (
          <div className="flex flex-1 items-center justify-center gap-2 text-sm text-neutral-500"><Loader2 size={16} className="animate-spin" /> Loading settings…</div>
        ) : tab !== "notifications" && tab !== "browser" && error ? (
          <div role="alert" className="m-5 rounded border border-red-900/60 bg-red-950/30 px-4 py-3 text-sm text-red-200">{error}</div>
        ) : tab === "projects" ? (
          <div className="flex min-h-0 flex-1 flex-col md:flex-row">
            <aside className="w-full shrink-0 border-b border-neutral-800 p-3 md:w-60 md:border-b-0 md:border-r md:p-4">
              <h3 className="mb-2 text-xs font-semibold uppercase tracking-wider text-neutral-500">Projects</h3>
              <div className="flex gap-2 overflow-x-auto md:block md:max-h-full md:space-y-1 md:overflow-y-auto">
                {projects.map((project) => (
                  <button
                    key={project.id}
                    type="button"
                    onClick={() => setSelectedProjectId(project.id)}
                    className={`min-w-48 rounded px-3 py-2 text-left md:block md:w-full ${project.id === selectedProjectId ? "bg-blue-950/60 text-blue-100" : "text-neutral-300 hover:bg-neutral-900"}`}
                  >
                    <div className="flex items-center gap-2"><span className="h-2.5 w-2.5 shrink-0 rounded-full border border-white/10" style={{ backgroundColor: project.color ?? "#525252" }} /><span className="min-w-0 flex-1 truncate text-sm font-medium">{project.name}</span>{project.access_policy.privacy_mode === "protected" && <Lock size={12} className="shrink-0 text-amber-400" />}</div>
                    <div className="mt-1 truncate font-mono text-[10px] text-neutral-600">{project.cwd}</div>
                  </button>
                ))}
                {projects.length === 0 && <p className="px-2 py-3 text-xs text-neutral-500">Projects appear after a folder is registered or its first session is created.</p>}
              </div>
            </aside>
            <main className="min-w-0 flex-1 overflow-y-auto p-4 sm:p-6">
              {selectedProject ? <ProjectSettingsForm project={selectedProject} profiles={profiles} models={models} onSaved={handleProjectSaved} /> : <p className="text-sm text-neutral-500">Select a project.</p>}
            </main>
          </div>
        ) : tab === "agents" ? (
          <main className="flex min-h-0 flex-1 p-4 sm:p-5">
            <AgentProfilesSettings profiles={profiles} models={models} onProfilesChanged={handleProfilesChanged} />
          </main>
        ) : tab === "browser" ? (
          <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <BrowserProfilesSettings onChanged={onChanged} />
          </main>
        ) : (
          <main className="min-h-0 flex-1 overflow-y-auto p-4 sm:p-6">
            <BrowserNotificationsSettings />
          </main>
        )}
      </div>
    </div>
  );
}

function TabButton({ active, onClick, icon: Icon, children }: { active: boolean; onClick: () => void; icon: typeof Bot; children: React.ReactNode }) {
  return <button type="button" role="tab" aria-selected={active} tabIndex={active ? 0 : -1} onClick={onClick} className={`inline-flex shrink-0 items-center gap-2 border-b-2 px-3 py-2.5 text-xs font-semibold ${active ? "border-blue-500 text-blue-300" : "border-transparent text-neutral-500 hover:text-neutral-200"}`}><Icon size={14} />{children}</button>;
}
