import type { BrowserControlMode, BrowserSessionState, BrowserViewerTransport } from "../../api/client";

interface BrowserToolbarProps {
  state: BrowserSessionState | null;
  busy: boolean;
  viewerTransport: BrowserViewerTransport;
  credentialsOpen: boolean;
  credentialsSupported: boolean;
  pasteSupported: boolean;
  resetSupported: boolean;
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

  const handleNavigate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const url = String(data.get("url") || "").trim();
    if (url) onNavigate(url);
  };

  return (
    <div className="shrink-0 border-b border-neutral-800 bg-neutral-950/95 p-2.5 sm:p-3">
      <div className="mb-2 flex min-w-0 flex-wrap items-center gap-1.5">
        <ToolbarButton disabled={busy || running} onClick={onStart}>Start</ToolbarButton>
        <ToolbarButton disabled={busy || !running} onClick={onStop}>Stop</ToolbarButton>
        <ToolbarButton disabled={busy} onClick={onRestart}>Restart</ToolbarButton>
        {cooperative ? (
          <ToolbarButton
            disabled={busy || !running}
            onClick={() => onControlMode("user", "User paused agent control in the Browser workbench")}
            title={protectedRuntime
              ? "Begin protected human control and capture the current document baseline before login, MFA, CAPTCHA, payment, or direct paste."
              : readOnlyInspection
                ? "Pause the agent's read-only redacted inspection while keeping your viewer input active."
                : "Pause agent browser inspection and actions while keeping your viewer input active."}
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
                : "Return to cooperative control so you and the agent can both use this browser."}
          >
            Resume agent
          </ToolbarButton>
        )}
        {credentialsSupported && (
          <ToolbarButton
            disabled={busy || !running}
            active={credentialsOpen}
            title="Open the private credential picker. Opening it pauses the agent; credential-fill permission is read-only and explicit."
            onClick={onCredentials}
          >
            Credentials
          </ToolbarButton>
        )}
        {pasteSupported && <ToolbarButton
          disabled={busy || !running}
          title={protectedRuntime
            ? "Enter human control and paste through the authenticated owner-only route; text never becomes an agent tool parameter."
            : "Paste directly into the focused page without retaining clipboard text in React state."}
          onClick={onPasteClipboard}
        >
          Paste…
        </ToolbarButton>}
        {resetSupported && <ToolbarButton disabled={busy} danger onClick={onResetProfile}>Reset profile</ToolbarButton>}
      </div>

      <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-[11px] text-neutral-500">
          <span>Viewer</span>
          <div className="inline-flex rounded-md border border-neutral-800 bg-neutral-900 p-0.5" role="radiogroup" aria-label="Browser viewer">
            {!protectedRuntime && state?.vncReady === true && (
              <ViewerButton
                checked={viewerTransport === "vnc"}
                disabled={busy || !running}
                onClick={() => onViewerTransport("vnc")}
                title="Full browser includes browser chrome and extensions."
              >
                Full browser
              </ViewerButton>
            )}
            <ViewerButton
              checked={viewerTransport === "cdp-screencast"}
              disabled={busy || !running || state?.cdpReady === false}
              onClick={() => onViewerTransport("cdp-screencast")}
              title="Fast page is the CDP screencast viewer used by protected browser runtimes."
            >
              Fast page
            </ViewerButton>
            {protectedRuntime && <span className="px-2 py-1 text-[11px] text-neutral-600">VNC unavailable</span>}
          </div>
        </div>
        <span className={`rounded-full border px-2 py-1 text-[11px] font-medium ${
          readOnlyInspection
            ? "border-sky-800/70 bg-sky-950/40 text-sky-100"
            : cooperative
              ? "border-emerald-900/70 bg-emerald-950/40 text-emerald-200"
              : "border-amber-800/70 bg-amber-950/40 text-amber-100"
        }`}>
          {readOnlyInspection ? "Agent read-only" : cooperative ? "Shared control" : "Agent paused"}
        </span>
      </div>

      <form className="flex min-w-0 gap-2" onSubmit={handleNavigate}>
        <input
          name="url"
          type="text"
          inputMode="url"
          autoComplete="off"
          placeholder="URL or website"
          aria-label="Browser URL"
          className="min-w-0 flex-1 rounded border border-neutral-800 bg-neutral-900 px-3 py-2 text-sm text-neutral-100 placeholder:text-neutral-600 focus:border-sky-500 focus:outline-none"
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
