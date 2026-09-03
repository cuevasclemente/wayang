import { useEffect, useRef, useState, type ReactNode } from "react";
import { TerminalView } from "../components/TerminalView";
import { CapabilitiesPanel } from "../components/CapabilitiesPanel";
import { AppsPanel } from "./AppsPanel";
import { ArtifactsPanel } from "./ArtifactsPanel";
import { BrowserPanel } from "./BrowserPanel";
import type { ArtifactFocusIntent } from "../hooks/useSessionArtifacts";
import type { BrowserAgentDiagnostic, BrowserSurfaceMode } from "../api/client";

export type ArtifactPanelEvent = {
  sessionId: string;
  artifactId: string | null;
  revision: number;
  reason: "presented" | "uploaded" | "removed";
  requestKey: string;
  userInitiated?: boolean;
};

type Tab = "artifacts" | "terminal" | "pi" | "apps" | "browser";

const RIGHT_PANEL_TAB_STORAGE_PREFIX = "wayang:right-panel-tab:";
const NO_SESSION_TAB_STORAGE_KEY = `${RIGHT_PANEL_TAB_STORAGE_PREFIX}no-session`;

function isTab(value: string | null): value is Tab {
  return value === "artifacts" || value === "terminal" || value === "pi" || value === "apps" || value === "browser";
}

function rightPanelTabStorageKey(sessionId: string | null): string {
  return sessionId ? `${RIGHT_PANEL_TAB_STORAGE_PREFIX}${sessionId}` : NO_SESSION_TAB_STORAGE_KEY;
}

function loadSavedTab(sessionId: string | null): Tab {
  if (typeof window === "undefined") return "artifacts";
  try {
    const value = window.localStorage.getItem(rightPanelTabStorageKey(sessionId));
    if (value === "files") {
      window.localStorage.setItem(rightPanelTabStorageKey(sessionId), "artifacts");
      return "artifacts";
    }
    return isTab(value) ? value : "artifacts";
  } catch {
    return "artifacts";
  }
}

function saveTab(sessionId: string | null, tab: Tab) {
  if (typeof window === "undefined") return;
  try { window.localStorage.setItem(rightPanelTabStorageKey(sessionId), tab); }
  catch { /* unavailable storage */ }
}

interface RightPanelProps {
  sessionId: string | null;
  sessionCwd: string | null;
  browserMode: BrowserSurfaceMode;
  browserAgent: BrowserAgentDiagnostic | null;
  artifactEvent?: ArtifactPanelEvent | null;
}

export function RightPanel({ sessionId, sessionCwd, browserMode, browserAgent, artifactEvent = null }: RightPanelProps) {
  const [tab, setTab] = useState<Tab>(() => loadSavedTab(sessionId));
  const [artifactFocusIntent, setArtifactFocusIntent] = useState<ArtifactFocusIntent | null>(null);
  const [artifactUnread, setArtifactUnread] = useState(0);
  const processedArtifactEvent = useRef<string | null>(null);

  const handleTabChange = (nextTab: Tab) => {
    setTab(nextTab);
    saveTab(sessionId, nextTab);
    if (nextTab === "artifacts") setArtifactUnread(0);
  };

  useEffect(() => {
    const saved = loadSavedTab(sessionId);
    setTab(saved === "browser" && browserMode === "unavailable" && !browserAgent ? "artifacts" : saved);
    setArtifactFocusIntent(null);
    setArtifactUnread(0);
    processedArtifactEvent.current = null;
  }, [sessionId, browserMode, browserAgent]);

  useEffect(() => {
    if (!artifactEvent || artifactEvent.sessionId !== sessionId
      || processedArtifactEvent.current === artifactEvent.requestKey) return;
    processedArtifactEvent.current = artifactEvent.requestKey;
    setArtifactFocusIntent({
      artifactId: artifactEvent.artifactId,
      revision: artifactEvent.revision,
      requestKey: artifactEvent.requestKey,
    });
    if (artifactEvent.reason === "presented" && artifactEvent.artifactId) {
      setTab("artifacts");
      saveTab(sessionId, "artifacts");
      setArtifactUnread(0);
    } else if (tab !== "artifacts") {
      setArtifactUnread((count) => Math.min(99, count + 1));
    }
  }, [artifactEvent, sessionId, tab]);

  return (
    <section className="flex h-full flex-col bg-neutral-950">
      <header className="flex border-b border-neutral-900">
        <TabButton active={tab === "artifacts"} onClick={() => handleTabChange("artifacts")}>
          Artifacts{artifactUnread > 0 ? ` ${artifactUnread}` : ""}
        </TabButton>
        <TabButton active={tab === "terminal"} onClick={() => handleTabChange("terminal")}>Terminal</TabButton>
        <TabButton active={tab === "pi"} onClick={() => handleTabChange("pi")}>Pi</TabButton>
        <TabButton active={tab === "apps"} onClick={() => handleTabChange("apps")}>Apps</TabButton>
        {(browserMode !== "unavailable" || browserAgent) && (
          <TabButton active={tab === "browser"} onClick={() => handleTabChange("browser")}>Browser</TabButton>
        )}
      </header>
      <div className="min-h-0 flex-1">
        {tab === "artifacts" && <ArtifactsPanel sessionId={sessionId} focusIntent={artifactFocusIntent} />}
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
  children: ReactNode;
}

function TabButton({ active, onClick, children }: TabButtonProps) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={
        "relative px-4 py-2.5 text-xs font-semibold uppercase tracking-wider transition-colors "
        + (active ? "text-neutral-100" : "text-neutral-500 hover:text-neutral-300")
      }
    >
      {children}
      <span className={`absolute bottom-0 left-0 right-0 h-0.5 ${active ? "bg-neutral-100" : "bg-transparent"}`} />
    </button>
  );
}
