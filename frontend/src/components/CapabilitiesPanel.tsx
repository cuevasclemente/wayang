import { useEffect, useMemo, useState } from "react";
import {
  fetchCapabilities,
  fetchScheduledJobs,
  listScheduledAgentJobs,
  type Capability,
  type CapabilityCategory,
  type CapabilityStatus,
  type ScheduledAgentJob,
  type ScheduledJob,
} from "../api/client";

type View = "overview" | "agents" | "workflow" | "providers" | "security" | "automation" | "configuration";

interface CapabilitiesPanelProps {
  sessionCwd: string | null;
}

const VIEWS: { id: View; label: string }[] = [
  { id: "overview", label: "All" },
  { id: "agents", label: "Agents" },
  { id: "workflow", label: "Workflow" },
  { id: "providers", label: "Providers" },
  { id: "automation", label: "Schedules" },
  { id: "configuration", label: "Config" },
];

const STATUS_LABEL: Record<CapabilityStatus, string> = {
  available: "available",
  partial: "partial",
  planned: "planned",
  external: "external",
};

function statusClass(status: CapabilityStatus): string {
  switch (status) {
    case "available":
      return "border-emerald-500/30 bg-emerald-500/10 text-emerald-200";
    case "partial":
      return "border-amber-500/30 bg-amber-500/10 text-amber-200";
    case "external":
      return "border-sky-500/30 bg-sky-500/10 text-sky-200";
    default:
      return "border-neutral-700 bg-neutral-900 text-neutral-300";
  }
}

function categoryIcon(category: CapabilityCategory): string {
  switch (category) {
    case "agents":
      return "👥";
    case "workflow":
      return "✅";
    case "providers":
      return "🔑";
    case "security":
      return "🛡️";
    case "automation":
      return "⏱️";
    case "configuration":
      return "🧰";
  }
}

export function CapabilitiesPanel({ sessionCwd }: CapabilitiesPanelProps) {
  const [view, setView] = useState<View>("overview");
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [jobs, setJobs] = useState<ScheduledJob[]>([]);
  const [agentJobs, setAgentJobs] = useState<ScheduledAgentJob[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string>("");

  const refresh = () => {
    setLoading(true);
    setError("");
    Promise.all([
      fetchCapabilities(sessionCwd),
      fetchScheduledJobs(),
      listScheduledAgentJobs().catch(() => ({ jobs: [] as ScheduledAgentJob[] })),
    ])
      .then(([caps, scheduled, firstClassScheduled]) => {
        setCapabilities(caps.capabilities);
        setJobs(scheduled.jobs);
        setAgentJobs(firstClassScheduled.jobs);
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionCwd]);

  const visibleCaps = useMemo(() => {
    if (view === "overview") return capabilities;
    return capabilities.filter((c) => c.category === view);
  }, [capabilities, view]);

  return (
    <div className="h-full flex flex-col bg-neutral-950">
      <div className="border-b border-neutral-900 p-3">
        <div className="flex items-center justify-between gap-2">
          <div>
            <h2 className="text-sm font-semibold text-neutral-100">Pi capabilities</h2>
            <p className="text-xs text-neutral-500">Inspect core and optional pi integrations.</p>
          </div>
          <button
            type="button"
            onClick={refresh}
            disabled={loading}
            className="rounded border border-neutral-800 px-2 py-1 text-xs text-neutral-300 hover:bg-neutral-900 disabled:opacity-50"
          >
            {loading ? "…" : "refresh"}
          </button>
        </div>
        {sessionCwd && <div className="mt-2 truncate text-[11px] text-neutral-600">cwd: {sessionCwd}</div>}
      </div>

      <div className="flex gap-1 overflow-x-auto border-b border-neutral-900 px-2 py-2">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            type="button"
            onClick={() => setView(v.id)}
            className={
              "whitespace-nowrap rounded px-2 py-1 text-xs transition-colors " +
              (view === v.id ? "bg-neutral-800 text-neutral-100" : "text-neutral-500 hover:bg-neutral-900 hover:text-neutral-300")
            }
          >
            {v.label}
          </button>
        ))}
      </div>

      <div className="flex-1 overflow-y-auto p-3 space-y-3">
        {error && <div className="rounded border border-red-500/30 bg-red-500/10 p-2 text-xs text-red-200">{error}</div>}

        {(view === "overview" || view === "automation") && <FirstClassScheduledJobs jobs={agentJobs} />}

        {(view === "overview" || view === "automation") && <ScheduledJobs jobs={jobs} />}

        {visibleCaps.map((cap) => (
          <CapabilityCard key={cap.id} cap={cap} />
        ))}
      </div>
    </div>
  );
}

