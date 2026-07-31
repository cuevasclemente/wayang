import { useEffect, useState } from "react";
import type { BashMode } from "../api/client";

export function BashModeStatus({ mode }: { mode: BashMode }) {
  const [hostDetailsExpanded, setHostDetailsExpanded] = useState(false);

  useEffect(() => {
    // Host authority must remain visible, but the repeated explanatory copy is
    // intentionally collapsed whenever a fresh/reconnected host runtime appears.
    if (mode !== "host") setHostDetailsExpanded(false);
  }, [mode]);

  if (mode === "host") {
    return (
      <div
        role="status"
        aria-live="polite"
        data-testid="bash-mode-status"
        data-bash-mode={mode}
        data-expanded={hostDetailsExpanded ? "true" : "false"}
        className="flex w-full flex-wrap items-center gap-x-2 gap-y-1 rounded border border-amber-700/70 bg-amber-950/40 px-2 py-1 text-[11px] leading-4 text-amber-100"
      >
        <span className="font-semibold uppercase tracking-wide text-amber-300">Host access</span>
        <button
          type="button"
          data-testid="bash-mode-details-toggle"
          aria-expanded={hostDetailsExpanded}
          onClick={() => setHostDetailsExpanded((expanded) => !expanded)}
          className="rounded px-1.5 py-0.5 font-medium text-amber-200 underline decoration-amber-600 underline-offset-2 hover:bg-amber-900/50 hover:text-amber-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-amber-400"
        >
          {hostDetailsExpanded ? "Collapse" : "Details"}
        </button>
        {hostDetailsExpanded && (
          <span className="basis-full sm:basis-auto">
            Bash commands run as the Wayang OS user outside the filesystem sandbox and can affect same-UID files, processes, credentials, network services, and existing privilege mechanisms. An authenticated remote Wayang controller can trigger those host effects; Protected and memory labels are cooperative, not same-UID isolation.
          </span>
        )}
      </div>
    );
  }

  const sandboxed = mode === "sandboxed";
  const sandboxedUnix = mode === "sandboxed-unix";
  return (
    <div
      role="status"
      aria-live="polite"
      data-testid="bash-mode-status"
      data-bash-mode={mode}
      title={sandboxed
        ? "Bash runs in Wayang's per-command filesystem and control-socket sandbox."
        : sandboxedUnix
          ? "Bash remains filesystem-sandboxed, but seeded legacy Wren may use visible Unix IPC sockets with same-user authority."
          : "No active runtime currently provides bash authority."}
      className={`w-fit max-w-full rounded border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${
        sandboxed
          ? "border-blue-900/70 bg-blue-950/30 text-blue-300"
          : sandboxedUnix
            ? "border-violet-800/70 bg-violet-950/30 text-violet-300"
            : "border-neutral-800 bg-neutral-900 text-neutral-500"
      }`}
    >
      {sandboxed ? "Sandboxed bash" : sandboxedUnix ? "Sandboxed bash · Unix IPC" : "Bash unavailable"}
    </div>
  );
}
