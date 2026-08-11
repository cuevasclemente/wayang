export type BrowserLifecycleStatus = "stopped" | "starting" | "running" | "errored";
export type BrowserControlMode = "agent" | "user" | "paused";
export type BrowserViewerTransport = "vnc" | "cdp-screencast";
export type BrowserPersistence = "shared" | "project" | "session";

export interface BrowserProfileMetadata {
  key: string;
  projectCwd: string;
  rootDir: string;
  profileDir: string;
  downloadsDir: string;
  artifactsDir: string;
  runtimePath: string;
  persistence: BrowserPersistence;
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
  /** Internal cooperative-control epoch. Never returned by public routes. */
  controlGeneration: number;
  /** Internal CDP target selected for viewer and agent actions. */
  activeTargetId?: string;
}

export interface BrowserPublicState {
  sessionId: string | null;
  projectCwd: string;
  status: BrowserLifecycleStatus;
  controlMode: BrowserControlMode;
  secretTainted: boolean;
  localOnlyRecommended: boolean;
  needsUser: boolean;
  needsUserReason?: string;
  lastResumeAt?: number;
  activeUrl?: string;
  activeTitle?: string;
  cdpReady: boolean;
  viewerTransport: BrowserViewerTransport;
  viewerWsPath?: string;
  cdpScreencastWsPath?: string;
  vncReady: boolean;
  profile: { persistence: BrowserPersistence };
  startedAt?: number;
  updatedAt: number;
  lastError?: string;
  credentialInspection?: "blocked" | "text-allowed";
  /** Backend capability metadata; absence/false means credential UI must stay hidden. */
  credentialBroker?: { supported: boolean; guarded: true };
}

export interface BrowserSessionLookup {
  sessionId?: string | null;
  projectCwd?: string | null;
  persistence?: BrowserPersistence;
}

export const STANDARD_BROWSER_CAPABILITY_ID = "wayang.standard-browser.v1" as const;
export const PROTECTED_BROWSER_CAPABILITY_ID = "wayang.protected-browser.v1" as const;
export type InteractiveBrowserCapabilityId =
  | typeof STANDARD_BROWSER_CAPABILITY_ID
  | typeof PROTECTED_BROWSER_CAPABILITY_ID;
/** @deprecated Retained as an internal compatibility name for the capability-bound browser runtime. */
export type ProtectedBrowserCapabilityId = InteractiveBrowserCapabilityId;
export type ProtectedBrowserControlMode = "agent" | "user" | "paused";
export type ProtectedBrowserAuthorityCheckpoint =
  | "prequeue"
  | "dequeue"
  | "pre-cdp"
  | "prerelease"
  | "viewer-attach"
  | "viewer-message"
  | "control-handoff"
  | "control-resume"
  | "credential-handoff"
  | "credential-resume";

/**
 * Exact pair-authorized runtime lease captured when protected browser control
 * is injected. Provider/model are deliberately absent: they select a Pi
 * runtime, but never identify browser authority or a persistent realm.
 */
export interface ProtectedBrowserBinding {
  capabilityId: ProtectedBrowserCapabilityId;
  sourceSessionId: string;
  projectId: string;
  projectCwd: string;
  agentProfileId: string;
  /** Sole durable Project-Agent capability ABA clock. */
  associationRevision: number;
  /** Fresh process-local Pi runtime lease clock. */
  runtimeGeneration: string;
  processBootNonce: string;
  /** Persistent pair-realm human/agent control clock. */
  controlGeneration: number;
}

/** Resolver result. Every positive invariant is explicit and fail-closed. */
export interface ProtectedBrowserAuthoritySnapshot extends ProtectedBrowserBinding {
  authorized: boolean;
  privacyMode: "standard" | "protected";
  sourceSessionDurable: boolean;
  sourceQuarantined: boolean;
  profileEnabled: boolean;
  projectAllowsProfile: boolean;
}

export interface ProtectedBrowserStorage {
  persistence: "protected";
  rootDir: string;
  profileDir: string;
  artifactsDir: string;
  runtimeDir: string;
}

export type ProtectedBrowserOperation =
  | { kind: "status" }
  | { kind: "start" }
  | { kind: "stop" }
  | { kind: "navigate"; url: string }
  | { kind: "snapshot"; mode?: "text" | "screenshot" }
  | { kind: "dom_snapshot"; includeText?: boolean; limit?: number }
  | { kind: "links"; limit?: number }
  | { kind: "accessibility"; limit?: number }
  | { kind: "query_selector"; selector: string; limit?: number }
  | { kind: "click"; x: number; y: number }
  | { kind: "click_selector"; selector: string; index?: number }
  | { kind: "fill_selector"; selector: string; text: string; index?: number }
  | { kind: "type_public"; text: string };

export interface ProtectedBrowserDispatchResult<T = unknown> {
  value: T;
  /** Required after every CDP-backed operation and checked before result release. */
  topLevelUrl?: string;
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
