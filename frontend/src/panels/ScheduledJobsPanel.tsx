import { useCallback, useEffect, useMemo, useState } from "react";
import { AlertTriangle, ArrowLeft, Loader2, Lock, Play, Plus, Save, Trash2 } from "lucide-react";
import {
  ApiError,
  createScheduledAgentJob,
  deleteScheduledAgentJob,
  fetchAgentProfiles,
  fetchProjects,
  getScheduledAgentJob,
  listScheduledAgentJobs,
  runScheduledAgentJob,
  updateScheduledAgentJob,
  type AgentProfileSummary,
  type ScheduledAgentCommandGuardMode,
  type ScheduledAgentJob,
  type ScheduledAgentJobInput,
  type ScheduledAgentRun,
  type WorkspaceProject,
} from "../api/client";
import { formatRelativeTime } from "../utils/time";

interface ScheduledJobsPanelProps {
  selectedJobId: string | null;
  onSelectJob: (jobId: string | null) => void;
  onOpenSession: (sessionId: string) => void;
  onChanged?: () => void;
  onClose?: () => void;
}

type LoadState = "loading" | "ready" | "error";

interface JobFormState {
  name: string;
  cron_expr: string;
  prompt: string;
  cwd: string;
  provider: string;
  model: string;
  agent_profile_id: string;
  timeout_minutes: string;
  command_guard_mode: ScheduledAgentCommandGuardMode;
  enabled: boolean;
}

const EMPTY_FORM: JobFormState = {
  name: "",
  cron_expr: "0 9 * * *",
  prompt: "",
  cwd: "",
  provider: "",
  model: "",
  agent_profile_id: "",
  timeout_minutes: "10",
  command_guard_mode: "default",
  enabled: true,
};

