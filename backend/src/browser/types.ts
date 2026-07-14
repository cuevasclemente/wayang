export type BrowserLifecycleStatus = "stopped" | "starting" | "running" | "errored";
export type BrowserControlMode = "agent" | "user" | "paused";
export type BrowserViewerTransport = "vnc" | "cdp-screencast";

export interface BrowserProfileMetadata {
  key: string;
  projectCwd: string;
  rootDir: string;
  profileDir: string;
  downloadsDir: string;
  artifactsDir: string;
  runtimePath: string;
  persistence: "project" | "session";
}

export interface BrowserSessionState {
  sessionId: string | null;
  projectCwd: string;
  key: string;
  status: BrowserLifecycleStatus;
  controlMode: BrowserControlMode;
  secretTainted: boolean;
  localOnlyRecommended: boolean;
  needsUser: boolean;
  needsUserReason?: string;
  lastResumeAt?: number;
  activeUrl?: string;
  activeTitle?: string;
  cdpPort?: number;
  cdpReady: boolean;
  viewerTransport: BrowserViewerTransport;
  viewerWsPath?: string;
  cdpScreencastWsPath?: string;
  vncReady: boolean;
  vncPort?: number;
  display?: string;
  profile: BrowserProfileMetadata;
  startedAt?: number;
  updatedAt: number;
  lastError?: string;
  logs: string[];
}

export interface BrowserSessionLookup {
  sessionId?: string | null;
  projectCwd?: string | null;
  persistence?: "project" | "session";
}

export interface BrowserSnapshot {
  url: string;
  title: string;
  text?: string;
  screenshot?: string;
}

export interface BrowserDomElement {
  index: number;
  selector: string;
  tag: string;
  role?: string;
  type?: string;
  name?: string;
  text?: string;
  value?: string;
  href?: string;
  placeholder?: string;
  checked?: boolean;
  disabled?: boolean;
  rect?: { x: number; y: number; width: number; height: number };
}

export interface BrowserDomSnapshot {
  url: string;
  title: string;
  text?: string;
  elements: BrowserDomElement[];
}

export interface BrowserSelectorQueryResult {
  url: string;
  title: string;
  selector: string;
  elements: BrowserDomElement[];
}

export interface BrowserLinksResult {
  url: string;
  title: string;
  links: Array<{ index: number; text: string; href: string; selector: string; visible: boolean }>;
}

export interface BrowserAccessibilityNode {
  role?: string;
  name?: string;
  value?: string;
  description?: string;
  ignored?: boolean;
}

export interface BrowserAccessibilitySnapshot {
  url: string;
  title: string;
  nodes: BrowserAccessibilityNode[];
}
