
interface TerminalViewProps {
  sessionId: string | null;
}

// Terminal is not yet connected to pi sessions — for now it shows a
// placeholder. In future phases, it can connect to the session's PTY
// or spawn a shell in the session's working directory.

export function TerminalView({ sessionId }: TerminalViewProps) {
  if (!sessionId) {
    return (
      <div className="h-full flex items-center justify-center text-sm font-mono text-neutral-600">
        Select a session to open a terminal
      </div>
    );
  }

  return (
    <div className="h-full flex items-center justify-center text-sm font-mono text-neutral-500">
      <div className="text-center space-y-2">
        <div className="text-neutral-400">Terminal</div>
        <div className="text-xs text-neutral-600">
          Terminal integration coming in a future update.
          <br />
          Use pi's built-in terminal for shell access.
        </div>
      </div>
    </div>
  );
}