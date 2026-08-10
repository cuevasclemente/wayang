import { useEffect, useState } from "react";
import { Group, Panel, Separator } from "react-resizable-panels";
import { FileTree } from "../components/FileTree";
import { FileViewer } from "../components/FileViewer";
import { TerminalView } from "../components/TerminalView";
import { CapabilitiesPanel } from "../components/CapabilitiesPanel";
import { AppsPanel } from "./AppsPanel";
import { BrowserPanel } from "./BrowserPanel";
import type { BrowserAgentDiagnostic, BrowserSurfaceMode } from "../api/client";

type Tab = "files" | "terminal" | "pi" | "apps" | "browser";

const RIGHT_PANEL_TAB_STORAGE_PREFIX = "wayang:right-panel-tab:";
const NO_SESSION_TAB_STORAGE_KEY = `${RIGHT_PANEL_TAB_STORAGE_PREFIX}no-session`;

function isTab(value: string | null): value is Tab {
  return value === "files" || value === "terminal" || value === "pi" || value === "apps" || value === "browser";
}

function rightPanelTabStorageKey(sessionId: string | null): string {
  return sessionId ? `${RIGHT_PANEL_TAB_STORAGE_PREFIX}${sessionId}` : NO_SESSION_TAB_STORAGE_KEY;
}

function loadSavedTab(sessionId: string | null): Tab {
  if (typeof window === "undefined") return "files";
  try {
    const value = window.localStorage.getItem(rightPanelTabStorageKey(sessionId));
    return isTab(value) ? value : "files";
  } catch {
    return "files";
  }
}

function saveTab(sessionId: string | null, tab: Tab) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(rightPanelTabStorageKey(sessionId), tab);
  } catch {
    // Ignore unavailable storage.
  }
}

interface RightPanelProps {
  sessionId: string | null;
  sessionCwd: string | null;
  browserMode: BrowserSurfaceMode;
  browserAgent: BrowserAgentDiagnostic | null;
}

export function RightPanel({ sessionId, sessionCwd, browserMode, browserAgent }: RightPanelProps) {
  const [tab, setTab] = useState<Tab>(() => loadSavedTab(sessionId));
  const [selectedFilePath, setSelectedFilePath] = useState<string | null>(null);

  const handleTabChange = (nextTab: Tab) => {
    setTab(nextTab);
    saveTab(sessionId, nextTab);
  };

  // Clear file selection and restore this session's last tools tab when session changes.
  useEffect(() => {
    setSelectedFilePath(null);
    const saved = loadSavedTab(sessionId);
    setTab(saved === "browser" && browserMode === "unavailable" && !browserAgent ? "files" : saved);
  }, [sessionId, browserMode, browserAgent]);

  return (
    <section className="h-full flex flex-col bg-neutral-950">
      <header className="flex border-b border-neutral-900">
        <TabButton active={tab === "files"} onClick={() => handleTabChange("files")}>
          Files
        </TabButton>
        <TabButton
          active={tab === "terminal"}
          onClick={() => handleTabChange("terminal")}
        >
          Terminal
        </TabButton>
        <TabButton active={tab === "pi"} onClick={() => handleTabChange("pi")}>
          Pi
        </TabButton>
        <TabButton active={tab === "apps"} onClick={() => handleTabChange("apps")}>
          Apps
        </TabButton>
        {(browserMode !== "unavailable" || browserAgent) && (
          <TabButton active={tab === "browser"} onClick={() => handleTabChange("browser")}>
            Browser
          </TabButton>
        )}
      </header>
      <div className="flex-1 min-h-0">
        {tab === "files" && (
          <Group orientation="horizontal" className="h-full w-full">
            <Panel defaultSize={35} minSize={15}>
              <FileTree
                selectedPath={selectedFilePath}
                onFileSelect={setSelectedFilePath}
              />
            </Panel>
            <Separator className="w-0.5 bg-neutral-800 hover:bg-neutral-600 transition-colors" />
            <Panel defaultSize={65} minSize={30}>
              <FileViewer path={selectedFilePath} />
            </Panel>
          </Group>
        )}
        {tab === "terminal" && <TerminalView sessionId={sessionId} />}
        {tab === "pi" && <CapabilitiesPanel sessionCwd={sessionCwd} />}
        {tab === "apps" && <AppsPanel sessionId={sessionId} sessionCwd={sessionCwd} />}
        {tab === "browser" && (browserMode !== "unavailable" || browserAgent) && (
          <BrowserPanel
            key={`${sessionId ?? sessionCwd ?? "no-session"}:${browserMode}`}
            sessionId={sessionId}
            sessionCwd={sessionCwd}
            browserMode={browserMode}
            browserAgent={browserAgent}
          />
        )}
      </div>
    </section>
  );
}

interface TabButtonProps {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "relative px-4 py-2.5 text-xs font-semibold uppercase tracking-wider transition-colors " +
        (active ? "text-neutral-100" : "text-neutral-500 hover:text-neutral-300")
      }
    >
      {children}
      <span
        className={
          "absolute bottom-0 left-0 right-0 h-0.5 " +
          (active ? "bg-neutral-100" : "bg-transparent")
        }
      />
    </button>
  );
}