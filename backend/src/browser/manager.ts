import { spawn, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { CdpConnection, connectBrowserCdp, type ChromeTarget } from "./cdp.js";
import type {
  BrowserAccessibilitySnapshot,
  BrowserControlMode,
  BrowserDomSnapshot,
  BrowserLinksResult,
  BrowserSelectorQueryResult,
  BrowserPersistence,
  BrowserPublicState,
  BrowserSessionLookup,
  BrowserSessionState,
  BrowserSnapshot,
} from "./types.js";
import { stripInternalCapabilityEnv } from "../child-env.js";
import { resolveBrowserSessionLookup } from "./lookup.js";
import { ManagedChromiumFrameTargetIndex } from "./frame-target-index.js";

// Generic protected-browser coordination is re-exported here for runtime
// composition while its workspace authority and Chromium backend stay injected.
export {
  CapabilityBoundProtectedBrowser,
  ensureProtectedBrowserStorage,
  exactProtectedBrowserBindingEqual,
  isProtectedBrowserAllowedTopLevelUrl,
  isProtectedBrowserHttpsUrl,
  normalizeProtectedBrowserHttpsUrl,
  type ProtectedBrowserAuthorityPort,
  type ProtectedBrowserBackendPort,
  type ProtectedBrowserCredentialPort,
} from "./protected-browser.js";

const STARTUP_TIMEOUT_MS = 20_000;
const MAX_LOG_LINES = 300;

type CredentialInspectionMode = "none" | "blocked" | "text-allowed";
type AgentWorkKind = "inspection-text" | "inspection-screenshot" | "mutation";

interface CredentialInspectionState {
  mode: CredentialInspectionMode;
  values: string[];
  targetId?: string;
  documentIdentity?: string;
  allowUsed: boolean;
}

interface BrowserRuntime {
  state: BrowserSessionState;
  child: ChildProcess | null;
  xvfbChild: ChildProcess | null;
  vncChild: ChildProcess | null;
  stopping: boolean;
  mutationTail: Promise<void>;
  credentialInspection: CredentialInspectionState;
}

const runtimes = new Map<string, BrowserRuntime>();
const browserStopHooks = new Set<() => Promise<void>>();

function now(): number {
  return Date.now();
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function appendLog(runtime: BrowserRuntime, line: string): void {
  runtime.state.logs.push(`${new Date().toISOString()} ${line}`);
  if (runtime.state.logs.length > MAX_LOG_LINES) {
    runtime.state.logs.splice(0, runtime.state.logs.length - MAX_LOG_LINES);
  }
  runtime.state.updatedAt = now();
}

function appendChunk(runtime: BrowserRuntime, chunk: Buffer | string): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
  for (const line of text.split(/\r?\n/)) {
    if (line.trim()) appendLog(runtime, line);
  }
}

function executableOnPath(name: string): string | null {
  if (name.includes(path.sep)) return null;
  for (const directory of (process.env.PATH || "").split(path.delimiter)) {
    if (!path.isAbsolute(directory)) continue;
    const resolved = resolveChromiumExecutableCandidate(path.join(directory, name));
    if (resolved) return resolved;
  }
  return null;
}

function hasCommand(name: string): boolean {
  return executableOnPath(name) !== null;
}

function canUseVncTransport(): boolean {
  return process.platform === "linux" && hasCommand("Xvfb") && hasCommand("x11vnc");
}

function selectedViewerTransport(vncAvailable: boolean): "vnc" | "cdp-screencast" {
  const configured = process.env.WAYANG_BROWSER_TRANSPORT || "auto";
  if (configured === "vnc" && !vncAvailable) throw new Error("VNC transport requested but Xvfb/x11vnc are unavailable");
  return configured === "cdp" || !vncAvailable ? "cdp-screencast" : "vnc";
}

function browserChildEnvironment(overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...stripInternalCapabilityEnv(process.env), ...stripInternalCapabilityEnv(overrides) };
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate local port")));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

export function getPlaywrightCacheRoot(
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
): string {
  return platform === "darwin"
    ? path.join(homeDir, "Library", "Caches", "ms-playwright")
    : path.join(homeDir, ".cache", "ms-playwright");
}

export function getChromiumHostArchitecture(
  platform: NodeJS.Platform = process.platform,
  processArch: NodeJS.Architecture = process.arch,
  cpuModels?: readonly string[],
): NodeJS.Architecture {
  if (platform !== "darwin") return processArch;
  const detectedCpuModels = cpuModels ?? os.cpus().map((cpu) => cpu.model);
  return detectedCpuModels.some((model) => model.includes("Apple")) ? "arm64" : processArch;
}

function playwrightEntryRevision(name: string): number {
  return Number(name.match(/-(\d+)$/)?.[1] ?? 0);
}

function playwrightEntryProductOrder(name: string): number {
  return name.startsWith("chromium-") ? 0 : 1;
}

export function getPlaywrightChromiumCandidates(
  platform: NodeJS.Platform = process.platform,
  hostArchitecture: NodeJS.Architecture = process.arch,
  homeDir = os.homedir(),
  cacheEntryNames?: readonly string[],
): string[] {
  const cacheDir = getPlaywrightCacheRoot(platform, homeDir);
  let entries: readonly string[];
  try {
    entries = cacheEntryNames ?? fs.readdirSync(cacheDir);
  } catch {
    return [];
  }

  return entries
    .filter((name) => /^(?:chromium|chromium_headless_shell)-\d+$/.test(name))
    .sort((a, b) => (
      playwrightEntryRevision(b) - playwrightEntryRevision(a)
      || playwrightEntryProductOrder(a) - playwrightEntryProductOrder(b)
    ))
    .flatMap((name) => {
      if (platform === "darwin") {
        // Unknown macOS architectures conservatively probe both supported Playwright layouts.
        const macArchitectures = hostArchitecture === "arm64" || hostArchitecture === "x64"
          ? [hostArchitecture]
          : ["arm64", "x64"];
        if (name.startsWith("chromium_headless_shell-")) {
          return macArchitectures.map((candidateArch) => path.join(
            cacheDir,
            name,
            `chrome-headless-shell-mac-${candidateArch}`,
            "chrome-headless-shell",
          ));
        }
        return [
          ...macArchitectures.map((candidateArch) => path.join(
            cacheDir,
            name,
            `chrome-mac-${candidateArch}`,
            "Google Chrome for Testing.app",
            "Contents",
            "MacOS",
            "Google Chrome for Testing",
          )),
          path.join(cacheDir, name, "chrome-mac", "Chromium.app", "Contents", "MacOS", "Chromium"),
        ];
      }
      if (name.startsWith("chromium_headless_shell-")) return [];
      return [
        path.join(cacheDir, name, "chrome-linux64", "chrome"),
        path.join(cacheDir, name, "chrome-linux", "chrome"),
      ];
    });
}

export function getSystemChromiumCandidates(
  platform: NodeJS.Platform = process.platform,
  homeDir = os.homedir(),
): string[] {
  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      path.join(homeDir, "Applications", "Google Chrome.app", "Contents", "MacOS", "Google Chrome"),
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      path.join(homeDir, "Applications", "Chromium.app", "Contents", "MacOS", "Chromium"),
    ];
  }
  return [
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
  ];
}

export function getChromiumCandidates(
  configured: string | undefined,
  platform: NodeJS.Platform = process.platform,
  processArch: NodeJS.Architecture = process.arch,
  homeDir = os.homedir(),
  cacheEntryNames?: readonly string[],
  cpuModels?: readonly string[],
): string[] {
  const hostArchitecture = getChromiumHostArchitecture(platform, processArch, cpuModels);
  return [
    ...(configured ? [configured] : []),
    ...getPlaywrightChromiumCandidates(platform, hostArchitecture, homeDir, cacheEntryNames),
    ...getSystemChromiumCandidates(platform, homeDir),
  ];
}

export function resolveChromiumExecutableCandidate(candidate: string): string | null {
  if (!path.isAbsolute(candidate)) return null;
  try {
    const canonical = fs.realpathSync.native(candidate);
    if (!fs.statSync(canonical).isFile()) return null;
    fs.accessSync(canonical, fs.constants.X_OK);
    return canonical;
  } catch {
    return null;
  }
}

export type BrowserExecutableState = "resolved" | "missing" | "invalid_configured_path" | "unchecked";

export interface BrowserExecutableDiagnostic {
  platform: NodeJS.Platform;
  transport: "cdp-screencast" | "vnc";
  state: BrowserExecutableState;
  reasonCode?: "browser_not_found" | "configured_path_invalid" | "transport_unavailable";
}

/** Non-secret preflight: reports only platform/transport and resolution class,
 * never candidate paths or environment values. */
export function getBrowserExecutableDiagnostic(options: {
  configuredPath?: string | null;
  requestedTransport?: string;
  vncAvailable?: boolean;
  platform?: NodeJS.Platform;
} = {}): BrowserExecutableDiagnostic {
  const configured = options.configuredPath === undefined
    ? process.env.WAYANG_CHROMIUM_PATH || process.env.CHROME_PATH || process.env.CHROMIUM_PATH
    : options.configuredPath || undefined;
  const vncAvailable = options.vncAvailable ?? canUseVncTransport();
  const requestedTransport = options.requestedTransport ?? process.env.WAYANG_BROWSER_TRANSPORT ?? "auto";
  const platform = options.platform ?? process.platform;
  const transportUnavailable = requestedTransport === "vnc" && !vncAvailable;
  const transport: BrowserExecutableDiagnostic["transport"] = requestedTransport === "vnc" ? "vnc" : selectedViewerTransport(vncAvailable);
  if (configured) {
    if (!path.isAbsolute(configured) || !resolveChromiumExecutableCandidate(configured)) {
      return { platform, transport, state: "invalid_configured_path", reasonCode: "configured_path_invalid" };
    }
    return { platform, transport, state: "resolved", ...(transportUnavailable ? { reasonCode: "transport_unavailable" as const } : {}) };
  }
  const resolved = getChromiumCandidates(undefined).some((candidate) => Boolean(resolveChromiumExecutableCandidate(candidate)))
    || ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"].some((name) => Boolean(executableOnPath(name)));
  return resolved
    ? { platform, transport, state: "resolved", ...(transportUnavailable ? { reasonCode: "transport_unavailable" as const } : {}) }
    : { platform, transport, state: "missing", reasonCode: "browser_not_found" };
}

export function findChromiumExecutableCandidates(): string[] {
  const configured = process.env.WAYANG_CHROMIUM_PATH || process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
  if (configured) {
    if (!path.isAbsolute(configured)) throw new Error("Configured Chromium executable path must be absolute.");
    const resolved = resolveChromiumExecutableCandidate(configured);
    if (!resolved) throw new Error("Configured Chromium executable path is not an executable file.");
    return [resolved];
  }
  const candidates = getChromiumCandidates(undefined)
    .map(resolveChromiumExecutableCandidate)
    .filter((candidate): candidate is string => Boolean(candidate));
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    const found = executableOnPath(name);
    if (found) candidates.push(found);
  }
  const unique = [...new Set(candidates)];
  if (unique.length === 0) throw new Error("Chromium executable not found. Set WAYANG_CHROMIUM_PATH to a Chromium/Chrome binary.");
  return unique;
}

