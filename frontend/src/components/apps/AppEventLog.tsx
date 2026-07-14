import type { MouseEvent as ReactMouseEvent } from "react";
import type { AppEvent } from "../../api/client";

interface AppEventLogProps {
  events: AppEvent[];
  height: number;
  collapsed: boolean;
  onResizeStart: (event: ReactMouseEvent<HTMLDivElement>) => void;
  onToggleCollapsed: () => void;
  onForward: (event: AppEvent) => void;
}

export function AppEventLog({ events, height, collapsed, onResizeStart, onToggleCollapsed, onForward }: AppEventLogProps) {
  return (
    <div className="shrink-0 border-t border-neutral-900 bg-neutral-950/95" style={{ height: collapsed ? 32 : height }}>
      <div
        role="separator"
        aria-label="Resize app events panel"
        onMouseDown={onResizeStart}
        className="group flex h-2 cursor-row-resize items-center justify-center bg-neutral-950 hover:bg-neutral-900"
      >
        <div className="h-0.5 w-10 rounded bg-neutral-800 group-hover:bg-neutral-600" />
      </div>
      <div className="flex items-center justify-between gap-3 overflow-x-auto px-3 py-2 [-webkit-overflow-scrolling:touch]">
        <h3 className="shrink-0 text-xs font-semibold uppercase tracking-wide text-neutral-400">App events</h3>
        <button
          type="button"
          onClick={onToggleCollapsed}
          className="shrink-0 rounded border border-neutral-800 px-2 py-0.5 text-[11px] text-neutral-300 hover:bg-neutral-900"
        >
          {collapsed ? `Show (${events.length})` : `Hide (${events.length})`}
        </button>
      </div>
      {!collapsed && <div className="h-[calc(100%-42px)] overflow-auto border-t border-neutral-900">
        {events.length === 0 ? (
          <div className="px-3 py-3 text-xs text-neutral-600">No app events yet.</div>
        ) : (
          events.map((event) => (
            <div key={event.id} className="border-b border-neutral-900 px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <div className="min-w-0 truncate font-mono text-neutral-300">{event.event}</div>
                <div className="shrink-0 text-[11px] text-neutral-600">{new Date(event.createdAt).toLocaleTimeString()}</div>
              </div>
              {event.summary && <div className="mt-1 text-neutral-400">{event.summary}</div>}
              {event.payload !== undefined && (
                <pre className="mt-1 max-h-20 overflow-auto rounded bg-neutral-900 p-2 text-[11px] text-neutral-400">
                  {JSON.stringify(event.payload, null, 2)}
                </pre>
              )}
              <button
                type="button"
                onClick={() => onForward(event)}
                className="mt-2 rounded border border-neutral-800 px-2 py-1 text-[11px] text-neutral-300 hover:bg-neutral-900"
              >
                Send summary to agent
              </button>
            </div>
          ))
        )}
      </div>}
    </div>
  );
}
