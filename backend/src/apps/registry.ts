import * as fs from "node:fs";
import * as path from "node:path";
import { getStore, flush, type AppRegistrationRow } from "../db.js";
import { canonicalizeProjectCwd } from "../projects.js";
import { getSessionById, listSessions } from "../sessions.js";
import type { AppManifest, AppRegistrationInput, AppStatus, RegisteredApp } from "./types.js";

const APP_ID_RE = /^[a-z0-9][a-z0-9-]{1,62}[a-z0-9]$/;

export class AppRegistryError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "AppRegistryError";
    this.statusCode = statusCode;
  }
}

export function validateAppId(id: string): void {
  if (!APP_ID_RE.test(id)) {
    throw new AppRegistryError(
      "Invalid app id. Use a lowercase slug of 3-64 characters: a-z, 0-9, and hyphen.",
    );
  }
  if (id.includes("..") || id.includes("/") || id.includes("\\")) {
    throw new AppRegistryError("Invalid app id: path separators are not allowed");
  }
}

function normalizeCwd(cwd: string): string {
  return canonicalizeProjectCwd(cwd);
}

function ensureWithin(parent: string, child: string, label: string): void {
  const rel = path.relative(parent, child);
  if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) return;
  throw new AppRegistryError(`${label} must be inside the session cwd`, 400);
}

function resolveUnderCwd(projectCwd: string, targetPath: string, label: string): string {
  const cwd = normalizeCwd(projectCwd);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(cwd, targetPath);
  ensureWithin(cwd, resolved, label);
  return resolved;
}

function toRelative(projectCwd: string, absolutePath: string): string {
  return path.relative(normalizeCwd(projectCwd), absolutePath) || path.basename(absolutePath);
}

function readJsonFile(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf-8"));
  } catch (err: any) {
    throw new AppRegistryError(`Failed to read app manifest: ${err?.message || String(err)}`, 400);
  }
}

export function validateManifest(raw: unknown): AppManifest {
  if (!raw || typeof raw !== "object") {
    throw new AppRegistryError("App manifest must be a JSON object");
  }
  const obj = raw as Record<string, any>;
  if (obj.schemaVersion !== 1) {
    throw new AppRegistryError("App manifest schemaVersion must be 1");
  }
  if (typeof obj.id !== "string") throw new AppRegistryError("App manifest id is required");
  validateAppId(obj.id);
  if (typeof obj.name !== "string" || !obj.name.trim()) {
    throw new AppRegistryError("App manifest name is required");
  }
  if (!obj.entry || typeof obj.entry !== "object") {
    throw new AppRegistryError("App manifest entry is required");
  }
  const entry = obj.entry as Record<string, any>;
  if (entry.type !== "managed-process") {
    throw new AppRegistryError("Only managed-process app entries are supported");
  }
  if (typeof entry.workingDirectory !== "string" || !entry.workingDirectory.trim()) {
    throw new AppRegistryError("entry.workingDirectory is required");
  }
  if (typeof entry.devCommand !== "string" || !entry.devCommand.trim()) {
    throw new AppRegistryError("entry.devCommand is required");
  }
  if (entry.port !== undefined && (!Number.isInteger(entry.port) || entry.port < 0 || entry.port > 65535)) {
    throw new AppRegistryError("entry.port must be an integer between 0 and 65535");
  }

  return {
    schemaVersion: 1,
    id: obj.id,
    name: obj.name,
    description: typeof obj.description === "string" ? obj.description : undefined,
    version: typeof obj.version === "string" ? obj.version : undefined,
    entry: {
      type: "managed-process",
      workingDirectory: entry.workingDirectory,
      installCommand: typeof entry.installCommand === "string" ? entry.installCommand : undefined,
      devCommand: entry.devCommand,
      healthPath: typeof entry.healthPath === "string" ? entry.healthPath : "/",
      port: typeof entry.port === "number" ? entry.port : 0,
    },
    bridge: obj.bridge && typeof obj.bridge === "object"
      ? {
          initialStatePath: typeof obj.bridge.initialStatePath === "string" ? obj.bridge.initialStatePath : undefined,
          statePath: typeof obj.bridge.statePath === "string" ? obj.bridge.statePath : undefined,
        }
      : undefined,
  };
}