function findChromiumExecutable(): string {
  return findChromiumExecutableCandidates()[0];
}

function sanitizeKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "browser";
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function profileKey(projectCwd: string, sessionId: string | null, persistence: BrowserPersistence): string {
  if (persistence === "shared") return "shared";
  if (persistence === "session" && sessionId) return `session-${sanitizeKeySegment(sessionId.slice(0, 36))}`;
  return `${sanitizeKeySegment(path.basename(projectCwd))}-${hash(projectCwd)}`;
}

function createInitialState(lookup: BrowserSessionLookup): BrowserSessionState {
  const resolved = resolveBrowserSessionLookup(lookup);
  const key = profileKey(resolved.projectCwd, resolved.sessionId, resolved.persistence);
  const rootDir = resolved.persistence === "shared"
    ? path.join(process.env.WAYANG_DATA_DIR || process.env.PI_WEB_UI_DATA_DIR || path.join(os.homedir(), ".wayang"), "browser-workbench")
    : path.join(resolved.projectCwd, ".pi", "browser-workbench");
  const profileDir = path.join(rootDir, "profiles", key);
  const downloadsDir = path.join(rootDir, "downloads", key);
  const artifactsDir = path.join(rootDir, "artifacts", key);
  const runtimePath = path.join(rootDir, "runtime", `${key}.json`);
  return {
    sessionId: resolved.sessionId,
    projectCwd: resolved.projectCwd,
    key,
    status: "stopped",
    controlMode: "agent",
    secretTainted: false,
    localOnlyRecommended: false,
    needsUser: false,
    cdpReady: false,
    viewerTransport: selectedViewerTransport(canUseVncTransport()),
    viewerWsPath: `/ws/browser-vnc?${new URLSearchParams(resolved.sessionId ? { session_id: resolved.sessionId } : { project_cwd: resolved.projectCwd }).toString()}`,
    cdpScreencastWsPath: `/ws/browser?${new URLSearchParams(resolved.sessionId ? { session_id: resolved.sessionId } : { project_cwd: resolved.projectCwd }).toString()}`,
    vncReady: false,
    profile: {
      key,
      projectCwd: resolved.projectCwd,
      rootDir,
      profileDir,
      downloadsDir,
      artifactsDir,
      runtimePath,
      persistence: resolved.persistence,
    },
    updatedAt: now(),
    logs: [],
    controlGeneration: 0,
  };
}

function cloneState(state: BrowserSessionState): BrowserSessionState {
  return { ...state, profile: { ...state.profile }, logs: [...state.logs] };
}

export function sanitizeBrowserErrorMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error || "");
  if (/Configured Chromium executable path must be absolute/i.test(message)) return "Configured Chromium executable path must be absolute.";
  if (/Configured Chromium executable path is not an executable file/i.test(message)) return "Configured Chromium executable path is not an executable file.";
  if (/Chromium executable not found/i.test(message)) return "Chromium executable not found. Configure WAYANG_CHROMIUM_PATH.";
  if (/VNC transport requested/i.test(message)) return "VNC transport is unavailable.";
  if (/CDP startup failed|timed out waiting for Chromium CDP/i.test(message)) return "Chromium started but its control channel did not become ready before the timeout.";
  if (/Chromium exited|spawn .*ENOENT|startup failed/i.test(message)) return "Chromium could not be started.";
  if (/agent control is paused|control changed during|sensitive field|not a fillable field|No destination field found/i.test(message)) return message;
  if (/Session not found|sessionId or projectCwd is required/i.test(message)) return message;
  return "Browser operation failed";
}

export type BrowserPublicActor = "ui" | "agent";

export function sanitizeBrowserUrl(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return parsed.protocol;
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return undefined;
  }
}

function sanitizeTitleAgainstUrl(title: string | undefined, activeUrl: string | undefined): string | undefined {
  if (!title) return undefined;
  const titleAsUrl = sanitizeBrowserUrl(title);
  if (titleAsUrl && /^[a-z][a-z0-9+.-]*:/i.test(title)) return titleAsUrl;
  if (!activeUrl) return title;
  try {
    const parsed = new URL(activeUrl);
    let sanitized = title;
    if (parsed.search) sanitized = sanitized.split(parsed.search).join("");
    if (parsed.hash) sanitized = sanitized.split(parsed.hash).join("");
    return sanitized;
  } catch {
    return title;
  }
}

function toPublicRuntimeState(runtime: BrowserRuntime, actor: BrowserPublicActor): BrowserPublicState {
  const state = runtime.state;
  const hideAgentPage = actor === "agent" && (state.controlMode !== "agent" || runtime.credentialInspection.mode === "blocked");
  const actorUrl = actor === "agent" ? sanitizeBrowserUrl(state.activeUrl) : state.activeUrl;
  const actorTitle = actor === "agent" ? sanitizeTitleAgainstUrl(state.activeTitle, state.activeUrl) : state.activeTitle;
  const activeUrl = hideAgentPage ? undefined : actor === "agent"
    ? redactKnownCredentialValues(actorUrl, runtime.credentialInspection.values)
    : actorUrl;
  const activeTitle = hideAgentPage ? undefined : actor === "agent"
    ? redactKnownCredentialValues(actorTitle, runtime.credentialInspection.values)
    : actorTitle;
  return {
    sessionId: state.sessionId,
    projectCwd: state.projectCwd,
    status: state.status,
    controlMode: state.controlMode,
    secretTainted: state.secretTainted,
    localOnlyRecommended: state.localOnlyRecommended,
    needsUser: state.needsUser,
    needsUserReason: state.needsUserReason,
    lastResumeAt: state.lastResumeAt,
    activeUrl,
    activeTitle,
    cdpReady: state.cdpReady,
    viewerTransport: state.viewerTransport,
    viewerWsPath: state.viewerWsPath,
    cdpScreencastWsPath: state.cdpScreencastWsPath,
    vncReady: state.vncReady,
    profile: { persistence: state.profile.persistence },
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    lastError: state.lastError ? sanitizeBrowserErrorMessage(state.lastError) : undefined,
    credentialInspection: runtime.credentialInspection.mode === "none" ? undefined : runtime.credentialInspection.mode,
  };
}

/** UI-only conversion for WebSocket viewers and legacy internal callers. */
export function toPublicBrowserState(state: BrowserSessionState): BrowserPublicState {
  const runtime = runtimes.get(state.key);
  return runtime ? toPublicRuntimeState(runtime, "ui") : {
    sessionId: state.sessionId,
    projectCwd: state.projectCwd,
    status: state.status,
    controlMode: state.controlMode,
    secretTainted: state.secretTainted,
    localOnlyRecommended: state.localOnlyRecommended,
    needsUser: state.needsUser,
    needsUserReason: state.needsUserReason,
    lastResumeAt: state.lastResumeAt,
    activeUrl: state.activeUrl,
    activeTitle: state.activeTitle,
    cdpReady: state.cdpReady,
    viewerTransport: state.viewerTransport,
    viewerWsPath: state.viewerWsPath,
    cdpScreencastWsPath: state.cdpScreencastWsPath,
    vncReady: state.vncReady,
    profile: { persistence: state.profile.persistence },
    startedAt: state.startedAt,
    updatedAt: state.updatedAt,
    lastError: state.lastError ? sanitizeBrowserErrorMessage(state.lastError) : undefined,
  };
}

function getRuntime(lookup: BrowserSessionLookup): BrowserRuntime {
  const state = createInitialState(lookup);
  const existing = runtimes.get(state.key);
  if (existing) {
    if (state.sessionId && !existing.state.sessionId) existing.state.sessionId = state.sessionId;
    return existing;
  }
  const runtime: BrowserRuntime = {
    state,
    child: null,
    xvfbChild: null,
    vncChild: null,
    stopping: false,
    mutationTail: Promise.resolve(),
    credentialInspection: { mode: "none", values: [], allowUsed: false },
  };
  runtimes.set(state.key, runtime);
  return runtime;
}

async function fetchJson<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
  return (await res.json()) as T;
}

async function waitForCdp(port: number): Promise<void> {
  const started = now();
  let lastError = "timed out";
  while (now() - started < STARTUP_TIMEOUT_MS) {
    try {
      await fetchJson(`http://127.0.0.1:${port}/json/version`);
      return;
    } catch (err: any) {
      lastError = err?.message || String(err);
      await sleep(250);
    }
  }
  throw new Error(`Chromium CDP startup failed: ${lastError}`);
}

async function createPageTarget(port: number): Promise<ChromeTarget> {
  const url = `http://127.0.0.1:${port}/json/new?${encodeURIComponent("about:blank")}`;
  try {
    return await fetchJson<ChromeTarget>(url, { method: "PUT" });
  } catch {
    return await fetchJson<ChromeTarget>(url);
  }
}

export function selectPageTarget(targets: ChromeTarget[], activeTargetId?: string, activeUrl?: string): ChromeTarget | undefined {
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  return pages.find((target) => target.id === activeTargetId)
    ?? pages.find((target) => Boolean(activeUrl) && target.url === activeUrl)
    ?? pages.find((target) => target.url !== "about:blank")
    ?? pages[0];
}

async function visiblePageTargetIds(targets: ChromeTarget[]): Promise<string[]> {
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  const visibility = await Promise.all(pages.map(async (target) => {
    let cdp: CdpConnection | null = null;
    try {
      cdp = await CdpConnection.connect(target.webSocketDebuggerUrl!, 1_000);
      const result = await cdp.send<any>("Runtime.evaluate", { expression: "document.visibilityState", returnByValue: true }, 1_000);
      return result?.result?.value === "visible" ? target : undefined;
    } catch {
      return undefined;
    } finally {
      cdp?.close();
    }
  }));
  return visibility.filter((target): target is ChromeTarget => Boolean(target)).map((target) => target.id);
}

export function selectActivePageTarget(
  targets: ChromeTarget[],
  visibleTargetIds: string[],
  activeTargetId?: string,
  activeUrl?: string,
): ChromeTarget | undefined {
  const pages = targets.filter((target) => target.type === "page" && target.webSocketDebuggerUrl);
  const visible = pages.filter((target) => visibleTargetIds.includes(target.id));
  if (visible.length === 1) return visible[0];
  return selectPageTarget(pages, activeTargetId, activeUrl);
}

function clearCredentialInspection(runtime: BrowserRuntime): void {
  runtime.credentialInspection = { mode: "none", values: [], allowUsed: false };
}