function FirstClassScheduledJobs({ jobs }: { jobs: ScheduledAgentJob[] }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-neutral-100">🤖 Pi scheduled agent jobs</div>
        <span className="text-[11px] text-neutral-500">{jobs.length} configured</span>
      </div>
      {jobs.length === 0 ? (
        <p className="mt-1 text-xs text-neutral-500">No first-class scheduled agent jobs configured yet.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {jobs.slice(0, 8).map((job) => (
            <div key={job.id} className="rounded border border-neutral-800 bg-neutral-950/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-neutral-200">{job.name}</span>
                <span className={job.enabled ? "shrink-0 text-[10px] uppercase text-emerald-400" : "shrink-0 text-[10px] uppercase text-neutral-500"}>{job.enabled ? "enabled" : "disabled"}</span>
              </div>
              <div className="mt-1 font-mono text-[11px] text-neutral-500">{job.cron_expr}</div>
              {job.next_run_at && <div className="mt-1 text-[11px] text-neutral-600">next: {new Date(job.next_run_at).toLocaleString()}</div>}
            </div>
          ))}
          {jobs.length > 8 && <div className="text-[11px] text-neutral-500">+{jobs.length - 8} more</div>}
        </div>
      )}
    </div>
  );
}

function ScheduledJobs({ jobs }: { jobs: ScheduledJob[] }) {
  return (
    <div className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="flex items-center justify-between">
        <div className="text-sm font-medium text-neutral-100">⏱️ External scheduled jobs</div>
        <span className="text-[11px] text-neutral-500">{jobs.length} detected</span>
      </div>
      {jobs.length === 0 ? (
        <p className="mt-1 text-xs text-neutral-500">No external systemd user timers or crontab entries were detected.</p>
      ) : (
        <div className="mt-2 space-y-2">
          {jobs.slice(0, 8).map((job) => (
            <div key={job.id} className="rounded border border-neutral-800 bg-neutral-950/60 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate text-xs font-medium text-neutral-200">{job.name}</span>
                <span className="shrink-0 rounded bg-neutral-800 px-1.5 py-0.5 text-[10px] uppercase text-neutral-400">{job.backend}</span>
              </div>
              <div className="mt-1 text-[11px] text-neutral-500">{job.schedule} · {job.status}</div>
              {job.command && <div className="mt-1 truncate font-mono text-[11px] text-neutral-400">{job.command}</div>}
            </div>
          ))}
          {jobs.length > 8 && <div className="text-[11px] text-neutral-500">+{jobs.length - 8} more</div>}
        </div>
      )}
    </div>
  );
}

function CapabilityCard({ cap }: { cap: Capability }) {
  return (
    <article className="rounded-lg border border-neutral-800 bg-neutral-900/60 p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-sm font-semibold text-neutral-100">
            <span className="mr-1">{categoryIcon(cap.category)}</span>
            {cap.title}
          </h3>
          <p className="mt-1 text-xs text-neutral-400">{cap.summary}</p>
        </div>
        <span className={"shrink-0 rounded-full border px-2 py-0.5 text-[10px] uppercase " + statusClass(cap.status)}>
          {STATUS_LABEL[cap.status]}
        </span>
      </div>

      <InfoList title="UI exposure" items={cap.ui} />
      {cap.tools && <PillList title="Tools" items={cap.tools} />}
      {cap.commands && <PillList title="Commands" items={cap.commands} />}
      {cap.paths && <PathList paths={cap.paths} />}
    </article>
  );
}

function InfoList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{title}</div>
      <ul className="mt-1 list-disc space-y-1 pl-4 text-xs text-neutral-400">
        {items.map((item) => <li key={item}>{item}</li>)}
      </ul>
    </div>
  );
}

function PillList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div className="mt-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">{title}</div>
      <div className="mt-1 flex flex-wrap gap-1">
        {items.map((item) => (
          <span key={item} className="rounded bg-neutral-950 px-1.5 py-0.5 font-mono text-[11px] text-neutral-300">{item}</span>
        ))}
      </div>
    </div>
  );
}

function PathList({ paths }: { paths: NonNullable<Capability["paths"]> }) {
  if (paths.length === 0) return null;
  return (
    <div className="mt-3 space-y-1">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">Detected paths</div>
      {paths.map((p) => (
        <div key={`${p.label}:${p.path}`} className="flex items-center gap-2 text-[11px]">
          <span className={p.exists ? "text-emerald-300" : "text-neutral-600"}>{p.exists ? "●" : "○"}</span>
          <span className="shrink-0 text-neutral-500">{p.label}</span>
          <span className="truncate font-mono text-neutral-400">{p.path}</span>
        </div>
      ))}
    </div>
  );
}