export function loadManifest(projectCwd: string, manifestPath: string): { manifest: AppManifest; manifestAbsolutePath: string } {
  const manifestAbsolutePath = resolveUnderCwd(projectCwd, manifestPath, "Manifest path");
  if (!fs.existsSync(manifestAbsolutePath)) {
    throw new AppRegistryError(`Manifest not found: ${manifestPath}`, 404);
  }
  const stat = fs.statSync(manifestAbsolutePath);
  if (!stat.isFile()) throw new AppRegistryError("Manifest path is not a file");

  const manifest = validateManifest(readJsonFile(manifestAbsolutePath));
  const workingDirectory = resolveAppWorkingDirectory(projectCwd, manifest);
  if (!fs.existsSync(workingDirectory) || !fs.statSync(workingDirectory).isDirectory()) {
    throw new AppRegistryError(`App working directory not found: ${manifest.entry.workingDirectory}`, 404);
  }
  return { manifest, manifestAbsolutePath };
}

export function resolveAppWorkingDirectory(projectCwd: string, manifest: AppManifest): string {
  return resolveUnderCwd(projectCwd, manifest.entry.workingDirectory, "App working directory");
}

function rowToRegisteredApp(row: AppRegistrationRow): RegisteredApp {
  return {
    id: row.id,
    sessionId: row.session_id ?? undefined,
    projectCwd: row.project_cwd,
    manifestPath: row.manifest_path,
    manifest: row.manifest,
    status: row.status,
    url: row.url ?? undefined,
    port: row.port ?? undefined,
    lastError: row.last_error ?? undefined,
    updatedAt: row.updated_at,
  };
}

function appKey(projectCwd: string, appId: string): string {
  return `${normalizeCwd(projectCwd)}\u0000${appId}`;
}

function findSessionForCwd(projectCwd: string, sessionId?: string): string | undefined {
  const cwd = normalizeCwd(projectCwd);
  if (sessionId) {
    const session = getSessionById(sessionId);
    if (!session) throw new AppRegistryError("Session not found", 404);
    if (normalizeCwd(session.cwd) !== cwd) {
      throw new AppRegistryError("sessionId cwd does not match projectCwd", 400);
    }
    return session.id;
  }
  const sessions = listSessions(true)
    .filter((s) => !s.archived && normalizeCwd(s.cwd) === cwd)
    .sort((a, b) => b.last_active - a.last_active);
  return sessions[0]?.id;
}

export function registerApp(input: AppRegistrationInput): RegisteredApp {
  const session = input.sessionId ? getSessionById(input.sessionId) : undefined;
  if (input.sessionId && !session) throw new AppRegistryError("Session not found", 404);

  const projectCwd = normalizeCwd(input.projectCwd || session?.cwd || process.cwd());
  const sessionId = findSessionForCwd(projectCwd, input.sessionId);
  const { manifest, manifestAbsolutePath } = loadManifest(projectCwd, input.manifestPath);
  const manifestPath = toRelative(projectCwd, manifestAbsolutePath);
  const now = Date.now();

  const store = getStore();
  const existing = store.apps.find((row) => row.project_cwd === projectCwd && row.id === manifest.id);
  const row: AppRegistrationRow = {
    id: manifest.id,
    session_id: sessionId ?? null,
    project_cwd: projectCwd,
    manifest_path: manifestPath,
    manifest,
    status: existing?.status === "running" || existing?.status === "starting" ? existing.status : "stopped",
    url: existing?.url ?? null,
    port: existing?.port ?? null,
    last_error: null,
    updated_at: now,
  };

  if (existing) Object.assign(existing, row);
  else store.apps.push(row);
  flush();

  return rowToRegisteredApp(row);
}

