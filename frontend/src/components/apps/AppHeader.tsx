import { useMemo, useState } from "react";
import type { RegisteredApp } from "../../api/client";

interface AppHeaderProps {
  app: RegisteredApp;
  apps: RegisteredApp[];
  onBack: () => void;
  onSwitchApp: (app: RegisteredApp) => void;
  onReload: () => void;
  onRestart: () => void;
  onStop: () => void;
  onToggleFocus: () => void;
  focusMode?: boolean;
  busy?: boolean;
}

export function AppHeader({ app, apps, onBack, onSwitchApp, onReload, onRestart, onStop, onToggleFocus, focusMode = false, busy }: AppHeaderProps) {
  const [switcherOpen, setSwitcherOpen] = useState(false);
  const [query, setQuery] = useState("");
  const statusClass =
    app.status === "running"
      ? "bg-emerald-500"
      : app.status === "errored"
        ? "bg-red-500"
        : app.status === "starting"
          ? "bg-yellow-500"
          : "bg-neutral-500";

  const safeApps = useMemo(() => (Array.isArray(apps) ? apps : []), [apps]);

  const filteredApps = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return safeApps;
    return safeApps.filter((candidate) => {
      const haystack = [
        candidate.id,
        candidate.manifest?.name ?? candidate.id,
        candidate.manifest?.description ?? "",
        candidate.manifestPath,
      ].join(" ").toLowerCase();
      return haystack.includes(normalized);
    });
  }, [safeApps, query]);

  function switchTo(nextApp: RegisteredApp) {
    setSwitcherOpen(false);
    setQuery("");
    onSwitchApp(nextApp);
  }

  return (
    <div className="overflow-x-auto border-b border-neutral-900 bg-neutral-950 text-xs [-webkit-overflow-scrolling:touch]">
      <div className="flex min-w-max items-center gap-3 px-3 py-2">
      <button
        type="button"
        onClick={onBack}
        className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-900"
      >
        Apps
      </button>
      <div className="relative w-64 shrink-0 sm:max-w-[35%]">
        <button
          type="button"
          onClick={() => setSwitcherOpen((open) => !open)}
          className="flex w-full items-center gap-2 rounded border border-neutral-800 bg-neutral-950 px-2 py-1 text-left hover:bg-neutral-900"
          title="Switch app"
        >
          <div className={`h-2 w-2 shrink-0 rounded-full ${statusClass}`} title={app.status} />
          <div className="min-w-0 flex-1">
            <div className="truncate font-semibold text-neutral-100">{app.manifest?.name || app.id}</div>
            <div className="truncate text-[10px] text-neutral-600">{app.id}</div>
          </div>
          <span className="text-neutral-600">⌄</span>
        </button>
        {switcherOpen && (
          <div className="absolute left-0 right-0 top-full z-20 mt-1 rounded border border-neutral-800 bg-neutral-950 shadow-xl shadow-black/40">
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") setSwitcherOpen(false);
              }}
              placeholder="Search apps…"
              className="w-full border-b border-neutral-800 bg-neutral-900 px-2 py-2 text-xs text-neutral-100 outline-none placeholder:text-neutral-600"
            />
            <div className="max-h-64 overflow-auto py-1">
              {filteredApps.length === 0 ? (
                <div className="px-3 py-2 text-neutral-600">No matching apps</div>
              ) : (
                filteredApps.map((candidate) => (
                  <button
                    key={candidate.id}
                    type="button"
                    onClick={() => switchTo(candidate)}
                    className={
                      "flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-neutral-900 " +
                      (candidate.id === app.id ? "bg-neutral-900/70" : "")
                    }
                  >
                    <StatusDot status={candidate.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-neutral-200">{candidate.manifest?.name || candidate.id}</div>
                      <div className="truncate text-[10px] text-neutral-600">
                        {candidate.id} · {candidate.status}
                      </div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>
        )}
      </div>
      <div className="hidden min-w-24 flex-1 sm:block">
        <div className="truncate text-[11px] text-neutral-500">
          {app.status}
          {app.url ? ` · ${app.url}` : ""}
          {app.lastError ? ` · ${app.lastError}` : ""}
        </div>
      </div>
      <button type="button" onClick={onToggleFocus} className="shrink-0 rounded border border-sky-900/80 px-2 py-1 text-sky-200 hover:bg-sky-950/50 disabled:opacity-50" disabled={busy}>
        {focusMode ? "Exit focus" : "Focus app"}
      </button>
      <button type="button" onClick={onReload} className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-900 disabled:opacity-50" disabled={busy}>
        Reload iframe
      </button>
      <button type="button" onClick={onRestart} className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-900 disabled:opacity-50" disabled={busy}>
        Restart
      </button>
      <button type="button" onClick={onStop} className="shrink-0 rounded border border-neutral-800 px-2 py-1 text-neutral-300 hover:bg-neutral-900 disabled:opacity-50" disabled={busy}>
        Stop
      </button>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: RegisteredApp["status"] }) {
  const className =
    status === "running"
      ? "bg-emerald-500"
      : status === "errored"
        ? "bg-red-500"
        : status === "starting"
          ? "bg-yellow-500"
          : "bg-neutral-500";
  return <div className={`h-2 w-2 shrink-0 rounded-full ${className}`} title={status} />;
}
