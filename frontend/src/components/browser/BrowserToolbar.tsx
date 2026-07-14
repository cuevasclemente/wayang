import type { BrowserControlMode, BrowserSessionState } from "../../api/client";

interface BrowserToolbarProps {
  state: BrowserSessionState | null;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onRestart: () => void;
  onResetProfile: () => void;
  onControlMode: (mode: BrowserControlMode, reason?: string) => void;
  onNavigate: (url: string) => void;
  onPasteClipboard: () => void;
}

export function BrowserToolbar({
  state,
  busy,
  onStart,
  onStop,
  onRestart,
  onResetProfile,
  onControlMode,
  onNavigate,
  onPasteClipboard,
}: BrowserToolbarProps) {
  const running = state?.status === "running";

  const handleNavigate = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const url = String(data.get("url") || "").trim();
    if (url) onNavigate(url);
  };

  return (
    <div className="border-b border-neutral-800 bg-neutral-950/95 p-3">
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <ToolbarButton disabled={busy || running} onClick={onStart}>Start</ToolbarButton>
        <ToolbarButton disabled={busy || !running} onClick={onStop}>Stop</ToolbarButton>
        <ToolbarButton disabled={busy} onClick={onRestart}>Restart</ToolbarButton>
        <ToolbarButton disabled={busy || !running} onClick={() => onControlMode("user", "User took control in Browser tab")}>User control</ToolbarButton>
        <ToolbarButton disabled={busy || !running} active={state?.controlMode === "agent"} onClick={() => onControlMode("agent")}>Resume agent</ToolbarButton>
        <ToolbarButton
          disabled={busy || !running}
          title="Open a local capture box for Ctrl+V or Linux middle-click/PRIMARY selection paste, then insert it into the focused browser page."
          onClick={onPasteClipboard}
        >
          Paste clipboard…
        </ToolbarButton>
        <ToolbarButton disabled={busy} danger onClick={onResetProfile}>Reset profile</ToolbarButton>
      </div>
      <form className="flex gap-2" onSubmit={handleNavigate}>
        <input
          name="url"
          type="text"
          placeholder="Navigate to a URL, e.g. https://www.google.com/travel/flights"
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
      className={`rounded border px-3 py-1.5 text-xs font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${classes}`}
    >
      {children}
    </button>
  );
}