function scanProjectApps(projectCwd: string, sessionId?: string): RegisteredApp[] {
  const appsRoot = path.join(normalizeCwd(projectCwd), ".pi", "apps");
  if (!fs.existsSync(appsRoot) || !fs.statSync(appsRoot).isDirectory()) return [];

  const discovered: RegisteredApp[] = [];
  for (const entry of fs.readdirSync(appsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const manifestPath = path.join(appsRoot, entry.name, "app.json");
    if (!fs.existsSync(manifestPath)) continue;
    try {
      const app = registerApp({ sessionId, projectCwd, manifestPath });
      discovered.push(app);
    } catch {
      // Ignore invalid discovered apps; explicit registration returns errors.
    }
  }
  return discovered;
}

export function listAppsForProject(projectCwd: string, sessionId?: string, scan = true): RegisteredApp[] {
  const cwd = normalizeCwd(projectCwd);
  if (sessionId) findSessionForCwd(cwd, sessionId);
  if (scan) scanProjectApps(cwd, sessionId);
  const store = getStore();
  const rows = store.apps
    .filter((row) => row.project_cwd === cwd)
    .sort((a, b) => a.manifest.name.localeCompare(b.manifest.name));
  return rows.map(rowToRegisteredApp);
}

export function listAppsForSession(sessionId: string, scan = true): RegisteredApp[] {
  const session = getSessionById(sessionId);
  if (!session) throw new AppRegistryError("Session not found", 404);
  return listAppsForProject(session.cwd, sessionId, scan);
}

export function getRegisteredApp(appId: string, opts: { sessionId?: string; projectCwd?: string }): RegisteredApp {
  validateAppId(appId);
  const projectCwd = opts.projectCwd
    ? normalizeCwd(opts.projectCwd)
    : opts.sessionId
      ? normalizeCwd(getSessionById(opts.sessionId)?.cwd || "")
      : "";
  if (!projectCwd) throw new AppRegistryError("sessionId or projectCwd is required", 400);
  if (opts.sessionId) findSessionForCwd(projectCwd, opts.sessionId);

  const row = getStore().apps.find((candidate) => appKey(candidate.project_cwd, candidate.id) === appKey(projectCwd, appId));
  if (!row) throw new AppRegistryError("App not registered", 404);
  return rowToRegisteredApp(row);
}

export function updateAppRuntime(
  appId: string,
  projectCwd: string,
  patch: Partial<Pick<RegisteredApp, "status" | "url" | "port" | "lastError">>,
): RegisteredApp {
  const cwd = normalizeCwd(projectCwd);
  const row = getStore().apps.find((candidate) => candidate.project_cwd === cwd && candidate.id === appId);
  if (!row) throw new AppRegistryError("App not registered", 404);
  if (patch.status) row.status = patch.status as AppStatus;
  if ("url" in patch) row.url = patch.url ?? null;
  if ("port" in patch) row.port = patch.port ?? null;
  if ("lastError" in patch) row.last_error = patch.lastError ?? null;
  row.updated_at = Date.now();
  flush();
  return rowToRegisteredApp(row);
}

export function refreshManifest(app: RegisteredApp): RegisteredApp {
  const { manifest, manifestAbsolutePath } = loadManifest(app.projectCwd, app.manifestPath);
  const manifestPath = toRelative(app.projectCwd, manifestAbsolutePath);
  const row = getStore().apps.find((candidate) => candidate.project_cwd === app.projectCwd && candidate.id === app.id);
  if (!row) throw new AppRegistryError("App not registered", 404);
  row.manifest = manifest;
  row.manifest_path = manifestPath;
  row.updated_at = Date.now();
  flush();
  return rowToRegisteredApp(row);
}
