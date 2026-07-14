import type { RegisteredApp } from "../../api/client";

interface AppLauncherProps {
  apps: RegisteredApp[];
  loading: boolean;
  error: string;
  sessionCwd: string | null;
  onRefresh: () => void;
  onLaunch: (app: RegisteredApp) => void;
  onStop: (app: RegisteredApp) => void;
  onRestart: (app: RegisteredApp) => void;
}

export function AppLauncher({ apps, loading, error, sessionCwd, onRefresh, onLaunch, onStop, onRestart }: AppLauncherProps) {
  const safeApps = Array.isArray(apps) ? apps : [];

  if (!sessionCwd) {
    return (
      <div className="h-full flex items-center justify-center text-sm font-mono text-neutral-600">
        Select a session to list project apps
      </div>
    );
  }

  return (
    <div className="h-full overflow-auto p-4">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h2 className="text-sm font-semibold text-neutral-100">Project Apps</h2>
          <p className="mt-1 max-w-xl text-xs text-neutral-500">
            Register project-local app manifests under <code className="text-neutral-400">.pi/apps/&lt;app-id&gt;/app.json</code>, then launch them in the right pane.
          </p>
          <p className="mt-1 truncate text-[11px] text-neutral-600">{sessionCwd}</p>
        </div>
        <button
          type="button"
          onClick={onRefresh}
          className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900"
        >
          {loading ? "Loading…" : "Reload registry"}
        </button>
      </div>

      {error && <div className="mb-3 rounded border border-red-900/60 bg-red-950/30 p-3 text-xs text-red-300">{error}</div>}

      {safeApps.length === 0 && !loading ? (
        <div className="rounded border border-dashed border-neutral-800 p-6 text-sm text-neutral-500">
          No apps registered for this project yet.
        </div>
      ) : (
        <div className="space-y-3">
          {safeApps.map((app) => (
            <AppCard key={app.id} app={app} onLaunch={onLaunch} onStop={onStop} onRestart={onRestart} />
          ))}
        </div>
      )}
    </div>
  );
}

function AppCard({ app, onLaunch, onStop, onRestart }: {
  app: RegisteredApp;
  onLaunch: (app: RegisteredApp) => void;
  onStop: (app: RegisteredApp) => void;
  onRestart: (app: RegisteredApp) => void;
}) {
  const statusClass =
    app.status === "running" ? "text-emerald-300" : app.status === "errored" ? "text-red-300" : app.status === "starting" ? "text-yellow-300" : "text-neutral-400";

  return (
    <article className="rounded border border-neutral-800 bg-neutral-950 p-4 shadow-sm shadow-black/20">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate text-sm font-semibold text-neutral-100">{app.manifest?.name || app.id}</h3>
            <span className={`text-[11px] font-mono ${statusClass}`}>{app.status}</span>
          </div>
          {app.manifest?.description && <p className="mt-1 text-xs text-neutral-400">{app.manifest.description}</p>}
          <div className="mt-2 space-y-0.5 text-[11px] text-neutral-600">
            <div>ID: <code>{app.id}</code></div>
            <div>Manifest: <code>{app.manifestPath}</code></div>
            <div>Command: <code>{app.manifest?.entry?.devCommand || "unknown"}</code></div>
            {app.url && <div>URL: <code>{app.url}</code></div>}
            {app.lastError && <div className="text-red-300">Error: {app.lastError}</div>}
          </div>
        </div>
        <div className="flex shrink-0 gap-2">
          <button type="button" onClick={() => onLaunch(app)} className="rounded bg-neutral-100 px-3 py-1.5 text-xs font-semibold text-neutral-950 hover:bg-white">
            {app.status === "running" ? "Open" : "Launch"}
          </button>
          <button type="button" onClick={() => onRestart(app)} className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900">
            Restart
          </button>
          <button type="button" onClick={() => onStop(app)} className="rounded border border-neutral-800 px-3 py-1.5 text-xs text-neutral-300 hover:bg-neutral-900">
            Stop
          </button>
        </div>
      </div>
    </article>
  );
}
