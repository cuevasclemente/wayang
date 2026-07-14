import { useCallback, useEffect, useMemo, useState } from "react";
import { ArrowLeft, Loader2, Play, Plus, Save, Trash2 } from "lucide-react";
import {
  ApiError,
  createScheduledAgentJob,
  deleteScheduledAgentJob,
  getScheduledAgentJob,
  listScheduledAgentJobs,
  runScheduledAgentJob,
  updateScheduledAgentJob,
  type ScheduledAgentCommandGuardMode,
  type ScheduledAgentJob,
  type ScheduledAgentJobInput,
  type ScheduledAgentRun,
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
      const list = await listScheduledAgentJobs();
      setJobs(list.jobs);
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
      setError(err instanceof ApiError ? `HTTP ${err.status}` : String(err));
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

  const submit = useCallback(async (e: React.FormEvent) => {
    e.preventDefault();
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
      setError(err instanceof ApiError ? `HTTP ${err.status}` : String(err));
    } finally {
      setSaving(false);
    }
  }, [form, selectedJobId, onSelectJob, onChanged, refresh]);

  const runNow = useCallback(async () => {
    if (!selectedJobId) return;
    setError("");
    try {
      await runScheduledAgentJob(selectedJobId);
      onChanged?.();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? `HTTP ${err.status}` : String(err));
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
      setError(err instanceof ApiError ? `HTTP ${err.status}` : String(err));
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
      setError(err instanceof ApiError ? `HTTP ${err.status}` : String(err));
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
                    <span>{selected.enabled ? "enabled" : "disabled"}</span>
                    <span>cwd: {selected.cwd}</span>
                  </div>
                </div>
                <div className="flex shrink-0 gap-2">
                  <button type="button" onClick={runNow} className="flex items-center gap-1 rounded bg-neutral-100 px-2 py-1 text-xs font-medium text-neutral-900 hover:bg-white"><Play size={13} /> Run now</button>
                  <button type="button" onClick={() => setEditing(true)} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800">Edit</button>
                  <button type="button" onClick={toggleEnabled} className="rounded border border-neutral-700 px-2 py-1 text-xs text-neutral-200 hover:bg-neutral-800">{selected.enabled ? "Disable" : "Enable"}</button>
                  <button type="button" onClick={remove} className="rounded border border-red-900/60 px-2 py-1 text-xs text-red-300 hover:bg-red-950/50"><Trash2 size={13} /></button>
                </div>
              </div>
              <div className="mt-4 grid gap-3 text-xs text-neutral-400 sm:grid-cols-3">
                <Info label="Next run" value={selected.next_run_at ? new Date(selected.next_run_at).toLocaleString() : "—"} />
                <Info label="Last run" value={selected.last_run_at ? formatRelativeTime(selected.last_run_at) : "never"} />
                <Info label="Timeout" value={`${Math.round(selected.timeout_ms / 60000)} min`} />
                <Info label="Command guard" value={commandGuardLabel(selected.command_guard_mode)} />
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
              {jobs.map((existing) => (
                <button key={existing.id} type="button" onClick={() => onSelectJob(existing.id)} className="w-full py-2 text-left hover:bg-neutral-900/80">
                  <div className="flex items-center justify-between gap-2 px-2">
                    <span className="text-sm text-neutral-200">{existing.name}</span>
                    <span className="text-[11px] text-neutral-500">{existing.next_run_at ? new Date(existing.next_run_at).toLocaleString() : "not scheduled"}</span>
                  </div>
                </button>
              ))}
            </div>
          </section>
        )}
      </div>
    </div>
  );
}

function JobForm({ form, saving, submitLabel, onChange, onSubmit, onCancel }: {
  form: JobFormState;
  saving: boolean;
  submitLabel: string;
  onChange: (next: JobFormState) => void;
  onSubmit: (e: React.FormEvent) => void;
  onCancel?: () => void;
}) {
  const set = (patch: Partial<JobFormState>) => onChange({ ...form, ...patch });
  return (
    <form onSubmit={onSubmit} className="rounded-lg border border-neutral-800 bg-neutral-900/50 p-4 space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Name" value={form.name} onChange={(name) => set({ name })} required />
        <Field label="Cron" value={form.cron_expr} onChange={(cron_expr) => set({ cron_expr })} required mono placeholder="*/30 * * * *" />
        <Field label="Project cwd" value={form.cwd} onChange={(cwd) => set({ cwd })} required mono placeholder="/home/you/project" />
        <Field label="Timeout minutes" value={form.timeout_minutes} onChange={(timeout_minutes) => set({ timeout_minutes })} required />
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
      <label className="block text-xs font-medium text-neutral-400">Prompt</label>
      <textarea className="h-40 w-full rounded border border-neutral-700 bg-neutral-950 px-3 py-2 text-sm text-neutral-100 placeholder-neutral-600 focus:border-neutral-500 focus:outline-none" value={form.prompt} onChange={(e) => set({ prompt: e.target.value })} required />
      <label className="flex items-center gap-2 text-sm text-neutral-300">
        <input type="checkbox" checked={form.enabled} onChange={(e) => set({ enabled: e.target.checked })} /> Enabled
      </label>
      <div className="flex gap-2">
        <button type="submit" disabled={saving} className="flex items-center gap-1 rounded bg-neutral-100 px-3 py-1.5 text-xs font-medium text-neutral-900 hover:bg-white disabled:opacity-50"><Save size={13} /> {saving ? "Saving…" : submitLabel}</button>
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
              {run.session_id && <button type="button" onClick={() => onOpenSession(run.session_id!)} className="mt-2 text-xs text-blue-300 hover:underline">Open linked session</button>}
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
    command_guard_mode: form.command_guard_mode,
    timeout_ms: Math.max(1, Number.isFinite(timeoutMinutes) ? timeoutMinutes : 10) * 60_000,
    enabled: form.enabled,
  };
}