export async function getPageTarget(state: BrowserSessionState): Promise<ChromeTarget> {
  if (!state.cdpPort) throw new Error("Browser is not running");
  const targets = await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${state.cdpPort}/json/list`);
  const visibleTargetIds = await visiblePageTargetIds(targets);
  const page = selectActivePageTarget(targets, visibleTargetIds, state.activeTargetId, state.activeUrl)
    ?? await createPageTarget(state.cdpPort);
  if (!page.webSocketDebuggerUrl) throw new Error("Chrome target did not expose a debugger connection");
  state.activeTargetId = page.id;
  state.activeUrl = page.url || state.activeUrl;
  state.activeTitle = page.title || state.activeTitle;
  state.updatedAt = now();
  return page;
}

interface TopLevelDocumentIdentity {
  frameId: string;
  loaderId: string;
  identity: string;
}

async function readTopLevelDocumentIdentity(cdp: CdpConnection): Promise<TopLevelDocumentIdentity> {
  const tree = await cdp.send<any>("Page.getFrameTree");
  const frame = tree?.frameTree?.frame;
  const frameId = typeof frame?.id === "string" ? frame.id : "";
  const loaderId = typeof frame?.loaderId === "string" ? frame.loaderId : "";
  if (!frameId || !loaderId) throw new Error("Top-level document identity is unavailable");
  return { frameId, loaderId, identity: `${frameId}:${loaderId}` };
}

function reconcileCredentialDocumentIdentity(runtime: BrowserRuntime, targetId: string, documentIdentity: string): void {
  const sensitive = runtime.credentialInspection;
  if (sensitive.mode === "none") return;
  if (sensitive.targetId !== targetId || sensitive.documentIdentity !== documentIdentity) clearCredentialInspection(runtime);
}

async function probeRuntimeDocument(runtime: BrowserRuntime): Promise<void> {
  if (runtime.state.status !== "running") return;
  const target = await getPageTarget(runtime.state);
  const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl!);
  try {
    const document = await readTopLevelDocumentIdentity(cdp);
    reconcileCredentialDocumentIdentity(runtime, target.id, document.identity);
  } finally {
    cdp.close();
  }
}

export async function refreshBrowserNavigationState(lookup: BrowserSessionLookup): Promise<void> {
  await probeRuntimeDocument(getRuntime(lookup));
}

export function getBrowserStatus(lookup: BrowserSessionLookup): BrowserSessionState {
  const runtime = getRuntime(lookup);
  return cloneState(runtime.state);
}

export function getPublicBrowserStatus(lookup: BrowserSessionLookup, actor: BrowserPublicActor = "ui"): BrowserPublicState {
  return toPublicRuntimeState(getRuntime(lookup), actor);
}

export function listBrowserSessions(): BrowserSessionState[] {
  return Array.from(runtimes.values()).map((runtime) => cloneState(runtime.state));
}

export function listPublicBrowserSessions(actor: BrowserPublicActor = "ui"): BrowserPublicState[] {
  return Array.from(runtimes.values()).map((runtime) => toPublicRuntimeState(runtime, actor));
}

export function registerBrowserStopHook(hook: () => Promise<void>): () => void {
  browserStopHooks.add(hook);
  return () => browserStopHooks.delete(hook);
}

async function lockBrowserCredentialsForLifecycle(): Promise<void> {
  await Promise.allSettled(Array.from(browserStopHooks, (hook) => hook()));
}

export function assertBrowserAgentControl(lookup: BrowserSessionLookup): number {
  const state = getRuntime(lookup).state;
  if (state.controlMode !== "agent") {
    const error = new Error("Browser agent control is paused");
    (error as Error & { statusCode?: number }).statusCode = 409;
    throw error;
  }
  return state.controlGeneration;
}

export function assertBrowserControlGeneration(lookup: BrowserSessionLookup, generation: number): void {
  const state = getRuntime(lookup).state;
  if (state.controlMode !== "agent" || state.controlGeneration !== generation) {
    const error = new Error("Browser control changed during the operation");
    (error as Error & { statusCode?: number }).statusCode = 409;
    throw error;
  }
}

function agentWorkError(message: string): Error {
  const error = new Error(message);
  (error as Error & { statusCode?: number }).statusCode = 409;
  return error;
}

function assertAgentGeneration(runtime: BrowserRuntime, generation: number | undefined): void {
  if (generation === undefined) return;
  if (runtime.state.controlMode !== "agent" || runtime.state.controlGeneration !== generation) {
    throw agentWorkError("Browser control changed during the operation");
  }
}

function assertAgentWork(runtime: BrowserRuntime, generation: number | undefined, kind: AgentWorkKind): void {
  assertAgentGeneration(runtime, generation);
  if (generation === undefined) return;
  if (runtime.credentialInspection.mode === "blocked") {
    throw agentWorkError("Credential inspection requires explicit UI authorization");
  }
  if (runtime.credentialInspection.mode === "text-allowed" && kind === "inspection-screenshot") {
    throw agentWorkError("Agent screenshots remain blocked after credential fill");
  }
  if (runtime.credentialInspection.mode === "text-allowed" && kind === "mutation") {
    throw agentWorkError("Agent mutations remain blocked after credential fill until document replacement");
  }
}

function regexEscape(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function percentHexInsensitivePattern(value: string): RegExp {
  let pattern = "";
  for (let index = 0; index < value.length;) {
    const triplet = value.slice(index, index + 3);
    if (/^%[0-9a-f]{2}$/i.test(triplet)) {
      pattern += "%";
      for (const digit of triplet.slice(1)) {
        pattern += /[a-f]/i.test(digit) ? `[${digit.toLowerCase()}${digit.toUpperCase()}]` : digit;
      }
      index += 3;
      continue;
    }
    pattern += regexEscape(value[index]);
    index += 1;
  }
  return new RegExp(pattern, "g");
}

function credentialRedactionRepresentations(secret: string): Array<{ value: string; percentHexInsensitive: boolean }> {
  const exact = [
    secret,
    Buffer.from(secret, "utf8").toString("base64"),
    Buffer.from(secret, "utf8").toString("base64url"),
  ];
  const encoded: string[] = [];
  try { encoded.push(encodeURIComponent(secret)); } catch { /* invalid scalar sequence: raw/base64 still apply */ }
  try { encoded.push(encodeURI(secret)); } catch { /* invalid scalar sequence: raw/base64 still apply */ }
  try { encoded.push(new URLSearchParams({ value: secret }).toString().slice("value=".length)); } catch { /* raw/base64 still apply */ }
  return [
    ...exact.map((value) => ({ value, percentHexInsensitive: false })),
    ...encoded.map((value) => ({ value, percentHexInsensitive: true })),
  ].filter((candidate) => candidate.value.length > 0);
}

export function redactKnownCredentialValues<T>(value: T, knownValues: string[]): T {
  const candidates = [...new Map(
    knownValues.filter(Boolean)
      .flatMap(credentialRedactionRepresentations)
      .map((candidate) => [`${candidate.percentHexInsensitive ? "percent" : "exact"}:${candidate.value}`, candidate] as const),
  ).values()].sort((a, b) => b.value.length - a.value.length);
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      let redacted = item;
      for (const candidate of candidates) {
        redacted = candidate.percentHexInsensitive
          ? redacted.replace(percentHexInsensitivePattern(candidate.value), SENSITIVE_VALUE_REDACTION)
          : redacted.split(candidate.value).join(SENSITIVE_VALUE_REDACTION);
      }
      return redacted;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item).map(([key, entry]) => [key, visit(entry)]));
    }
    return item;
  };
  return visit(value) as T;
}

function persistRuntimeState(runtime: BrowserRuntime): void {
  fs.mkdirSync(path.dirname(runtime.state.profile.runtimePath), { recursive: true });
  const { logs: _logs, ...persisted } = runtime.state;
  const safePersisted = redactKnownCredentialValues({
    ...persisted,
    activeUrl: sanitizeBrowserUrl(persisted.activeUrl),
    activeTitle: sanitizeTitleAgainstUrl(persisted.activeTitle, persisted.activeUrl),
  }, runtime.credentialInspection.values);
  fs.writeFileSync(runtime.state.profile.runtimePath, JSON.stringify(safePersisted, null, 2), { mode: 0o600 });
}

async function waitForTcpPort(port: number, timeoutMs = STARTUP_TIMEOUT_MS): Promise<void> {
  const started = now();
  let lastError = "timed out";
  while (now() - started < timeoutMs) {
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = net.createConnection({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve();
        });
        socket.once("error", reject);
        socket.setTimeout(1000, () => {
          socket.destroy(new Error("timeout"));
        });
      });
      return;
    } catch (err: any) {
      lastError = err?.message || String(err);
      await sleep(200);
    }
  }
  throw new Error(`TCP port ${port} did not become ready: ${lastError}`);
}

async function allocateDisplay(): Promise<string> {
  for (let i = 0; i < 50; i++) {
    const displayNumber = 90 + Math.floor(Math.random() * 200);
    const socketPath = `/tmp/.X11-unix/X${displayNumber}`;
    if (!fs.existsSync(socketPath)) return `:${displayNumber}`;
  }
  throw new Error("Failed to allocate X display number");
}

function terminateChild(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
    else child.kill("SIGTERM");
  } catch {
    try { child.kill("SIGTERM"); } catch {}
  }
}

function killChild(child: ChildProcess | null): void {
  if (!child || child.exitCode !== null || child.killed) return;
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch {}
  }
}

export function getBrowserVncPort(lookup: BrowserSessionLookup): number {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running" || !runtime.state.vncReady || !runtime.state.vncPort) {
    throw new Error("VNC viewer is not running");
  }
  return runtime.state.vncPort;
}

export async function startBrowser(lookup: BrowserSessionLookup, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  const state = runtime.state;
  assertAgentGeneration(runtime, expectedControlGeneration);
  if (state.status === "running") await probeRuntimeDocument(runtime);
  assertAgentWork(runtime, expectedControlGeneration, "mutation");
  if (state.status === "running" && runtime.child && runtime.child.exitCode === null) {
    assertAgentWork(runtime, expectedControlGeneration, "mutation");
    return cloneState(state);
  }
  if (state.status === "starting") return cloneState(state);

  fs.mkdirSync(state.profile.profileDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(state.profile.downloadsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(state.profile.artifactsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(state.profile.runtimePath), { recursive: true, mode: 0o700 });

  runtime.stopping = false;
  const executable = findChromiumExecutable();
  const cdpPort = await allocatePort();
  const useVnc = canUseVncTransport();
  const viewerTransport = selectedViewerTransport(useVnc);
  const display = useVnc ? await allocateDisplay() : undefined;
  const vncPort = useVnc ? await allocatePort() : undefined;

  state.status = "starting";
  state.cdpReady = false;
  state.cdpPort = cdpPort;
  state.vncReady = false;
  state.vncPort = vncPort;
  state.display = display;
  state.viewerTransport = viewerTransport;
  state.viewerWsPath = viewerTransport === "vnc"
    ? `/ws/browser-vnc?${new URLSearchParams(state.sessionId ? { session_id: state.sessionId } : { project_cwd: state.projectCwd }).toString()}`
    : state.cdpScreencastWsPath;
  state.lastError = undefined;
  state.startedAt = now();
  state.updatedAt = now();
  appendLog(runtime, `starting ${executable} on CDP port ${cdpPort}${useVnc ? ` with VNC display ${display} port ${vncPort}` : " headless"}`);
  persistRuntimeState(runtime);

  try {
    assertAgentWork(runtime, expectedControlGeneration, "mutation");
    if (useVnc && display && vncPort) {
      const xvfbExecutable = executableOnPath("Xvfb");
      const vncExecutable = executableOnPath("x11vnc");
      if (!xvfbExecutable || !vncExecutable) throw new Error("VNC transport dependencies disappeared during startup");
      const xvfb = spawn(xvfbExecutable, [display, "-screen", "0", "1280x720x24", "-nolisten", "tcp", "-ac"], {
        cwd: state.projectCwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: browserChildEnvironment(),
      });
      runtime.xvfbChild = xvfb;
      xvfb.stdout?.on("data", (chunk) => appendChunk(runtime, chunk));
      xvfb.stderr?.on("data", (chunk) => appendChunk(runtime, chunk));
      xvfb.on("exit", (code, signal) => {
        appendLog(runtime, `Xvfb exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        if (!runtime.stopping && state.status === "running") {
          state.status = "errored";
          state.vncReady = false;
          state.lastError = `Xvfb exited code=${code ?? "null"} signal=${signal ?? "null"}`;
          persistRuntimeState(runtime);
        }
      });
      await sleep(500);

      const vnc = spawn(vncExecutable, [
        "-display", display,
        "-localhost",
        "-nopw",
        "-forever",
        "-shared",
        "-rfbport", String(vncPort),
        "-wait", "8",
        "-defer", "8",
        "-threads",
        "-quiet",
      ], {
        cwd: state.projectCwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
        shell: false,
        env: browserChildEnvironment(),
      });
      runtime.vncChild = vnc;
      vnc.stdout?.on("data", (chunk) => appendChunk(runtime, chunk));
      vnc.stderr?.on("data", (chunk) => appendChunk(runtime, chunk));
      vnc.on("exit", (code, signal) => {
        appendLog(runtime, `x11vnc exited code=${code ?? "null"} signal=${signal ?? "null"}`);
        state.vncReady = false;
        if (!runtime.stopping && state.status === "running") {
          state.status = "errored";
          state.lastError = `x11vnc exited code=${code ?? "null"} signal=${signal ?? "null"}`;
          persistRuntimeState(runtime);
        }
      });
      await waitForTcpPort(vncPort, 10_000);
      state.vncReady = true;
    }

    const args = [
      `--remote-debugging-address=127.0.0.1`,
      `--remote-debugging-port=${cdpPort}`,
      `--user-data-dir=${state.profile.profileDir}`,
      `--window-size=1280,720`,
      "--disable-dev-shm-usage",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      `--download-default-directory=${state.profile.downloadsDir}`,
      ...(useVnc ? [] : ["--headless=new"]),
      "about:blank",
    ];

    const child = spawn(executable, args, {
      cwd: state.projectCwd,
      detached: process.platform !== "win32",
      env: browserChildEnvironment(display ? { DISPLAY: display } : {}),
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });
    runtime.child = child;

    child.stdout?.on("data", (chunk) => appendChunk(runtime, chunk));
    child.stderr?.on("data", (chunk) => appendChunk(runtime, chunk));
    child.on("exit", (code, signal) => {
      appendLog(runtime, `chromium exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      state.status = runtime.stopping ? "stopped" : "errored";
      state.cdpReady = false;
      state.cdpPort = undefined;
      if (!runtime.stopping) state.lastError = `Chromium exited code=${code ?? "null"} signal=${signal ?? "null"}`;
      state.updatedAt = now();
      persistRuntimeState(runtime);
    });

    await waitForCdp(cdpPort);
    await getPageTarget(state);
    state.status = "running";
    state.cdpReady = true;
    state.updatedAt = now();
    appendLog(runtime, `chromium CDP ready; viewer transport=${state.viewerTransport}`);
    persistRuntimeState(runtime);
    assertAgentWork(runtime, expectedControlGeneration, "mutation");
    return cloneState(state);
  } catch (err: any) {
    state.status = "errored";
    state.cdpReady = false;
    state.vncReady = false;
    state.lastError = err?.message || String(err);
    appendLog(runtime, `startup failed: ${state.lastError}`);
    await stopBrowser(lookup);
    if (err && typeof err === "object" && (err as { statusCode?: number }).statusCode === 409) throw err;
    state.status = "errored";
    state.lastError = err?.message || String(err);
    persistRuntimeState(runtime);
    return cloneState(state);
  }
}

export async function stopBrowser(lookup: BrowserSessionLookup, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  assertAgentGeneration(runtime, expectedControlGeneration);
  if (runtime.state.status === "running") await probeRuntimeDocument(runtime);
  assertAgentWork(runtime, expectedControlGeneration, "mutation");
  await lockBrowserCredentialsForLifecycle();
  clearCredentialInspection(runtime);
  assertAgentWork(runtime, expectedControlGeneration, "mutation");
  runtime.stopping = true;
  const children = [runtime.child, runtime.vncChild, runtime.xvfbChild];
  for (const child of children) terminateChild(child);
  await Promise.race([
    Promise.all(children.filter(Boolean).map((child) => new Promise<void>((resolve) => {
      if (!child || child.exitCode !== null || child.killed) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
    }))).then(() => undefined),
    sleep(3_000).then(() => {
      for (const child of children) killChild(child);
    }),
  ]);
  runtime.child = null;
  runtime.vncChild = null;
  runtime.xvfbChild = null;
  runtime.state.status = "stopped";
  runtime.state.cdpReady = false;
  runtime.state.cdpPort = undefined;
  runtime.state.vncReady = false;
  runtime.state.vncPort = undefined;
  runtime.state.display = undefined;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  assertAgentWork(runtime, expectedControlGeneration, "mutation");
  return cloneState(runtime.state);
}

export async function restartBrowser(lookup: BrowserSessionLookup, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  await stopBrowser(lookup, expectedControlGeneration);
  return startBrowser(lookup, expectedControlGeneration);
}

export async function resetBrowserProfile(lookup: BrowserSessionLookup, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  await stopBrowser(lookup, expectedControlGeneration);
  const profileDir = runtime.state.profile.profileDir;
  if (fs.existsSync(profileDir)) {
    const trashDir = path.join(runtime.state.profile.rootDir, "profile-trash");
    fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
    const target = path.join(trashDir, `${runtime.state.key}-${new Date().toISOString().replace(/[:.]/g, "-")}`);
    fs.renameSync(profileDir, target);
    appendLog(runtime, `moved profile to ${target}`);
  }
  runtime.state.activeUrl = undefined;
  runtime.state.activeTitle = undefined;
  runtime.state.needsUser = false;
  runtime.state.needsUserReason = undefined;
  persistRuntimeState(runtime);
  assertAgentWork(runtime, expectedControlGeneration, "mutation");
  return cloneState(runtime.state);
}

export function setBrowserControlMode(lookup: BrowserSessionLookup, mode: BrowserControlMode, reason?: string): BrowserSessionState {
  const runtime = getRuntime(lookup);
  if (mode === "agent" && runtime.credentialInspection.mode !== "none") {
    throw agentWorkError("Credential inspection must be authorized through the UI-only credential route");
  }
  if (runtime.state.controlMode !== mode) runtime.state.controlGeneration += 1;
  runtime.state.controlMode = mode;
  runtime.state.needsUser = mode === "user" || mode === "paused";
  runtime.state.needsUserReason = runtime.state.needsUser ? reason : undefined;
  if (mode === "agent") runtime.state.lastResumeAt = now();
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return cloneState(runtime.state);
}

export function recordBrowserCredentialFill(
  lookup: BrowserSessionLookup,
  context: BrowserCredentialContext,
  values: { username?: string; password?: string; totp?: string },
): BrowserSessionState {
  const runtime = getRuntime(lookup);
  const knownValues = [values.username, values.password, values.totp].filter((value): value is string => typeof value === "string" && value.length > 0);
  const sameDocument = runtime.credentialInspection.targetId === context.targetId &&
    runtime.credentialInspection.documentIdentity === context.documentIdentity;
  runtime.credentialInspection = {
    mode: "blocked",
    values: [...new Set([...(sameDocument ? runtime.credentialInspection.values : []), ...knownValues])],
    targetId: context.targetId,
    documentIdentity: context.documentIdentity,
    allowUsed: false,
  };
  if (runtime.state.controlMode !== "user") runtime.state.controlGeneration += 1;
  runtime.state.controlMode = "user";
  runtime.state.needsUser = true;
  runtime.state.needsUserReason = "Credential values were filled; agent inspection is blocked";
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return cloneState(runtime.state);
}

export async function allowAgentAfterCredentialFill(lookup: BrowserSessionLookup): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status === "running") await probeRuntimeDocument(runtime);
  if (runtime.credentialInspection.mode !== "blocked" || runtime.credentialInspection.allowUsed) {
    throw agentWorkError("Credential inspection authorization is unavailable or already used");
  }
  runtime.credentialInspection.mode = "text-allowed";
  runtime.credentialInspection.allowUsed = true;
  runtime.state.controlGeneration += 1;
  runtime.state.controlMode = "agent";
  runtime.state.needsUser = false;
  runtime.state.needsUserReason = undefined;
  runtime.state.lastResumeAt = now();
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return cloneState(runtime.state);
}

async function serializeRuntimeMutation<T>(runtime: BrowserRuntime, action: () => Promise<T>): Promise<T> {
  const previous = runtime.mutationTail;
  let release!: () => void;
  runtime.mutationTail = new Promise<void>((resolve) => { release = resolve; });
  await previous.catch(() => undefined);
  try {
    return await action();
  } finally {
    release();
  }
}

async function withCdp<T>(
  state: BrowserSessionState,
  fn: (cdp: CdpConnection) => Promise<T>,
  expectedControlGeneration?: number,
  kind: AgentWorkKind = "inspection-text",
): Promise<T> {
  const runtime = runtimes.get(state.key) ?? getRuntime({ projectCwd: state.projectCwd, sessionId: state.sessionId, persistence: state.profile.persistence });
  assertAgentGeneration(runtime, expectedControlGeneration);
  const target = await getPageTarget(state);
  assertAgentGeneration(runtime, expectedControlGeneration);
  const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl!);
  try {
    const beforeDocument = await readTopLevelDocumentIdentity(cdp);
    reconcileCredentialDocumentIdentity(runtime, target.id, beforeDocument.identity);
    assertAgentWork(runtime, expectedControlGeneration, kind);
    const result = await fn(cdp);
    const afterDocument = await readTopLevelDocumentIdentity(cdp);
    reconcileCredentialDocumentIdentity(runtime, target.id, afterDocument.identity);
    assertAgentWork(runtime, expectedControlGeneration, kind);
    return expectedControlGeneration === undefined
      ? result
      : redactKnownCredentialValues(result, runtime.credentialInspection.values);
  } finally {
    cdp.close();
  }
}

export async function navigateBrowser(lookup: BrowserSessionLookup, url: string, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  const normalizedUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
  return serializeRuntimeMutation(runtime, async () => {
    if (expectedControlGeneration !== undefined) assertBrowserControlGeneration(lookup, expectedControlGeneration);
    await withCdp(runtime.state, async (cdp) => {
      await cdp.send("Page.enable");
      await cdp.send("Runtime.enable");
      let finishLoad!: () => void;
      const loaded = new Promise<void>((resolve) => {
        const off = cdp.on("Page.loadEventFired", () => finishLoad());
        const timer = setTimeout(() => finishLoad(), 10_000);
        timer.unref?.();
        finishLoad = () => {
          clearTimeout(timer);
          off();
          resolve();
        };
      });
      const navigation = await cdp.send<any>("Page.navigate", { url: normalizedUrl });
      if (navigation?.loaderId) await loaded;
      else finishLoad();
      if (expectedControlGeneration !== undefined) assertBrowserControlGeneration(lookup, expectedControlGeneration);
      const info = await cdp.send<any>("Runtime.evaluate", {
        expression: domHelpersExpression("return { url: __wayangRedact(location.href), title: __wayangRedact(document.title) };") ,
        returnByValue: true,
      });
      const value = info?.result?.value ?? {};
      runtime.state.activeUrl = value.url || normalizedUrl;
      runtime.state.activeTitle = value.title || runtime.state.activeTitle;
    }, expectedControlGeneration, "mutation");
    assertAgentWork(runtime, expectedControlGeneration, "mutation");
    runtime.state.updatedAt = now();
    persistRuntimeState(runtime);
    return cloneState(runtime.state);
  });
}

export async function browserSnapshot(
  lookup: BrowserSessionLookup,
  mode: "text" | "screenshot" = "text",
  expectedControlGeneration?: number,
): Promise<BrowserSnapshot> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  return withCdp(runtime.state, async (cdp) => {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const info = await cdp.send<any>("Runtime.evaluate", {
      expression: domHelpersExpression("return { url: __wayangRedact(location.href), title: __wayangRedact(document.title), text: document.body ? __wayangRedact(document.body.innerText || '') : '' };") ,
      returnByValue: true,
    });
    const value = info?.result?.value ?? {};
    runtime.state.activeUrl = value.url || runtime.state.activeUrl;
    runtime.state.activeTitle = value.title || runtime.state.activeTitle;
    runtime.state.updatedAt = now();
    persistRuntimeState(runtime);
    if (mode === "screenshot") {
      const shot = await cdp.send<any>("Page.captureScreenshot", { format: "jpeg", quality: 80, fromSurface: true });
      return { url: value.url || "", title: value.title || "", screenshot: shot?.data ? `data:image/jpeg;base64,${shot.data}` : undefined };
    }
    return { url: value.url || "", title: value.title || "", text: String(value.text || "").slice(0, 50_000) };
  }, expectedControlGeneration, mode === "screenshot" ? "inspection-screenshot" : "inspection-text");
}

export const SENSITIVE_VALUE_REDACTION = "[REDACTED]";

const SENSITIVE_FIELD_PATTERN = /(?:pass(?:word|code)?|otp|totp|one[ _-]?time|verification|auth(?:entication)?[ _-]?code|recovery|secret|card(?:[ _-]?(?:number|no))?|cc[ _-]?(?:number|num|csc|cvc|cvv)|cvc|cvv|security[ _-]?code|pin)/i;
const SENSITIVE_AUTOCOMPLETE_PATTERN = /(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)/i;

export function isSensitiveFieldDescriptor(field: { type?: unknown; name?: unknown; id?: unknown; autocomplete?: unknown; placeholder?: unknown; ariaLabel?: unknown }): boolean {
  if (String(field.type || "").toLowerCase() === "password") return true;
  if (SENSITIVE_AUTOCOMPLETE_PATTERN.test(String(field.autocomplete || ""))) return true;
  return SENSITIVE_FIELD_PATTERN.test([field.name, field.id, field.placeholder, field.ariaLabel].map((value) => String(value || "")).join(" "));
}

const DOM_HELPERS_SCRIPT = String.raw`
function __wayangSensitive(el) {
  const type = String(el.getAttribute("type") || "").toLowerCase();
  const autocomplete = String(el.getAttribute("autocomplete") || "");
  const identity = [el.id, el.getAttribute("name"), el.getAttribute("placeholder"), el.getAttribute("aria-label")].filter(Boolean).join(" ");
  return type === "password" || /(?:current-password|new-password|one-time-code|cc-number|cc-csc|cc-exp|cc-exp-month|cc-exp-year)/i.test(autocomplete) || /(?:pass(?:word|code)?|otp|totp|one[ _-]?time|verification|auth(?:entication)?[ _-]?code|recovery|secret|card(?:[ _-]?(?:number|no))?|cc[ _-]?(?:number|num|csc|cvc|cvv)|cvc|cvv|security[ _-]?code|pin)/i.test(identity);
}
function __wayangSensitiveValues() {
  return Array.from(document.querySelectorAll("input,textarea,select,[contenteditable='true']")).filter(__wayangSensitive).map((el) => String(el.value || el.textContent || "")).filter(Boolean);
}
function __wayangRedact(value) {
  let text = String(value == null ? "" : value);
  for (const secret of __wayangSensitiveValues()) text = text.split(secret).join("[REDACTED]");
  return text;
}
function __wayangVisible(el) {
  const rect = el.getBoundingClientRect();
  if (!rect || rect.width <= 0 || rect.height <= 0) return false;
  const style = window.getComputedStyle(el);
  if (!style || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
  return rect.bottom >= 0 && rect.right >= 0 && rect.top <= window.innerHeight && rect.left <= window.innerWidth;
}
function __wayangCssEscape(value) {
  if (window.CSS && typeof window.CSS.escape === "function") return window.CSS.escape(String(value));
  return String(value).replace(/[^a-zA-Z0-9_-]/g, "\\$&");
}
function __wayangAttrEscape(value) {
  return String(value).replace(/\\/g, "\\\\").replace(/"/g, "\\\"");
}
function __wayangSelector(el) {
  if (!(el instanceof Element)) return "";
  if (el.id) return "#" + __wayangCssEscape(el.id);
  const parts = [];
  let node = el;
  while (node && node.nodeType === Node.ELEMENT_NODE && node !== document.documentElement) {
    const tag = node.localName.toLowerCase();
    let part = tag;
    let attrName = "";
    let attrValue = "";
    for (const name of ["data-testid", "data-test", "aria-label", "name"]) {
      const value = node.getAttribute(name);
      if (value) {
        attrName = name;
        attrValue = value;
        break;
      }
    }
    if (attrName) part += "[" + attrName + "=\"" + __wayangAttrEscape(attrValue) + "\"]";
    const parent = node.parentElement;
    if (parent) {
      const siblings = Array.from(parent.children).filter((child) => child.localName === node.localName);
      if (siblings.length > 1) part += ":nth-of-type(" + (siblings.indexOf(node) + 1) + ")";
    }
    parts.unshift(part);
    const selector = parts.join(" > ");
    try {
      if (document.querySelectorAll(selector).length === 1) return selector;
    } catch {}
    node = parent;
  }
  return parts.join(" > ") || el.localName.toLowerCase();
}
function __wayangText(el) {
  if (__wayangSensitive(el)) return "[REDACTED]";
  const raw = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    ? el.value
    : (el.innerText || el.textContent || "");
  return __wayangRedact(raw).replace(/\s+/g, " ").trim().slice(0, 500);
}
function __wayangName(el) {
  const labels = el.id ? Array.from(document.querySelectorAll("label[for=\"" + __wayangAttrEscape(el.id) + "\"]")).map((label) => label.textContent || "") : [];
  return String(
    el.getAttribute("aria-label") ||
    el.getAttribute("title") ||
    el.getAttribute("alt") ||
    el.getAttribute("placeholder") ||
    labels.join(" ") ||
    __wayangText(el) ||
    el.getAttribute("name") ||
    ""
  ).replace(/\s+/g, " ").trim().slice(0, 500);
}
function __wayangRole(el) {
  const explicit = el.getAttribute("role");
  if (explicit) return explicit;
  const tag = el.localName.toLowerCase();
  if (tag === "a") return "link";
  if (tag === "button") return "button";
  if (["input", "textarea", "select"].includes(tag)) return "field";
  if (/^h[1-6]$/.test(tag)) return "heading";
  if (tag === "summary") return "summary";
  return undefined;
}
function __wayangElementInfo(el, index) {
  const rect = el.getBoundingClientRect();
  return {
    index,
    selector: __wayangSelector(el),
    tag: el.localName.toLowerCase(),
    role: __wayangRole(el),
    type: el.getAttribute("type") || undefined,
    name: __wayangName(el) || undefined,
    text: __wayangText(el) || undefined,
    value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? (__wayangSensitive(el) && el.value ? "[REDACTED]" : String(el.value || "").slice(0, 500)) : undefined,
    href: el instanceof HTMLAnchorElement ? __wayangRedact(el.href) : undefined,
    placeholder: el.getAttribute("placeholder") || undefined,
    checked: el instanceof HTMLInputElement && ["checkbox", "radio"].includes(el.type) ? el.checked : undefined,
    disabled: "disabled" in el ? Boolean(el.disabled) : undefined,
    rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
  };
}
`;

function domHelpersExpression(body: string): string {
  return `(() => { ${DOM_HELPERS_SCRIPT}\n${body}\n})()`;
}

function sanitizeLimit(limit: number | undefined, fallback: number, max: number): number {
  if (!Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(max, Math.floor(Number(limit))));
}

async function evaluatePage<T>(
  state: BrowserSessionState,
  expression: string,
  expectedControlGeneration?: number,
  kind: AgentWorkKind = "inspection-text",
): Promise<T> {
  return withCdp(state, async (cdp) => {
    await cdp.send("Runtime.enable");
    const info = await cdp.send<any>("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (info?.exceptionDetails) {
      const details = info.exceptionDetails;
      const message = details.exception?.description || details.exception?.value || details.text || "Browser evaluation failed";
      throw new Error(String(message));
    }
    return info?.result?.value as T;
  }, expectedControlGeneration, kind);
}

export async function browserDomSnapshot(
  lookup: BrowserSessionLookup,
  options: { includeText?: boolean; limit?: number } = {},
  expectedControlGeneration?: number,
): Promise<BrowserDomSnapshot> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  const limit = sanitizeLimit(options.limit, 80, 300);
  const includeText = Boolean(options.includeText);
  const snapshot = await evaluatePage<BrowserDomSnapshot>(runtime.state, domHelpersExpression(`
    const selector = "a,button,input,textarea,select,[role],[onclick],[contenteditable='true'],summary,label,h1,h2,h3,h4,h5,h6";
    const candidates = Array.from(document.querySelectorAll(selector)).filter(__wayangVisible).slice(0, ${limit});
    return {
      url: __wayangRedact(location.href),
      title: __wayangRedact(document.title),
      text: ${includeText} && document.body ? __wayangRedact(document.body.innerText || "").slice(0, 50000) : undefined,
      elements: candidates.map((el, index) => __wayangElementInfo(el, index)),
    };
  `), expectedControlGeneration, "inspection-text");
  runtime.state.activeUrl = snapshot.url || runtime.state.activeUrl;
  runtime.state.activeTitle = snapshot.title || runtime.state.activeTitle;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return snapshot;
}

export async function queryBrowserSelector(
  lookup: BrowserSessionLookup,
  selector: string,
  options: { limit?: number } = {},
  expectedControlGeneration?: number,
): Promise<BrowserSelectorQueryResult> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  const limit = sanitizeLimit(options.limit, 25, 200);
  const snapshot = await evaluatePage<BrowserSelectorQueryResult>(runtime.state, domHelpersExpression(`
    const selector = ${JSON.stringify(selector)};
    const elements = Array.from(document.querySelectorAll(selector)).slice(0, ${limit});
    return {
      url: __wayangRedact(location.href),
      title: __wayangRedact(document.title),
      selector,
      elements: elements.map((el, index) => __wayangElementInfo(el, index)),
    };
  `), expectedControlGeneration, "inspection-text");
  runtime.state.activeUrl = snapshot.url || runtime.state.activeUrl;
  runtime.state.activeTitle = snapshot.title || runtime.state.activeTitle;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return snapshot;
}

async function getSelectorClickPoint(state: BrowserSessionState, selector: string, index: number, expectedControlGeneration?: number): Promise<{ x: number; y: number; url: string; title: string }> {
  return evaluatePage(state, domHelpersExpression(`
    const selector = ${JSON.stringify(selector)};
    const index = ${Math.max(0, Math.floor(index || 0))};
    const elements = Array.from(document.querySelectorAll(selector));
    const el = elements[index];
    if (!el) throw new Error(` + "`No element found for selector ${selector} at index ${index}`" + `);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, url: __wayangRedact(location.href), title: __wayangRedact(document.title) };
  `), expectedControlGeneration, "mutation");
}

export async function clickBrowserSelector(lookup: BrowserSessionLookup, selector: string, index = 0, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  return serializeRuntimeMutation(runtime, async () => {
    assertAgentGeneration(runtime, expectedControlGeneration);
    const point = await getSelectorClickPoint(runtime.state, selector, index, expectedControlGeneration);
    await withCdp(runtime.state, async (cdp) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
    }, expectedControlGeneration, "mutation");
    assertAgentWork(runtime, expectedControlGeneration, "mutation");
    runtime.state.activeUrl = point.url || runtime.state.activeUrl;
    runtime.state.activeTitle = point.title || runtime.state.activeTitle;
    runtime.state.updatedAt = now();
    persistRuntimeState(runtime);
    return cloneState(runtime.state);
  });
}

async function assertPublicFillTarget(state: BrowserSessionState, selector?: string, index = 0, expectedControlGeneration?: number): Promise<void> {
  const descriptor = await evaluatePage<{ sensitive: boolean; fillable: boolean }>(state, domHelpersExpression(`
    const selector = ${selector === undefined ? "null" : JSON.stringify(selector)};
    const index = ${Math.max(0, Math.floor(index || 0))};
    const el = selector === null ? document.activeElement : Array.from(document.querySelectorAll(selector))[index];
    if (!el) throw new Error("No destination field found");
    return {
      sensitive: __wayangSensitive(el),
      fillable: !el.disabled && !el.readOnly && (el.isContentEditable || el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement),
    };
  `), expectedControlGeneration, "mutation");
  if (!descriptor.fillable) throw new Error("Destination is not a fillable field");
  if (descriptor.sensitive) {
    const error = new Error("Public text cannot be filled into a sensitive field");
    (error as Error & { statusCode?: number }).statusCode = 409;
    throw error;
  }
}

export async function fillBrowserSelector(lookup: BrowserSessionLookup, selector: string, text: string, index = 0, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  return serializeRuntimeMutation(runtime, async () => {
    assertAgentGeneration(runtime, expectedControlGeneration);
    await assertPublicFillTarget(runtime.state, selector, index, expectedControlGeneration);
    const result = await evaluatePage<{ url: string; title: string }>(runtime.state, domHelpersExpression(`
    const selector = ${JSON.stringify(selector)};
    const text = ${JSON.stringify(text)};
    const index = ${Math.max(0, Math.floor(index || 0))};
    const elements = Array.from(document.querySelectorAll(selector));
    const el = elements[index];
    if (!el) throw new Error(` + "`No element found for selector ${selector} at index ${index}`" + `);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    if (el.isContentEditable) {
      el.textContent = text;
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const descriptor = Object.getOwnPropertyDescriptor(proto, "value");
      if (descriptor?.set) descriptor.set.call(el, text);
      else el.value = text;
    } else if (el instanceof HTMLSelectElement) {
      el.value = text;
    } else {
      throw new Error(` + "`Element ${selector} is not a fillable input, textarea, select, or contenteditable element`" + `);
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { url: __wayangRedact(location.href), title: __wayangRedact(document.title) };
  `), expectedControlGeneration, "mutation");
    assertAgentWork(runtime, expectedControlGeneration, "mutation");
    runtime.state.activeUrl = result.url || runtime.state.activeUrl;
    runtime.state.activeTitle = result.title || runtime.state.activeTitle;
    runtime.state.updatedAt = now();
    persistRuntimeState(runtime);
    return cloneState(runtime.state);
  });
}

export async function extractBrowserLinks(lookup: BrowserSessionLookup, options: { limit?: number } = {}, expectedControlGeneration?: number): Promise<BrowserLinksResult> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  const limit = sanitizeLimit(options.limit, 100, 500);
  const result = await evaluatePage<BrowserLinksResult>(runtime.state, domHelpersExpression(`
    const links = Array.from(document.querySelectorAll("a[href]")).slice(0, ${limit}).map((el, index) => ({
      index,
      text: __wayangText(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "",
      href: __wayangRedact(el.href),
      selector: __wayangSelector(el),
      visible: __wayangVisible(el),
    }));
    return { url: __wayangRedact(location.href), title: __wayangRedact(document.title), links };
  `), expectedControlGeneration, "inspection-text");
  runtime.state.activeUrl = result.url || runtime.state.activeUrl;
  runtime.state.activeTitle = result.title || runtime.state.activeTitle;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return result;
}

export function redactSensitiveValue(value: unknown, sensitiveValues: string[] = [], sensitiveContext = false): string | undefined {
  if (value === undefined || value === null) return undefined;
  let text = String(value);
  if (sensitiveContext && text) return SENSITIVE_VALUE_REDACTION;
  for (const secret of sensitiveValues) {
    if (secret) text = text.split(secret).join(SENSITIVE_VALUE_REDACTION);
  }
  return text;
}

export async function browserAccessibilitySnapshot(lookup: BrowserSessionLookup, options: { limit?: number } = {}, expectedControlGeneration?: number): Promise<BrowserAccessibilitySnapshot> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  const limit = sanitizeLimit(options.limit, 120, 500);
  return withCdp(runtime.state, async (cdp) => {
    await cdp.send("Accessibility.enable");
    const info = await cdp.send<any>("Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const page = info?.result?.value ?? {};
    const sensitiveResult = await cdp.send<any>("Runtime.evaluate", {
      expression: `(() => { ${DOM_HELPERS_SCRIPT}\nreturn Array.from(document.querySelectorAll("input,textarea,select,[contenteditable='true']")).filter(__wayangSensitive).map((el) => String(el.value || el.textContent || "")).filter(Boolean).slice(0, 100); })()`,
      returnByValue: true,
    });
    const sensitiveValues = Array.isArray(sensitiveResult?.result?.value)
      ? sensitiveResult.result.value.map((value: unknown) => String(value)).filter(Boolean)
      : [];
    const tree = await cdp.send<any>("Accessibility.getFullAXTree");
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const simplified = nodes
      .filter((node: any) => !node.ignored)
      .map((node: any) => {
        const name = redactSensitiveValue(node.name?.value, sensitiveValues);
        const sensitiveContext = SENSITIVE_FIELD_PATTERN.test(name || "");
        return {
          role: node.role?.value,
          name,
          value: redactSensitiveValue(node.value?.value, sensitiveValues, sensitiveContext),
          description: redactSensitiveValue(node.description?.value, sensitiveValues),
          ignored: node.ignored,
        };
      })
      .filter((node: any) => node.role || node.name || node.value || node.description)
      .slice(0, limit);
    const safeUrl = redactSensitiveValue(page.url, sensitiveValues) || "";
    const safeTitle = redactSensitiveValue(page.title, sensitiveValues) || "";
    runtime.state.activeUrl = safeUrl || runtime.state.activeUrl;
    runtime.state.activeTitle = safeTitle || runtime.state.activeTitle;
    runtime.state.updatedAt = now();
    persistRuntimeState(runtime);
    return { url: safeUrl, title: safeTitle, nodes: simplified };
  }, expectedControlGeneration, "inspection-text");
}

export async function clickBrowser(lookup: BrowserSessionLookup, x: number, y: number, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  return serializeRuntimeMutation(runtime, async () => {
    assertAgentGeneration(runtime, expectedControlGeneration);
    await withCdp(runtime.state, async (cdp) => {
      await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
      await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
    }, expectedControlGeneration, "mutation");
    assertAgentWork(runtime, expectedControlGeneration, "mutation");
    return cloneState(runtime.state);
  });
}

async function insertTextIntoBrowser(lookup: BrowserSessionLookup, text: string, publicOnly = false, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup, expectedControlGeneration);
  return serializeRuntimeMutation(runtime, async () => {
    assertAgentGeneration(runtime, expectedControlGeneration);
    if (publicOnly) await assertPublicFillTarget(runtime.state, undefined, 0, expectedControlGeneration);
    await withCdp(runtime.state, async (cdp) => {
      await cdp.send("Input.insertText", { text });
    }, expectedControlGeneration, "mutation");
    assertAgentWork(runtime, expectedControlGeneration, "mutation");
    runtime.state.updatedAt = now();
    persistRuntimeState(runtime);
    return cloneState(runtime.state);
  });
}

export async function typePublicBrowser(lookup: BrowserSessionLookup, text: string, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  return insertTextIntoBrowser(lookup, text, true, expectedControlGeneration);
}

export interface BrowserCredentialContext {
  runtimeKey: string;
  targetId: string;
  documentIdentity: string;
  url: string;
  origin: string;
  /** Present only for the capability-bound Protected broker path. */
  capabilityBinding?: import("./types.js").ProtectedBrowserBinding;
}

export async function getBrowserCredentialContext(lookup: BrowserSessionLookup): Promise<BrowserCredentialContext> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") throw new Error("Browser is not running");
  const target = await getPageTarget(runtime.state);
  const page = await withCdp(runtime.state, async (cdp) => {
    const info = await cdp.send<any>("Runtime.evaluate", {
      expression: "({ url: location.href, origin: location.origin })",
      returnByValue: true,
    });
    const document = await readTopLevelDocumentIdentity(cdp);
    return { ...(info?.result?.value ?? {}), documentIdentity: document.identity };
  });
  const url = String(page.url || target.url || "");
  const origin = String(page.origin || "");
  if (!url || !origin || origin === "null") throw new Error("Current page does not have a credential-safe origin");
  runtime.state.activeTargetId = target.id;
  runtime.state.activeUrl = url;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return { runtimeKey: runtime.state.key, targetId: target.id, documentIdentity: String(page.documentIdentity), url, origin };
}

export async function fillBrowserCredential(
  lookup: BrowserSessionLookup,
  values: { username?: string; password?: string; totp?: string },
  expected?: BrowserCredentialContext,
): Promise<Array<"username" | "password" | "totp">> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") throw new Error("Browser is not running");
  return serializeRuntimeMutation(runtime, () => withCdp(runtime.state, async (cdp) => {
    if (expected) {
      const current = await cdp.send<any>("Runtime.evaluate", {
        expression: "({ url: location.href, origin: location.origin })",
        returnByValue: true,
      });
      const page = current?.result?.value ?? {};
      const document = await readTopLevelDocumentIdentity(cdp);
      if (runtime.state.key !== expected.runtimeKey || runtime.state.activeTargetId !== expected.targetId || document.identity !== expected.documentIdentity || page.origin !== expected.origin) {
        throw new Error("Credential choice is no longer valid for this page");
      }
    }
    const documentResult = await cdp.send<any>("Runtime.evaluate", { expression: "document", returnByValue: false });
    const objectId = documentResult?.result?.objectId;
    if (!objectId) throw new Error("Credential fill could not access the page");
    const result = await cdp.send<any>("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: `function(values) {
        const eligible = (el) => {
          if (el.disabled || el.readOnly || (el instanceof HTMLInputElement && el.type === "hidden")) return false;
          const rect = el.getBoundingClientRect();
          const style = getComputedStyle(el);
          if (rect.width <= 0 || rect.height <= 0 || style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
          return typeof el.checkVisibility !== "function" || el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
        };
        const identity = (el) => [el.id, el.name, el.placeholder, el.getAttribute("aria-label"), el.autocomplete].filter(Boolean).join(" ");
        const setValue = (el, value) => {
          el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
          el.focus({ preventScroll: true });
          const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
          if (setter) setter.call(el, value); else el.value = value;
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
        };
        const inputs = Array.from(document.querySelectorAll("input,textarea")).filter(eligible);
        const passwordCandidates = inputs.filter((el) => el instanceof HTMLInputElement && el.type === "password");
        const totpCandidates = inputs.filter((el) => /one-time-code/i.test(el.autocomplete || "") || /(?:otp|totp|verification|auth(?:entication)?[ _-]?code)/i.test(identity(el)));
        if (typeof values.password === "string" && passwordCandidates.length !== 1) return { error: "required-password-field", filled: [] };
        if (typeof values.totp === "string" && totpCandidates.length !== 1) return { error: "required-totp-field", filled: [] };
        const password = passwordCandidates[0];
        const totp = totpCandidates[0];
        const usernameEligible = inputs.filter((el) => el !== password && el !== totp && (!(el instanceof HTMLInputElement) || ["text", "email", "tel", ""].includes(el.type)));
        const strongUsername = usernameEligible.filter((el) => /username|email/i.test(el.autocomplete || "") || /(?:user|email|login)/i.test(identity(el)));
        const username = strongUsername.length === 1 ? strongUsername[0] : strongUsername.length === 0 && usernameEligible.length === 1 ? usernameEligible[0] : undefined;
        const filled = [];
        if (typeof values.username === "string" && username) { setValue(username, values.username); filled.push("username"); }
        if (typeof values.password === "string" && password) { setValue(password, values.password); filled.push("password"); }
        if (typeof values.totp === "string" && totp) { setValue(totp, values.totp); filled.push("totp"); }
        return { filled };
      }`,
      arguments: [{ value: values }],
      returnByValue: true,
      awaitPromise: true,
    });
    if (result?.exceptionDetails) throw new Error("Credential fill failed in the page");
    const value = result?.result?.value ?? {};
    if (value.error === "required-password-field") throw new Error("Credential fill requires exactly one eligible password field");
    if (value.error === "required-totp-field") throw new Error("Credential fill requires exactly one eligible verification-code field");
    const filled = Array.isArray(value.filled) ? value.filled : [];
    return filled.filter((kind: unknown): kind is "username" | "password" | "totp" => kind === "username" || kind === "password" || kind === "totp");
  }));
}

export async function pasteTextBrowser(lookup: BrowserSessionLookup, text: string, expectedControlGeneration?: number): Promise<BrowserSessionState> {
  return insertTextIntoBrowser(lookup, text, false, expectedControlGeneration);
}

export async function stopAllBrowsers(): Promise<void> {
  const lookups = Array.from(runtimes.values()).map((runtime) => ({
    sessionId: runtime.state.sessionId,
    projectCwd: runtime.state.projectCwd,
    persistence: runtime.state.profile.persistence,
  }));
  await Promise.all(lookups.map((lookup) => stopBrowser(lookup).catch(() => undefined)));
}

export interface ManagedChromiumDownloadWillBegin {
  frameId: string;
  guid: string;
  url: string;
  suggestedFilename: string;
}

export interface ManagedChromiumDownloadProgress {
  guid: string;
  totalBytes: number;
  receivedBytes: number;
  state: "inProgress" | "completed" | "canceled";
}

export interface ManagedChromiumRuntimeOptions {
  /** Pre-resolved, caller-owned private directories. This primitive never selects a profile scope. */
  profileDir: string;
  downloadsDir: string;
  /** `allow` keeps browser-selected filenames; `allowAndName` stores GUID names. */
  downloadBehavior?: "allow" | "allowAndName";
  workingDirectory: string;
  onDownloadWillBegin?: (event: ManagedChromiumDownloadWillBegin, pageTargetId?: string | null) => void;
  onDownloadProgress?: (event: ManagedChromiumDownloadProgress) => void;
  /** Browser-lifetime observation of every top-level page target URL. */
  onTopLevelNavigation?: (url: string) => void;
  onTargetCreated?: (target: ChromeTarget) => void;
  onTargetChanged?: (target: ChromeTarget) => void;
  onTargetDestroyed?: (targetId: string) => void;
  onUnexpectedExit?: () => void;
  /** Standard-only synchronous frame attribution. Default leaves existing callers unchanged. */
  downloadAttribution?: "none" | "exact-frame-page-target";
}

export interface ManagedChromiumDocumentIdentity {
  targetId: string;
  frameId: string;
  loaderId: string;
  identity: string;
  url: string;
}

export interface ManagedChromiumPageAttachment {
  /** A page-target-only CDP connection owned by the caller. */
  cdp: CdpConnection;
  target: ChromeTarget;
  close(): void;
}

/**
 * Internal reusable Chromium lifecycle primitive. Registry ownership, public
 * state, profile selection, authorization, and operation policy deliberately
 * remain with the caller. In particular, instances are never added to the
 * generic browser registry above.
 */
export class ManagedChromiumRuntime {
  private child: ChildProcess | null = null;
  private browserCdp: CdpConnection | null = null;
  private cdpPort: number | null = null;
  private stoppingChild: ChildProcess | null = null;
  private lifecycleTail: Promise<void> = Promise.resolve();
  private readonly frameTargetIndex = new ManagedChromiumFrameTargetIndex();
  private readonly pendingFrameInitializations = new Set<Promise<void>>();

  constructor(private readonly options: ManagedChromiumRuntimeOptions) {}

  get running(): boolean {
    return Boolean(this.child && this.child.exitCode === null && this.browserCdp && this.cdpPort);
  }

  private serializeLifecycle<T>(operation: () => Promise<T>): Promise<T> {
    const prior = this.lifecycleTail;
    let release!: () => void;
    this.lifecycleTail = new Promise<void>((resolve) => { release = resolve; });
    return prior.catch(() => undefined).then(operation).finally(release);
  }

  private trackFrameInitialization(operation: Promise<void>): void {
    this.pendingFrameInitializations.add(operation);
    void operation.finally(() => this.pendingFrameInitializations.delete(operation)).catch(() => undefined);
  }

  private async drainFrameInitializations(timeoutMs = 2_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pendingFrameInitializations.size > 0 && Date.now() < deadline) {
      await Promise.race([
        Promise.allSettled([...this.pendingFrameInitializations]),
        sleep(Math.max(1, Math.min(50, deadline - Date.now()))),
      ]);
    }
  }

  async start(assertAuthorizedBeforeBrowserCdp?: () => Promise<void>): Promise<void> {
    return this.serializeLifecycle(async () => {
      if (this.running) return;
      if (this.child && this.child.exitCode === null) {
        throw new Error("Managed Chromium cleanup is pending");
      }
      fs.mkdirSync(this.options.profileDir, { recursive: true, mode: 0o700 });
      fs.mkdirSync(this.options.downloadsDir, { recursive: true, mode: 0o700 });
      const executableCandidates = findChromiumExecutableCandidates();
      let lastStartupError: unknown;
      let authorizationError: unknown;
      const assertAuthorized = async () => {
        try { await assertAuthorizedBeforeBrowserCdp?.(); }
        catch (error) { authorizationError = error; throw error; }
      };
      for (const executable of executableCandidates) {
        await assertAuthorized();
        const frameEpoch = this.frameTargetIndex.reset();
        this.pendingFrameInitializations.clear();
        const exactDownloadAttribution = this.options.downloadAttribution === "exact-frame-page-target";
        const port = await allocatePort();
      const child = spawn(executable, [
        "--remote-debugging-address=127.0.0.1",
        `--remote-debugging-port=${port}`,
        `--user-data-dir=${this.options.profileDir}`,
        "--window-size=1280,720",
        "--disable-dev-shm-usage",
        "--disable-gpu",
        "--no-first-run",
        "--no-default-browser-check",
        "--headless=new",
        "about:blank",
      ], {
        cwd: this.options.workingDirectory,
        detached: process.platform !== "win32",
        env: browserChildEnvironment(),
        stdio: ["ignore", "ignore", "ignore"],
        shell: false,
      });
      this.child = child;
      this.cdpPort = port;
      const exited = new Promise<boolean>((resolve) => child.once("exit", () => resolve(true)));
      try {
        await waitForCdp(port);
        if (child.exitCode !== null) throw new Error("Managed Chromium exited during startup");
        const browserCdp = await connectBrowserCdp(port);
        this.browserCdp = browserCdp;
        const targetInfo = (event: any): ChromeTarget | undefined => {
          const target = event?.targetInfo;
          if (!target || typeof target.targetId !== "string" || typeof target.type !== "string") return undefined;
          return {
            id: target.targetId,
            type: target.type,
            ...(typeof target.title === "string" ? { title: target.title } : {}),
            ...(typeof target.url === "string" ? { url: target.url } : {}),
            ...(typeof target.openerId === "string" ? { openerId: target.openerId } : {}),
          };
        };
        const addFrameTree = (sessionId: string, tree: any) => {
          const frameId = tree?.frame?.id;
          if (typeof frameId === "string") this.frameTargetIndex.addFrame(sessionId, frameId, frameEpoch);
          for (const childTree of Array.isArray(tree?.childFrames) ? tree.childFrames : []) addFrameTree(sessionId, childTree);
        };
        if (exactDownloadAttribution) {
          await browserCdp.send("Browser.setDownloadBehavior", { behavior: "deny", eventsEnabled: true });
          browserCdp.on("Target.attachedToTarget", (event: any, parentSessionId?: string) => {
            const sessionId = typeof event?.sessionId === "string" ? event.sessionId : "";
            const target = targetInfo(event);
            if (!sessionId || !target) return;
            let rootTargetId: string | null = null;
            if (target.type === "page") {
              rootTargetId = target.id;
              this.frameTargetIndex.addPageTarget(rootTargetId, frameEpoch);
            } else if (target.type === "iframe") {
              rootTargetId = this.frameTargetIndex.rootTargetForSession(parentSessionId);
            }
            if (!rootTargetId || !this.frameTargetIndex.attachSession(sessionId, rootTargetId, frameEpoch)) return;
            const initialize = (async () => {
              try {
                await browserCdp.sendToSession(sessionId, "Page.enable");
                await browserCdp.sendToSession(sessionId, "Target.setAutoAttach", {
                  autoAttach: true,
                  waitForDebuggerOnStart: false,
                  flatten: true,
                }).catch(() => undefined);
                const seeded = await browserCdp.sendToSession<any>(sessionId, "Page.getFrameTree");
                if (this.browserCdp !== browserCdp || this.frameTargetIndex.currentEpoch() !== frameEpoch) return;
                addFrameTree(sessionId, seeded?.frameTree);
                if (target.type === "page") this.frameTargetIndex.markReady(rootTargetId!, frameEpoch);
              } catch {
                this.frameTargetIndex.degrade(rootTargetId!, frameEpoch);
              } finally {
                if (event?.waitingForDebugger === true) {
                  await browserCdp.sendToSession(sessionId, "Runtime.runIfWaitingForDebugger").catch(() => undefined);
                }
              }
            })();
            this.trackFrameInitialization(initialize);
          });
          browserCdp.on("Target.detachedFromTarget", (event: any) => {
            if (typeof event?.sessionId === "string") this.frameTargetIndex.removeSession(event.sessionId);
          });
          browserCdp.on("Page.frameAttached", (event: any, sessionId?: string) => {
            if (sessionId && typeof event?.frameId === "string") this.frameTargetIndex.addFrame(sessionId, event.frameId, frameEpoch);
          });
          browserCdp.on("Page.frameNavigated", (event: any, sessionId?: string) => {
            if (sessionId && typeof event?.frame?.id === "string") this.frameTargetIndex.addFrame(sessionId, event.frame.id, frameEpoch);
          });
          browserCdp.on("Page.frameDetached", (event: any, sessionId?: string) => {
            if (sessionId && typeof event?.frameId === "string") this.frameTargetIndex.removeFrame(sessionId, event.frameId);
          });
        }
        if (this.options.onTopLevelNavigation || this.options.onTargetCreated
          || this.options.onTargetChanged || this.options.onTargetDestroyed || exactDownloadAttribution) {
          browserCdp.on("Target.targetCreated", (event: any) => {
            const target = targetInfo(event);
            if (!target) return;
            if (target.type === "page") this.frameTargetIndex.addPageTarget(target.id, frameEpoch);
            if (target.type === "page" && typeof target.url === "string") this.options.onTopLevelNavigation?.(target.url);
            this.options.onTargetCreated?.(target);
          });
          browserCdp.on("Target.targetInfoChanged", (event: any) => {
            const target = targetInfo(event);
            if (!target) return;
            if (target.type === "page" && typeof target.url === "string") this.options.onTopLevelNavigation?.(target.url);
            this.options.onTargetChanged?.(target);
          });
          browserCdp.on("Target.targetDestroyed", (event: any) => {
            if (typeof event?.targetId !== "string") return;
            this.frameTargetIndex.removePageTarget(event.targetId);
            this.options.onTargetDestroyed?.(event.targetId);
          });
          await assertAuthorized();
          if (exactDownloadAttribution) {
            await browserCdp.send("Target.setAutoAttach", {
              autoAttach: true,
              waitForDebuggerOnStart: false,
              flatten: true,
            });
          }
          await browserCdp.send("Target.setDiscoverTargets", { discover: true });
        }
        if (this.options.onDownloadWillBegin) {
          browserCdp.on("Browser.downloadWillBegin", (event: ManagedChromiumDownloadWillBegin) => {
            const targetId = exactDownloadAttribution && typeof event?.frameId === "string"
              ? this.frameTargetIndex.resolve(event.frameId)
              : null;
            this.options.onDownloadWillBegin?.({ ...event }, targetId);
          });
        }
        if (this.options.onDownloadProgress) {
          browserCdp.on("Browser.downloadProgress", (event: ManagedChromiumDownloadProgress) => {
            this.options.onDownloadProgress?.({ ...event });
          });
        }
        await assertAuthorized();
        await this.pageTarget();
        if (exactDownloadAttribution) await this.drainFrameInitializations();
        await browserCdp.send("Browser.setDownloadBehavior", {
          behavior: this.options.downloadBehavior ?? "allowAndName",
          downloadPath: this.options.downloadsDir,
          eventsEnabled: true,
        });
        child.once("exit", () => {
          if (this.child !== child) return;
          const expectedStop = this.stoppingChild === child;
          this.browserCdp?.close();
          this.browserCdp = null;
          this.frameTargetIndex.reset();
          this.pendingFrameInitializations.clear();
          this.child = null;
          this.cdpPort = null;
          if (expectedStop) this.stoppingChild = null;
          else this.options.onUnexpectedExit?.();
        });
        return;
      } catch (error) {
        this.browserCdp?.close();
        this.browserCdp = null;
        this.frameTargetIndex.reset();
        this.pendingFrameInitializations.clear();
        terminateChild(child);
        const exitedAfterTerm = await Promise.race([
          exited,
          sleep(3_000).then(() => false),
        ]);
        if (!exitedAfterTerm) {
          killChild(child);
          const exitedAfterKill = await Promise.race([
            exited,
            sleep(2_000).then(() => false),
          ]);
          if (!exitedAfterKill) {
            this.stoppingChild = child;
            this.cdpPort = null;
            throw new Error("Managed Chromium could not be terminated after a failed startup attempt");
          }
        }
        if (this.child === child) this.child = null;
        if (this.stoppingChild === child) this.stoppingChild = null;
        this.cdpPort = null;
        if (authorizationError !== undefined) throw authorizationError;
        lastStartupError = error;
      }
      }
      throw lastStartupError instanceof Error
        ? lastStartupError
        : new Error("Managed Chromium failed to start with every detected executable");
    });
  }

  async cancelDownload(guid: string, assertAuthorizedBeforeBrowserCdp?: () => Promise<void>): Promise<void> {
    if (!/^[a-zA-Z0-9_-]{1,128}$/.test(guid)) throw new Error("Managed Chromium download identifier is invalid");
    const browserCdp = this.browserCdp;
    if (!this.running || !browserCdp) throw new Error("Managed Chromium is not running");
    await assertAuthorizedBeforeBrowserCdp?.();
    await browserCdp.send("Browser.cancelDownload", { guid });
  }

  async stop(): Promise<void> {
    return this.serializeLifecycle(async () => {
      const child = this.child;
      this.browserCdp?.close();
      this.browserCdp = null;
      this.frameTargetIndex.reset();
      this.pendingFrameInitializations.clear();
      this.cdpPort = null;
      if (!child) return;
      if (child.exitCode !== null) {
        if (this.child === child) this.child = null;
        if (this.stoppingChild === child) this.stoppingChild = null;
        return;
      }
      this.stoppingChild = child;
      const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      terminateChild(child);
      const graceful = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]);
      if (!graceful) {
        killChild(child);
        const killed = await Promise.race([exited.then(() => true), sleep(3_000).then(() => false)]);
        if (!killed) throw new Error("Managed Chromium did not exit after forced termination");
      }
      if (this.child === child) this.child = null;
      if (this.stoppingChild === child) this.stoppingChild = null;
    });
  }

  private async pageTarget(): Promise<ChromeTarget> {
    const port = this.cdpPort;
    if (!this.running || !port) throw new Error("Managed Chromium is not running");
    const targets = await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${port}/json/list`);
    const target = selectPageTarget(targets) ?? await createPageTarget(port);
    if (!target.webSocketDebuggerUrl) throw new Error("Chrome target did not expose a debugger connection");
    return target;
  }

  async listPageTargets(): Promise<ChromeTarget[]> {
    const port = this.cdpPort;
    if (!this.running || !port) throw new Error("Managed Chromium is not running");
    return (await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${port}/json/list`))
      .filter((target) => target.type === "page");
  }

  async createPageTarget(url = "about:blank"): Promise<ChromeTarget> {
    const browserCdp = this.browserCdp;
    if (!this.running || !browserCdp) throw new Error("Managed Chromium is not running");
    const created = await browserCdp.send<{ targetId?: string }>("Target.createTarget", { url });
    if (!created?.targetId) throw new Error("Managed Chromium did not create a page target");
    const targets = await this.listPageTargets();
    const target = targets.find((candidate) => candidate.id === created.targetId);
    if (!target?.webSocketDebuggerUrl) throw new Error("Managed Chromium target is unavailable");
    return target;
  }

  async closePageTarget(targetId: string): Promise<void> {
    const browserCdp = this.browserCdp;
    if (!this.running || !browserCdp || !targetId) throw new Error("Managed Chromium is not running");
    await browserCdp.send("Target.closeTarget", { targetId });
  }

  async attachTargetCdpViewer(targetId: string): Promise<ManagedChromiumPageAttachment> {
    if (!this.running) throw new Error("Managed Chromium is not running");
    const target = (await this.listPageTargets()).find((candidate) => candidate.id === targetId);
    if (!target?.webSocketDebuggerUrl) throw new Error("Managed Chromium target is unavailable");
    const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl);
    let closed = false;
    return {
      cdp,
      target,
      close() {
        if (closed) return;
        closed = true;
        cdp.close();
      },
    };
  }

  async attachPageCdpViewer(): Promise<ManagedChromiumPageAttachment> {
    if (!this.running) throw new Error("Managed Chromium is not running");
    const target = await this.pageTarget();
    if (!this.running) throw new Error("Managed Chromium stopped during viewer attachment");
    const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl!);
    let closed = false;
    return {
      cdp,
      target,
      close() {
        if (closed) return;
        closed = true;
        cdp.close();
      },
    };
  }

  async withPageCdp<T>(operation: (cdp: CdpConnection, target: ChromeTarget) => Promise<T>): Promise<T> {
    const attachment = await this.attachPageCdpViewer();
    try {
      return await operation(attachment.cdp, attachment.target);
    } finally {
      attachment.close();
    }
  }

  async documentIdentity(): Promise<ManagedChromiumDocumentIdentity> {
    return this.withPageCdp(async (cdp, target) => {
      const document = await readTopLevelDocumentIdentity(cdp);
      const location = await cdp.send<any>("Runtime.evaluate", {
        expression: "location.href",
        returnByValue: true,
      });
      return {
        targetId: target.id,
        frameId: document.frameId,
        loaderId: document.loaderId,
        identity: `${target.id}:${document.identity}`,
        url: String(location?.result?.value ?? target.url ?? ""),
      };
    });
  }

  async navigate(url: string): Promise<ManagedChromiumDocumentIdentity> {
    return this.withPageCdp(async (cdp, target) => {
      await cdp.send("Page.enable");
      let finishLoad!: () => void;
      const loaded = new Promise<void>((resolve) => {
        const off = cdp.on("Page.loadEventFired", () => finishLoad());
        const timer = setTimeout(() => finishLoad(), 10_000);
        timer.unref?.();
        finishLoad = () => {
          clearTimeout(timer);
          off();
          resolve();
        };
      });
      const result = await cdp.send<any>("Page.navigate", { url });
      if (result?.errorText) {
        finishLoad();
        throw new Error("Managed Chromium navigation failed");
      }
      if (result?.loaderId) await loaded;
      else finishLoad();
      const document = await readTopLevelDocumentIdentity(cdp);
      const location = await cdp.send<any>("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      return {
        targetId: target.id,
        frameId: document.frameId,
        loaderId: document.loaderId,
        identity: `${target.id}:${document.identity}`,
        url: String(location?.result?.value ?? url),
      };
    });
  }
}
