export type AppStatus = "registered" | "stopped" | "starting" | "running" | "errored";

export interface AppBridgeConfig {
  initialStatePath?: string;
  statePath?: string;
}

export interface ManagedProcessEntry {
  type: "managed-process";
  workingDirectory: string;
  installCommand?: string;
  devCommand: string;
  healthPath?: string;
  port?: number;
}

export interface AppManifest {
  schemaVersion: 1;
  id: string;
  name: string;
  description?: string;
  version?: string;
  entry: ManagedProcessEntry;
  bridge?: AppBridgeConfig;
}

export interface RegisteredApp {
  id: string;
  sessionId?: string;
  projectCwd: string;
  manifestPath: string;
  manifest: AppManifest;
  status: AppStatus;
  url?: string;
  port?: number;
  lastError?: string;
  updatedAt: number;
}

export interface AppRuntimeLog {
  appId: string;
  sessionId?: string;
  projectCwd: string;
  lines: string[];
}

export interface AppEvent {
  id: string;
  appId: string;
  sessionId?: string;
  projectCwd: string;
  type: "app_event";
  event: string;
  payload?: unknown;
  summary?: string;
  createdAt: number;
}

export interface AppStateRecord {
  appId: string;
  sessionId?: string;
  projectCwd: string;
  state: unknown;
  updatedAt: number;
}

export interface AppRegistrationInput {
  sessionId?: string;
  projectCwd?: string;
  manifestPath: string;
}