export function ScheduledJobsPanel({
  selectedJobId,
  onSelectJob,
  onOpenSession,
  onChanged,
  onClose,
}: ScheduledJobsPanelProps) {
  const [jobs, setJobs] = useState<ScheduledAgentJob[]>([]);
  const [projects, setProjects] = useState<WorkspaceProject[]>([]);
  const [profiles, setProfiles] = useState<AgentProfileSummary[]>([]);
  const [job, setJob] = useState<ScheduledAgentJob | null>(null);
  const [runs, setRuns] = useState<ScheduledAgentRun[]>([]);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [error, setError] = useState("");
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState<JobFormState>(EMPTY_FORM);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    setLoadState("loading");
    setError("");
    try {
      const [list, projectRows, profileRows] = await Promise.all([
        listScheduledAgentJobs(),
        fetchProjects(),
        fetchAgentProfiles(),
      ]);
      setJobs(list.jobs);
      setProjects(projectRows);
      setProfiles(profileRows.filter((profile) => profile.enabled));
      if (selectedJobId) {
        const detail = await getScheduledAgentJob(selectedJobId);
        setJob(detail.job);
        setRuns(detail.runs);
        setForm(formFromJob(detail.job));
      } else {
        setJob(null);
        setRuns([]);
        setForm(EMPTY_FORM);
      }
      setLoadState("ready");
    } catch (err) {
      setLoadState("error");
      setError(apiErrorMessage(err));
    }
  }, [selectedJobId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const id = window.setInterval(() => void refresh(), 15_000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const selected = useMemo(
    () => jobs.find((candidate) => candidate.id === selectedJobId) ?? job,
    [jobs, selectedJobId, job],
  );
  const selectedProject = useMemo(
    () => selected ? projectForCwd(projects, selected.cwd) : null,
    [projects, selected],
  );
  const selectedProtected = selectedProject?.access_policy.privacy_mode === "protected";
  const formProject = useMemo(
    () => projectForCwd(projects, form.cwd),
    [form.cwd, projects],
  );
  const formProtected = formProject?.access_policy.privacy_mode === "protected";

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
    if (formProtected && !form.agent_profile_id) {
      setError("Protected scheduled jobs require an explicit allowed agent.");
      return;
    }
    setSaving(true);
    setError("");
    try {
      const input = inputFromForm(form);
      const saved = selectedJobId
        ? await updateScheduledAgentJob(selectedJobId, input)
        : await createScheduledAgentJob(input);
      setEditing(false);
      onSelectJob(saved.id);
      onChanged?.();
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err));
    } finally {
      setSaving(false);
    }
  }, [form, formProtected, selectedJobId, onSelectJob, onChanged, refresh]);

  const runNow = useCallback(async () => {
    if (!selectedJobId) return;
    setError("");
    try {
      await runScheduledAgentJob(selectedJobId);
      onChanged?.();
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [selectedJobId, onChanged, refresh]);

  const remove = useCallback(async () => {
    if (!selectedJobId || !window.confirm("Delete this scheduled job? Run history rows will remain in storage.")) return;
    setError("");
    try {
      await deleteScheduledAgentJob(selectedJobId);
      onSelectJob(null);
      onChanged?.();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [selectedJobId, onSelectJob, onChanged]);

  const toggleEnabled = useCallback(async () => {
    if (!selected) return;
    setError("");
    try {
      await updateScheduledAgentJob(selected.id, { enabled: !selected.enabled });
      onChanged?.();
      await refresh();
    } catch (err) {
      setError(apiErrorMessage(err));
    }
  }, [selected, onChanged, refresh]);

  return (
    <div className="h-full flex flex-col bg-neutral-950">
      <header className="px-6 py-4 border-b border-neutral-900 flex items-center justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          {onClose && (
            <button type="button" onClick={onClose} className="rounded p-1 text-neutral-400 hover:text-neutral-100 hover:bg-neutral-800" title="Back to chat">
              <ArrowLeft size={18} />
            </button>
          )}
          <div className="min-w-0">
            <h1 className="text-lg font-semibold text-neutral-100">Scheduled Jobs</h1>
            <p className="text-xs text-neutral-500">First-class unattended pi agent jobs.</p>
          </div>
        </div>
        <button type="button" onClick={() => { onSelectJob(null); setEditing(true); }} className="flex items-center gap-1 rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800">
          <Plus size={14} /> New
        </button>
      </header>

      <div className="flex-1 overflow-y-auto p-6 space-y-4">
        {loadState === "loading" && <div className="flex items-center gap-2 text-sm text-neutral-500"><Loader2 size={16} className="animate-spin" /> Loading…</div>}
        {error && <div className="rounded border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">{error}</div>}

        {loadState === "error" && (
          <button type="button" onClick={() => void refresh()} className="text-sm text-neutral-300 underline">Retry</button>
        )}

        {loadState === "ready" && (!selectedJobId || editing) && (
          <JobForm
            form={form}
            saving={saving}
            projects={projects}
            profiles={profiles}
            project={formProject}
            protectedProject={formProtected}
            submitLabel={selectedJobId ? "Save changes" : "Create job"}
            onChange={setForm}
            onSubmit={submit}
            onCancel={selectedJobId ? () => setEditing(false) : undefined}
          />
        )}

        {loadState === "ready" && selected && !editing && (
          <>
            <section className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <h2 className="text-xl font-semibold text-neutral-100 truncate">{selected.name}</h2>
                  <div className="mt-1 flex flex-wrap gap-2 text-xs text-neutral-500">
                    <span className="font-mono">{selected.cron_expr}</span>
                    <span className={selectedProtected ? "text-blue-300" : undefined}>{selectedProtected ? `Protected · ${selected.enabled ? "enabled" : "disabled"}` : selected.enabled ? "enabled" : "disabled"}</span>
                    <span>cwd: {selected.cwd}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    onClick={runNow}
                    title={selectedProtected ? "Run now under Protected project policy" : "Run this job now"}
                    className="flex items-center gap-1 rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-40"
                  ><Play size={13} /> Run now</button>
                  <button type="button" onClick={() => setEditing(true)} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800">Edit</button>
                  <button type="button" onClick={toggleEnabled} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800">{selected.enabled ? "Disable" : "Enable"}</button>
                  <button type="button" onClick={remove} className="rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50"><Trash2 size={13} /></button>
                </div>
              </div>
              {selectedProtected && (
                <ProtectedScheduledNotice projectName={selectedProject?.name ?? selected.cwd} />
              )}
              <div className="mt-4 grid gap-3 text-xs text-neutral-400 sm:grid-cols-3">
                <Info label="Next run" value={selected.next_run_at ? new Date(selected.next_run_at).toLocaleString() : "—"} />
                <Info label="Last run" value={selected.last_run_at ? formatRelativeTime(selected.last_run_at) : "never"} />
                <Info label="Timeout" value={`${Math.round(selected.timeout_ms / 60000)} min`} />
                <Info label="Command guard" value={commandGuardLabel(selected.command_guard_mode)} />
                <Info label="Agent" value={scheduledAgentLabel(selected, selectedProject, profiles)} />
              </div>
              <pre className="mt-4 whitespace-pre-wrap rounded border border-neutral-800 bg-neutral-950/70 p-3 text-xs text-neutral-300">{selected.prompt}</pre>
            </section>
            <RunHistory runs={runs} onOpenSession={onOpenSession} />
          </>
        )}

        {loadState === "ready" && jobs.length > 0 && !selectedJobId && !editing && (
          <section className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
            <h2 className="text-sm font-semibold text-neutral-100">Existing jobs</h2>
            <div className="mt-3 divide-y divide-neutral-800">
              {jobs.map((existing) => {
                const existingProject = projectForCwd(projects, existing.cwd);
                const protectedProject = existingProject?.access_policy.privacy_mode === "protected";
                return (
                  <button key={existing.id} type="button" onClick={() => onSelectJob(existing.id)} className="w-full py-2 text-left hover:bg-neutral-900/80">
                    <div className="flex items-center justify-between gap-2 px-2">
                      <span className="flex min-w-0 items-center gap-2 text-sm text-neutral-200">
                        <span className="truncate">{existing.name}</span>
                        {protectedProject && <span className="inline-flex shrink-0 items-center gap-1 rounded bg-blue-950/50 px-1.5 py-0.5 text-[10px] font-medium text-blue-300"><Lock size={10} /> Protected</span>}
                      </span>
                      <span className="shrink-0 text-[11px] text-neutral-500">{existing.next_run_at ? new Date(existing.next_run_at).toLocaleString() : "not scheduled"}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function JobForm({ form, saving, projects, profiles, project, protectedProject, submitLabel, onChange, onSubmit, onCancel }: {
  form: JobFormState;
  saving: boolean;
  projects: WorkspaceProject[];
  profiles: AgentProfileSummary[];
  project: WorkspaceProject | null;
  protectedProject: boolean;
  submitLabel: string;
  onChange: (next: JobFormState) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel?: () => void;
}) {
  const set = (patch: Partial<JobFormState>) => onChange({ ...form, ...patch });
  const allowedProfiles = allowedScheduledProfiles(profiles, project);
  const defaultProfile = profiles.find((profile) => profile.id === project?.default_agent_profile_id) ?? null;
  const explicitProfileAvailable = !form.agent_profile_id || allowedProfiles.some((profile) => profile.id === form.agent_profile_id);
  const projectKnown = !form.cwd || Boolean(project);
  const chooseProject = (cwd: string) => {
    const nextProject = projectForCwd(projects, cwd);
    const nextAllowed = allowedScheduledProfiles(profiles, nextProject);
    const retainedProfile = form.agent_profile_id && nextAllowed.some((profile) => profile.id === form.agent_profile_id)
      ? form.agent_profile_id
      : "";
    set({
      cwd,
      agent_profile_id: retainedProfile || (nextProject?.access_policy.privacy_mode === "protected"
        ? nextProject.default_agent_profile_id
        : ""),
    });
  };
  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" value={form.name} onChange={(name) => set({ name })} required />
        <Field label="Cron" value={form.cron_expr} onChange={(cron_expr) => set({ cron_expr })} required mono placeholder="*/30 * * * *" />
        <label className="block">
          <span className="text-xs font-medium text-neutral-400">Project</span>
          <select className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 font-mono text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none" value={form.cwd} onChange={(event) => chooseProject(event.target.value)} required>
            <option value="">Select a durable project</option>
            {!projectKnown && <option value={form.cwd}>{form.cwd} — unavailable</option>}
            {projects.map((candidate) => <option key={candidate.id} value={candidate.cwd}>{candidate.name} — {candidate.cwd}{candidate.access_policy.privacy_mode === "protected" ? " (Protected)" : ""}</option>)}
          </select>
        </label>
        <Field label="Timeout minutes" value={form.timeout_minutes} onChange={(timeout_minutes) => set({ timeout_minutes })} required />
        <label className="block">
          <span className="text-xs font-medium text-neutral-400">Agent</span>
          <select className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none" value={form.agent_profile_id} onChange={(event) => set({ agent_profile_id: event.target.value })}>
            <option value="" disabled={protectedProject}>Project default{defaultProfile ? ` (${defaultProfile.name})` : ""}{protectedProject ? " — select explicitly for Protected scheduling" : ""}</option>
            {!explicitProfileAvailable && <option value={form.agent_profile_id}>Current agent — no longer enabled or allowed</option>}
            {allowedProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}</option>)}
          </select>
          <span className="mt-1 block text-[11px] leading-relaxed text-neutral-500">{protectedProject
            ? "Protected jobs persist one explicit allowed agent and reauthorize it immediately before each run."
            : "Only enabled profiles permitted by this project are shown. Project default is resolved again immediately before each run."}</span>
        </label>
        <Field label="Provider (optional)" value={form.provider} onChange={(provider) => set({ provider })} />
        <Field label="Model (optional)" value={form.model} onChange={(model) => set({ model })} />
        <SelectField
          label="Command guard"
          value={form.command_guard_mode}
          onChange={(command_guard_mode) => set({ command_guard_mode })}
          options={[
            { value: "default", label: "Default" },
            { value: "balanced", label: "On (balanced)" },
            { value: "off", label: "Off" },
            { value: "audit", label: "Audit (warn only)" },
            { value: "strict", label: "Strict" },
          ]}
        />
      </div>
      {protectedProject && <ProtectedScheduledNotice projectName={project?.name ?? form.cwd} />}
      {!projectKnown && form.cwd && (
        <div className="flex items-start gap-2 rounded border border-amber-900/60 bg-amber-950/20 px-3 py-2 text-xs leading-relaxed text-amber-100/85"><AlertTriangle size={14} className="mt-0.5 shrink-0" />This project path is not in the durable project registry. Select a registered project before saving.</div>
      )}
      <label className="block text-xs font-medium text-neutral-400">Prompt</label>
      <textarea className="h-40 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-neutral-500 focus:outline-none" value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} required />
      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={saving || !projectKnown} className="flex items-center gap-1 rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white disabled:cursor-not-allowed disabled:opacity-50"><Save size={13} /> {saving ? "Saving…" : submitLabel}</button>
        {onCancel && <button type="button" onClick={onCancel} className="rounded px-3 py-1.5 text-xs text-neutral-400 hover:text-neutral-200 hover:bg-neutral-800">Cancel</button>}
      </div>
    </form>
  );
}

function Field({ label, value, onChange, required, mono, placeholder }: { label: string; value: string; onChange: (value: string) => void; required?: boolean; mono?: boolean; placeholder?: string }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-400">{label}</span>
      <input className={`mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-neutral-500 focus:outline-none ${mono ? "font-mono" : ""}`} value={value} onChange={(e) => onChange(e.target.value)} required={required} placeholder={placeholder} />
    </label>
  );
}

function SelectField<T extends string>({ label, value, onChange, options }: { label: string; value: T; onChange: (value: T) => void; options: Array<{ value: T; label: string }> }) {
  return (
    <label className="block">
      <span className="text-xs font-medium text-neutral-400">{label}</span>
      <select className="mt-1 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 focus:border-neutral-500 focus:outline-none" value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
      </select>
    </label>
  );
}

function ProtectedScheduledNotice({ projectName }: { projectName: string }) {
  return (
    <div className="mt-4 flex items-start gap-2 rounded border border-blue-800/70 bg-blue-950/25 px-3 py-2.5 text-xs leading-relaxed text-blue-100/90">
      <Lock size={15} className="mt-0.5 shrink-0 text-blue-300" />
      <span>
        <strong className="font-semibold">Protected scheduled run.</strong>{" "}
        This job uses the exact allowed agent for {projectName || "this project"}. Writes remain project-confined, and assistant output is available only through the linked Protected session—not shared run summaries or global search.
      </span>
    </div>
  );
}

function RunHistory({ runs, onOpenSession }: { runs: ScheduledAgentRun[]; onOpenSession: (sessionId: string) => void }) {
  return (
    <section className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4">
      <h2 className="text-sm font-semibold text-neutral-100">Run history</h2>
      {runs.length === 0 ? <p className="mt-2 text-sm text-neutral-500">No runs yet.</p> : (
        <div className="mt-3 space-y-2">
          {runs.map((run) => (
            <div key={run.id} className="rounded border border-neutral-800 bg-neutral-950/60 p-3">
              <div className="flex items-center justify-between gap-2 text-xs">
                <span className={statusClass(run.status)}>{run.status}</span>
                <span className="text-neutral-500">{formatRelativeTime(run.started_at)} · {run.trigger}</span>
              </div>
              {run.result_summary && <p className="mt-2 text-xs text-neutral-300">{run.result_summary}</p>}
              {run.error_message && <p className="mt-2 text-xs text-red-300">{run.error_message}</p>}
              {run.session_id && <button type="button" data-testid="scheduled-run-open-session" data-session-id={run.session_id} onClick={() => onOpenSession(run.session_id!)} className="mt-2 text-xs text-blue-300 hover:underline">Open linked session</button>}
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return <div><div className="text-[11px] uppercase tracking-wide text-neutral-600">{label}</div><div className="mt-1 text-neutral-300">{value}</div></div>;
}

function commandGuardLabel(mode: ScheduledAgentCommandGuardMode | undefined): string {
  switch (mode) {
    case "off": return "off";
    case "balanced": return "on (balanced)";
    case "audit": return "audit";
    case "strict": return "strict";
    default: return "default";
  }
}

function normalizeCwd(cwd: string): string {
  return cwd.replace(/\/+$/, "") || "/";
}

function projectForCwd(projects: WorkspaceProject[], cwd: string): WorkspaceProject | null {
  if (!cwd) return null;
  const normalized = normalizeCwd(cwd);
  return projects.find((project) => normalizeCwd(project.cwd) === normalized) ?? null;
}

function allowedScheduledProfiles(
  profiles: AgentProfileSummary[],
  project: WorkspaceProject | null,
): AgentProfileSummary[] {
  const allowed = project?.access_policy.allowed_agent_profile_ids ?? null;
  return profiles.filter((profile) => profile.enabled && (!allowed || allowed.includes(profile.id)));
}

function scheduledAgentLabel(
  job: ScheduledAgentJob,
  project: WorkspaceProject | null,
  profiles: AgentProfileSummary[],
): string {
  const profileId = job.agent_profile_id ?? project?.default_agent_profile_id ?? null;
  const profile = profiles.find((candidate) => candidate.id === profileId);
  return job.agent_profile_id
    ? profile?.name ?? "Unavailable agent"
    : `Project default${profile ? ` (${profile.name})` : ""}`;
}

function apiErrorMessage(error: unknown): string {
  return error instanceof ApiError ? error.message || `HTTP ${error.status}` : String(error);
}

function statusClass(status: ScheduledAgentRun["status"]): string {
  switch (status) {
    case "completed": return "text-emerald-300";
    case "failed": return "text-red-300";
    case "running": return "text-blue-300";
    default: return "text-neutral-400";
  }
}

function formFromJob(job: ScheduledAgentJob): JobFormState {
  return {
    name: job.name,
    cron_expr: job.cron_expr,
    prompt: job.prompt,
    cwd: job.cwd,
    provider: job.provider ?? "",
    model: job.model ?? "",
    agent_profile_id: job.agent_profile_id ?? "",
    timeout_minutes: String(Math.max(1, Math.round(job.timeout_ms / 60000))),
    command_guard_mode: job.command_guard_mode ?? "default",
    enabled: job.enabled,
  };
}

function inputFromForm(form: JobFormState): ScheduledAgentJobInput {
  const timeoutMinutes = Number(form.timeout_minutes || 10);
  return {
    name: form.name.trim(),
    cron_expr: form.cron_expr.trim(),
    prompt: form.prompt,
    cwd: form.cwd.trim(),
    provider: form.provider.trim() || null,
    model: form.model.trim() || null,
    agent_profile_id: form.agent_profile_id || null,
    command_guard_mode: form.command_guard_mode,
    timeout_ms: Math.max(1, Number.isFinite(timeoutMinutes) ? timeoutMinutes : 10) * 60_000,
    enabled: form.enabled,
  };
}
