import { Bell, BellOff, CircleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import {
  disableBrowserNotifications,
  enableBrowserNotifications,
  getBrowserNotificationState,
  type BrowserNotificationState,
} from "../../browserNotifications";

export function BrowserNotificationsSettings() {
  const [state, setState] = useState<BrowserNotificationState>(getBrowserNotificationState);
  const [requesting, setRequesting] = useState(false);

  useEffect(() => {
    const refreshPermissionState = () => setState(getBrowserNotificationState());
    window.addEventListener("focus", refreshPermissionState);
    document.addEventListener("visibilitychange", refreshPermissionState);
    return () => {
      window.removeEventListener("focus", refreshPermissionState);
      document.removeEventListener("visibilitychange", refreshPermissionState);
    };
  }, []);

  const enable = async () => {
    setRequesting(true);
    setState(await enableBrowserNotifications());
    setRequesting(false);
  };

  const granted = state.kind === "granted";
  const unavailable = state.kind === "unsupported" || state.kind === "denied";

  return (
    <section className="w-full max-w-2xl" aria-labelledby="browser-notifications-title">
      <div className="mb-5">
        <h3 id="browser-notifications-title" className="text-base font-semibold text-neutral-100">
          Human-input notifications
        </h3>
        <p className="mt-1 text-sm leading-relaxed text-neutral-400">
          Browser notifications are optional. In-app human-input badges remain available in every state.
        </p>
      </div>

      <div className="rounded-lg border border-neutral-800 bg-neutral-900/40 p-4">
        <div className="flex items-start gap-3">
          {granted
            ? <Bell size={20} className="mt-0.5 shrink-0 text-emerald-400" />
            : unavailable
              ? <BellOff size={20} className="mt-0.5 shrink-0 text-amber-400" />
              : <Bell size={20} className="mt-0.5 shrink-0 text-neutral-400" />}
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div>
                <p className="text-sm font-medium text-neutral-100">Browser notifications</p>
                <NotificationStatus state={state} />
              </div>
              {granted ? (
                <button
                  type="button"
                  onClick={() => setState(disableBrowserNotifications())}
                  className="rounded border border-neutral-700 px-3 py-2 text-xs font-semibold text-neutral-200 hover:bg-neutral-800"
                >
                  Turn off
                </button>
              ) : state.kind === "off" ? (
                <button
                  type="button"
                  data-testid="enable-browser-notifications"
                  onClick={() => void enable()}
                  disabled={requesting}
                  className="rounded bg-blue-700 px-3 py-2 text-xs font-semibold text-white hover:bg-blue-600 disabled:cursor-wait disabled:opacity-60"
                >
                  {requesting ? "Requesting…" : "Enable browser notifications"}
                </button>
              ) : null}
            </div>

            <div className="mt-4 rounded border border-neutral-800 bg-neutral-950/60 px-3 py-2 text-xs leading-relaxed text-neutral-400">
              Notifications say only <strong className="font-medium text-neutral-200">Wayang needs your input</strong>
              {" "}and <strong className="font-medium text-neutral-200">Question waiting in Wayang</strong>.
              They never include session titles, project names, question text, answers, tool arguments,
              file paths, or transcript content.
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}

function NotificationStatus({ state }: { state: BrowserNotificationState }) {
  if (state.kind === "granted") {
    return <p role="status" data-testid="browser-notification-state" className="mt-1 text-xs text-emerald-400">Granted and on</p>;
  }
  if (state.kind === "unsupported") {
    return <p role="status" data-testid="browser-notification-state" className="mt-1 text-xs text-amber-400">Unsupported by this browser</p>;
  }
  if (state.kind === "denied") {
    return <p role="status" data-testid="browser-notification-state" className="mt-1 text-xs text-amber-400">Denied in browser settings. In-app badges still work.</p>;
  }
  if (state.kind === "error") {
    return (
      <p role="alert" data-testid="browser-notification-state" className="mt-1 inline-flex items-center gap-1 text-xs text-red-400">
        <CircleAlert size={12} /> Unable to enable: {state.message}
      </p>
    );
  }
  return (
    <p role="status" data-testid="browser-notification-state" className="mt-1 text-xs text-neutral-400">
      {state.permission === "granted" ? "Permission granted, but notifications are off" : "Off — permission has not been requested"}
    </p>
  );
}
