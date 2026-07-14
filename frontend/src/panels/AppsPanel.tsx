import { useCallback, useEffect, useMemo, useState, type MouseEvent as ReactMouseEvent } from "react";
import {
  fetchAppEvents,
  fetchApps,
  postAppEvent,
  restartApp,
  startApp,
  stopApp,
  type AppEvent,
  type RegisteredApp,
} from "../api/client";
import { AppEventLog } from "../components/apps/AppEventLog";
import { AppFrame } from "../components/apps/AppFrame";
import { AppHeader } from "../components/apps/AppHeader";
import { AppLauncher } from "../components/apps/AppLauncher";

interface AppsPanelProps {
  sessionId: string | null;
  sessionCwd: string | null;
}

export function AppsPanel({ sessionId, sessionCwd }: AppsPanelProps) {
  const [apps, setApps] = useState<RegisteredApp[]>([]);
  const [activeAppId, setActiveAppId] = useState<string | null>(null);
  const [events, setEvents] = useState<AppEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [reloadToken, setReloadToken] = useState(0);
  const [eventLogHeight, setEventLogHeight] = useState(180);
  const [eventLogCollapsed, setEventLogCollapsed] = useState(false);
  const [focusMode, setFocusMode] = useState(false);

  const safeApps = useMemo(() => (Array.isArray(apps) ? apps : []), [apps]);

  const activeApp = useMemo(
    () => safeApps.find((app) => app.id === activeAppId) ?? null,
    [safeApps, activeAppId],
  );

  const refreshApps = useCallback(async (scan = true) => {
    if (!sessionId) {
      setApps([]);
      return;
    }
    setLoading(true);
    try {
      const nextApps = await fetchApps(sessionId, scan);
      setApps(Array.isArray(nextApps) ? nextApps : []);
      setError("");
      setActiveAppId((current) => (
        current && !nextApps.some((app) => app.id === current) ? null : current
      ));
    } catch (err: any) {
      setError(err?.message || String(err));
    } finally {
      setLoading(false);
    }
  }, [sessionId]);

  const refreshEvents = useCallback(async () => {
    if (!sessionId || !activeAppId) {
      setEvents([]);
      return;
    }
    try {
      setEvents(await fetchAppEvents(activeAppId, sessionId));
    } catch {
      // events are auxiliary; keep the app usable
    }
  }, [activeAppId, sessionId]);

  useEffect(() => {
    setActiveAppId(null);
    setEvents([]);
    refreshApps(true);
  }, [sessionId, sessionCwd, refreshApps]);

  useEffect(() => {
    refreshEvents();
    if (!activeAppId) return;
    const timer = window.setInterval(refreshEvents, 2500);
    return () => window.clearInterval(timer);
  }, [activeAppId, refreshEvents]);

  async function runAction(action: () => Promise<RegisteredApp>, open = false) {
    setBusy(true);
    try {
      const updated = await action();
      setApps((current) => upsertApp(current, updated));
      setError("");
      if (open) setActiveAppId(updated.id);
      return updated;
    } catch (err: any) {
      setError(err?.message || String(err));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function launch(app: RegisteredApp) {
    if (!sessionId) return;
    if (app.status === "running" && app.url) {
      setActiveAppId(app.id);
      return;
    }
    await runAction(() => startApp(app.id, sessionId), true);
  }

  async function stop(app: RegisteredApp) {
    if (!sessionId) return;
    await runAction(() => stopApp(app.id, sessionId));
    if (activeAppId === app.id) setActiveAppId(null);
  }

  async function restart(app: RegisteredApp) {
    if (!sessionId) return;
    await runAction(() => restartApp(app.id, sessionId), activeAppId === app.id);
  }

  async function forwardEvent(event: AppEvent) {
    if (!sessionId) return;
    try {
      await postAppEvent(event.appId, sessionId, {
        event: event.event,
        payload: event.payload,
        summary: event.summary || `Forwarded app event: ${event.event}`,
        sendToAgent: true,
      });
      refreshEvents();
    } catch (err: any) {
      setError(err?.message || String(err));
    }
  }

  function startEventLogResize(event: ReactMouseEvent<HTMLDivElement>) {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = eventLogHeight;
    const onMove = (moveEvent: MouseEvent) => {
      const nextHeight = Math.max(32, Math.min(Math.max(420, window.innerHeight - 160), startHeight + startY - moveEvent.clientY));
      setEventLogCollapsed(false);
      setEventLogHeight(nextHeight);
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    document.body.style.cursor = "row-resize";
    document.body.style.userSelect = "none";
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }

  if (!activeApp) {
    return (
      <AppLauncher
        apps={safeApps}
        loading={loading}
        error={error}
        sessionCwd={sessionCwd}
        onRefresh={() => refreshApps(true)}
        onLaunch={launch}
        onStop={stop}
        onRestart={restart}
      />
    );
  }

  return (
    <div className={focusMode ? "fixed inset-0 z-50 flex min-h-0 flex-col bg-neutral-950" : "flex h-full min-h-0 flex-col"}>
      <AppHeader
        app={activeApp}
        apps={safeApps}
        busy={busy}
        onBack={() => setActiveAppId(null)}
        onSwitchApp={launch}
        onReload={() => setReloadToken((n) => n + 1)}
        onRestart={() => restart(activeApp)}
        onStop={() => stop(activeApp)}
        onToggleFocus={() => setFocusMode((value) => !value)}
        focusMode={focusMode}
      />
      {error && <div className="border-b border-red-900/60 bg-red-950/30 px-3 py-2 text-xs text-red-300">{error}</div>}
      {sessionId && (
        <div className="min-h-0 flex-1">
          <AppFrame app={activeApp} sessionId={sessionId} onEvent={refreshEvents} reloadToken={reloadToken} chromeHidden={focusMode} />
        </div>
      )}
      {!focusMode && (
        <AppEventLog
          events={events}
          height={eventLogHeight}
          collapsed={eventLogCollapsed}
          onResizeStart={startEventLogResize}
          onToggleCollapsed={() => setEventLogCollapsed((value) => !value)}
          onForward={forwardEvent}
        />
      )}
    </div>
  );
}

function upsertApp(apps: RegisteredApp[], next: RegisteredApp): RegisteredApp[] {
  const current = Array.isArray(apps) ? apps : [];
  const found = current.some((app) => app.id === next.id);
  if (!found) return [...current, next].sort((a, b) => appName(a).localeCompare(appName(b)));
  return current.map((app) => (app.id === next.id ? next : app));
}

function appName(app: RegisteredApp): string {
  return app.manifest?.name || app.id;
}
