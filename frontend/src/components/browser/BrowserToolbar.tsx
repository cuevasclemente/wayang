import type { BrowserControlMode, BrowserSessionState, BrowserViewerTransport } from "../../api/client";

interface BrowserToolbarProps {
  state: BrowserSessionState | null;
  busy: boolean;
  viewerTransport: BrowserViewerTransport;
  credentialsOpen: boolean;
  credentialsSupported: boolean;
  pasteSupported: boolean;
  resetSupported: boolean;
  restartSupported: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onResetProfile: () => void;
  onControlMode: (mode: BrowserControlMode, reason?: string) => void;
  onViewerTransport: (transport: BrowserViewerTransport) => void;
  onCredentials: () => void;
  onNavigate: (url: string) => void;
  onPasteClipboard: () => void;
}

export function BrowserToolbar({
  state,
  busy,
  viewerTransport,
  credentialsOpen,
  credentialsSupported,
  pasteSupported,
  resetSupported,
  restartSupported,
  onStart,
  onStop,
  onRestart,
  onResetProfile,
  onControlMode,
  onViewerTransport,
  onCredentials,
  onNavigate,
  onPasteClipboard,
}: BrowserToolbarProps) {
  const running = state?.status === "running";
  const cooperative = state?.controlMode === "agent";
  const readOnlyInspection = state?.credentialInspection === "text-allowed";
  // Runtime kind is a backend projection. Never infer browser authority from a
  // project/profile display name.
  const protectedRuntime = state?.profile.persistence === "protected";
  const namedRuntime = state?.profile.persistence === "named";

  const handleNavigate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const url = String(data.get("url") || "").trim();
    if (url) onNavigate(url);
  };

  const controlLabel = readOnlyInspection ? "Agent read-only" : cooperative ? "Shared control" : "Agent paused";
  const controlTitle = readOnlyInspection
    ? "Only redacted text and DOM inspection are allowed; screenshots and mutations remain blocked."
    : cooperative
      ? "You and the agent may both act in this browser. Pause the agent before sensitive or irreversible work."
      : "Viewer input remains active while agent browser inspection and actions are paused.";

  return (
    <div className="shrink-0 border-b border-neutral-800 bg-neutral-950/95 p-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto">
        {!running && <ToolbarButton disabled={busy} onClick={onStart}>Start</ToolbarButton>}

        {running && (cooperative ? (
          <ToolbarButton
            disabled={busy || !running}
            onClick={() => onControlMode("user", "User paused agent control in the Browser workbench")}
            title={protectedRuntime
              ? "Begin protected human control before login, MFA, CAPTCHA, payment, or direct paste."
              : readOnlyInspection
                ? "Pause the agent's read-only redacted inspection while keeping viewer input active."
                : "Pause agent browser inspection and actions while keeping viewer input active."}
          >
            {protectedRuntime ? "Human control" : "Pause agent"}
          </ToolbarButton>
        ) : (
          <ToolbarButton
            disabled={busy || !running}
            active
            onClick={() => onControlMode("agent")}
            title={protectedRuntime
              ? "Resume only after reaching a fresh safe top-level document."
              : state?.credentialInspection === "blocked"
                ? "Credential-fill protection blocks generic Resume. Use Credentials to allow read-only redacted inspection."
                : "Return to cooperative browser control."}
          >
            Resume agent
          </ToolbarButton>
        ))}

        {credentialsSupported && (
          <ToolbarButton
            disabled={busy || !running}
            active={credentialsOpen}
            title="Open the private credential picker. Opening it pauses the agent."
            onClick={onCredentials}
          >
            Credentials
          </ToolbarButton>
        )}

        <div className="inline-flex shrink-0 rounded-md border border-neutral-800 bg-neutral-900 p-0.5" role="radiogroup" aria-label="Browser viewer">
          {!protectedRuntime && state?.vncReady === true && (
            <ViewerButton
              checked={viewerTransport === "vnc"}
              disabled={busy || !running}
              onClick={() => onViewerTransport("vnc")}
              title={namedRuntime
                ? "Profile-wide Full browser can display and control every visible tab in this shared named profile."
                : "Full browser includes browser chrome and extensions."}
            >
              Full browser
            </ViewerButton>
          )}
          <ViewerButton
            checked={viewerTransport === "cdp-screencast"}
            disabled={busy || !running || state?.cdpReady === false}
            onClick={() => onViewerTransport("cdp-screencast")}
            title="Fast page is the low-latency CDP screencast viewer."
          >
            Fast page
          </ViewerButton>
        </div>

        <span
          role="status"
          title={controlTitle}
          className={`rounded-full border px-2 py-1 text-[11px] font-medium ${
            readOnlyInspection
              ? "border-sky-800/70 bg-sky-950/40 text-sky-100"
              : cooperative
                ? "border-emerald-900/70 bg-emerald-950/40 text-emerald-200"
                : "border-amber-800/70 bg-amber-950/40 text-amber-100"
          }`}
        >
          {controlLabel}
        </span>
        </div>

        {(running || pasteSupported || restartSupported || resetSupported) && (
          <details className="relative shrink-0">
            <summary className="cursor-pointer list-none rounded border border-neutral-700 bg-neutral-900 px-2.5 py-1.5 text-xs font-medium text-neutral-300 hover:bg-neutral-800">
              More
            </summary>
            <div className="absolute right-0 top-full z-30 mt-1 flex min-w-40 flex-col gap-1 rounded border border-neutral-700 bg-neutral-950 p-1.5 shadow-xl">
              {running && <ToolbarButton disabled={busy} onClick={onStop}>Stop browser</ToolbarButton>}
              {pasteSupported && <ToolbarButton
                disabled={busy || !running}
                title={protectedRuntime
                  ? "Enter human control and paste through the authenticated owner-only route."
                  : "Paste directly into the focused page without retaining clipboard text in React state."}
                onClick={onPasteClipboard}
              >Paste…</ToolbarButton>}
              {restartSupported && <ToolbarButton disabled={busy} onClick={onRestart}>Restart</ToolbarButton>}
              {resetSupported && <ToolbarButton disabled={busy} danger onClick={onResetProfile}>Reset profile</ToolbarButton>}
            </div>
          </details>
        )}
      </div>

      <form className="mt-1.5 flex min-w-0 gap-1.5" onSubmit={handleNavigate}>
        <input
          name="url"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="URL or website"
          aria-label="Browser URL"
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-1.5 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500 focus:outline-none"
          disabled={busy || !running}
        />
        <ToolbarButton disabled={busy || !running} submit>Go</ToolbarButton>
      </form>
    </div>
  );
}

interface ToolbarButtonProps {
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
  submit?: boolean;
  onClick?: () => void;
  title?: string;
}

function ToolbarButton({ children, disabled, active, danger, submit, onClick, title }: ToolbarButtonProps) {
  const classes = danger
    ? "border-red-900/70 bg-red-950/40 text-red-200 hover:bg-red-900/50"
    : active
      ? "border-sky-500 bg-sky-500/20 text-sky-100"
      : "border-neutral-700 bg-neutral-900 text-neutral-200 hover:bg-neutral-800";
  return (
    <button
      type={submit ? "submit" : "button"}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`whitespace-nowrap rounded border px-2.5 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${classes}`}
    >
      {children}
    </button>
  );
}

function ViewerButton({
  children,
  checked,
  disabled,
  onClick,
  title,
}: {
  children: React.ReactNode;
  checked: boolean;
  disabled: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      disabled={disabled}
      onClick={onClick}
      title={title}
      className={`rounded px-2 py-1 text-[11px] font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        checked ? "bg-neutral-700 text-white shadow-sm" : "text-neutral-400 hover:text-neutral-200"
      }`}
    >
      {children}
    </button>
  );
}
