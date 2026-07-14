import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { CdpConnection, type ChromeTarget } from "./cdp.js";
import type {
  BrowserAccessibilitySnapshot,
  BrowserControlMode,
  BrowserDomSnapshot,
  BrowserLinksResult,
  BrowserSelectorQueryResult,
  BrowserSessionLookup,
  BrowserSessionState,
  BrowserSnapshot,
} from "./types.js";
import { getSessionById, normalizeSessionCwd } from "../sessions.js";

const STARTUP_TIMEOUT_MS = 20_000;
const MAX_LOG_LINES = 300;

interface BrowserRuntime {
  state: BrowserSessionState;
  child: ChildProcess | null;
  xvfbChild: ChildProcess | null;
  vncChild: ChildProcess | null;
  stopping: boolean;
}

const runtimes = new Map<string, BrowserRuntime>();

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

function hasCommand(name: string): boolean {
  const found = spawnSync("command", ["-v", name], { shell: true, encoding: "utf-8" });
  return found.status === 0 && found.stdout.trim().length > 0;
}

function canUseVncTransport(): boolean {
  return process.env.WAYANG_BROWSER_TRANSPORT !== "cdp" && hasCommand("Xvfb") && hasCommand("x11vnc");
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

function playwrightChromiumCandidates(): string[] {
  const cacheDir = path.join(os.homedir(), ".cache", "ms-playwright");
  try {
    return fs.readdirSync(cacheDir)
      .filter((name) => name.startsWith("chromium-"))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))
      .flatMap((name) => [
        path.join(cacheDir, name, "chrome-linux64", "chrome"),
        path.join(cacheDir, name, "chrome-linux", "chrome"),
      ]);
  } catch {
    return [];
  }
}

function findChromiumExecutable(): string {
  const configured = process.env.WAYANG_CHROMIUM_PATH || process.env.CHROME_PATH || process.env.CHROMIUM_PATH;
  const candidates = [
    configured,
    ...playwrightChromiumCandidates(),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/google-chrome",
    "/opt/google/chrome/chrome",
  ].filter(Boolean) as string[];
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  for (const name of ["chromium", "chromium-browser", "google-chrome-stable", "google-chrome"]) {
    const found = spawnSync("command", ["-v", name], { shell: true, encoding: "utf-8" });
    const stdout = found.stdout.trim();
    if (found.status === 0 && stdout) return stdout.split(/\r?\n/)[0];
  }
  throw new Error("Chromium executable not found. Set WAYANG_CHROMIUM_PATH to a Chromium/Chrome binary.");
}

function sanitizeKeySegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "browser";
}

function hash(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex").slice(0, 12);
}

function profileKey(projectCwd: string, sessionId: string | null, persistence: "project" | "session"): string {
  if (persistence === "session" && sessionId) return `session-${sanitizeKeySegment(sessionId.slice(0, 36))}`;
  return `${sanitizeKeySegment(path.basename(projectCwd))}-${hash(projectCwd)}`;
}

function resolveLookup(lookup: BrowserSessionLookup): { sessionId: string | null; projectCwd: string; persistence: "project" | "session" } {
  const sessionId = lookup.sessionId || null;
  const persistence = lookup.persistence || "project";
  if (lookup.projectCwd) {
    return { sessionId, projectCwd: normalizeSessionCwd(lookup.projectCwd), persistence };
  }
  if (sessionId) {
    const session = getSessionById(sessionId);
    if (!session) throw new Error("Session not found");
    return { sessionId, projectCwd: normalizeSessionCwd(session.cwd), persistence };
  }
  throw new Error("sessionId or projectCwd is required");
}

function createInitialState(lookup: BrowserSessionLookup): BrowserSessionState {
  const resolved = resolveLookup(lookup);
  const key = profileKey(resolved.projectCwd, resolved.sessionId, resolved.persistence);
  const rootDir = path.join(resolved.projectCwd, ".pi", "browser-workbench");
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
    viewerTransport: canUseVncTransport() ? "vnc" : "cdp-screencast",
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
  };
}

function cloneState(state: BrowserSessionState): BrowserSessionState {
  return { ...state, profile: { ...state.profile }, logs: [...state.logs] };
}

function getRuntime(lookup: BrowserSessionLookup): BrowserRuntime {
  const state = createInitialState(lookup);
  const existing = runtimes.get(state.key);
  if (existing) {
    if (state.sessionId && !existing.state.sessionId) existing.state.sessionId = state.sessionId;
    return existing;
  }
  const runtime: BrowserRuntime = { state, child: null, xvfbChild: null, vncChild: null, stopping: false };
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

export async function getPageTarget(state: BrowserSessionState): Promise<ChromeTarget> {
  if (!state.cdpPort) throw new Error("Browser is not running");
  const targets = await fetchJson<ChromeTarget[]>(`http://127.0.0.1:${state.cdpPort}/json/list`);
  const page = targets.find((target) => target.type === "page" && target.webSocketDebuggerUrl)
    ?? await createPageTarget(state.cdpPort);
  if (!page.webSocketDebuggerUrl) throw new Error("Chrome target did not expose webSocketDebuggerUrl");
  state.activeUrl = page.url || state.activeUrl;
  state.activeTitle = page.title || state.activeTitle;
  state.updatedAt = now();
  return page;
}

export function getBrowserStatus(lookup: BrowserSessionLookup): BrowserSessionState {
  const runtime = getRuntime(lookup);
  return cloneState(runtime.state);
}

export function listBrowserSessions(): BrowserSessionState[] {
  return Array.from(runtimes.values()).map((runtime) => cloneState(runtime.state));
}

function persistRuntimeState(runtime: BrowserRuntime): void {
  fs.mkdirSync(path.dirname(runtime.state.profile.runtimePath), { recursive: true });
  const { logs: _logs, ...persisted } = runtime.state;
  fs.writeFileSync(runtime.state.profile.runtimePath, JSON.stringify(persisted, null, 2), { mode: 0o600 });
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

export async function startBrowser(lookup: BrowserSessionLookup): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  const state = runtime.state;
  if (state.status === "running" && runtime.child && runtime.child.exitCode === null) return cloneState(state);
  if (state.status === "starting") return cloneState(state);

  fs.mkdirSync(state.profile.profileDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(state.profile.downloadsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(state.profile.artifactsDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(path.dirname(state.profile.runtimePath), { recursive: true, mode: 0o700 });

  runtime.stopping = false;
  const executable = findChromiumExecutable();
  const cdpPort = await allocatePort();
  const useVnc = canUseVncTransport();
  const display = useVnc ? await allocateDisplay() : undefined;
  const vncPort = useVnc ? await allocatePort() : undefined;

  state.status = "starting";
  state.cdpReady = false;
  state.cdpPort = cdpPort;
  state.vncReady = false;
  state.vncPort = vncPort;
  state.display = display;
  state.viewerTransport = useVnc ? "vnc" : "cdp-screencast";
  state.viewerWsPath = useVnc
    ? `/ws/browser-vnc?${new URLSearchParams(state.sessionId ? { session_id: state.sessionId } : { project_cwd: state.projectCwd }).toString()}`
    : state.cdpScreencastWsPath;
  state.lastError = undefined;
  state.startedAt = now();
  state.updatedAt = now();
  appendLog(runtime, `starting ${executable} on CDP port ${cdpPort}${useVnc ? ` with VNC display ${display} port ${vncPort}` : " headless"}`);
  persistRuntimeState(runtime);

  try {
    if (useVnc && display && vncPort) {
      const xvfb = spawn("Xvfb", [display, "-screen", "0", "1440x900x24", "-nolisten", "tcp", "-ac"], {
        cwd: state.projectCwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
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

      const vnc = spawn("x11vnc", [
        "-display", display,
        "-localhost",
        "-nopw",
        "-forever",
        "-shared",
        "-rfbport", String(vncPort),
        "-quiet",
      ], {
        cwd: state.projectCwd,
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
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
      `--window-size=1440,900`,
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
      env: { ...process.env, ...(display ? { DISPLAY: display } : {}) },
      stdio: ["ignore", "pipe", "pipe"],
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
    return cloneState(state);
  } catch (err: any) {
    state.status = "errored";
    state.cdpReady = false;
    state.vncReady = false;
    state.lastError = err?.message || String(err);
    appendLog(runtime, `startup failed: ${state.lastError}`);
    await stopBrowser(lookup);
    state.status = "errored";
    state.lastError = err?.message || String(err);
    persistRuntimeState(runtime);
    return cloneState(state);
  }
}

export async function stopBrowser(lookup: BrowserSessionLookup): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
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
  return cloneState(runtime.state);
}

export async function restartBrowser(lookup: BrowserSessionLookup): Promise<BrowserSessionState> {
  await stopBrowser(lookup);
  return startBrowser(lookup);
}

export async function resetBrowserProfile(lookup: BrowserSessionLookup): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  await stopBrowser(lookup);
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
  return cloneState(runtime.state);
}

export function setBrowserControlMode(lookup: BrowserSessionLookup, mode: BrowserControlMode, reason?: string): BrowserSessionState {
  const runtime = getRuntime(lookup);
  runtime.state.controlMode = mode;
  runtime.state.needsUser = mode === "user" || mode === "paused";
  runtime.state.needsUserReason = runtime.state.needsUser ? reason : undefined;
  if (mode === "agent") runtime.state.lastResumeAt = now();
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return cloneState(runtime.state);
}

async function withCdp<T>(state: BrowserSessionState, fn: (cdp: CdpConnection) => Promise<T>): Promise<T> {
  const target = await getPageTarget(state);
  const cdp = await CdpConnection.connect(target.webSocketDebuggerUrl!);
  try {
    return await fn(cdp);
  } finally {
    cdp.close();
  }
}

export async function navigateBrowser(lookup: BrowserSessionLookup, url: string): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  const normalizedUrl = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url) ? url : `https://${url}`;
  await withCdp(runtime.state, async (cdp) => {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const loaded = new Promise<void>((resolve) => {
      const off = cdp.on("Page.loadEventFired", () => {
        off();
        resolve();
      });
      setTimeout(() => {
        off();
        resolve();
      }, 10_000).unref?.();
    });
    await cdp.send("Page.navigate", { url: normalizedUrl });
    await loaded;
    const info = await cdp.send<any>("Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const value = info?.result?.value ?? {};
    runtime.state.activeUrl = value.url || normalizedUrl;
    runtime.state.activeTitle = value.title || runtime.state.activeTitle;
  });
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return cloneState(runtime.state);
}

export async function browserSnapshot(lookup: BrowserSessionLookup, mode: "text" | "screenshot" = "text"): Promise<BrowserSnapshot> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  return withCdp(runtime.state, async (cdp) => {
    await cdp.send("Page.enable");
    await cdp.send("Runtime.enable");
    const info = await cdp.send<any>("Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title, text: document.body ? document.body.innerText : '' })",
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
  });
}

const DOM_HELPERS_SCRIPT = String.raw`
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
  const raw = el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement
    ? el.value
    : (el.innerText || el.textContent || "");
  return String(raw).replace(/\s+/g, " ").trim().slice(0, 500);
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
    value: el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement ? String(el.value || "").slice(0, 500) : undefined,
    href: el instanceof HTMLAnchorElement ? el.href : undefined,
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

async function evaluatePage<T>(state: BrowserSessionState, expression: string): Promise<T> {
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
  });
}

export async function browserDomSnapshot(
  lookup: BrowserSessionLookup,
  options: { includeText?: boolean; limit?: number } = {},
): Promise<BrowserDomSnapshot> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  const limit = sanitizeLimit(options.limit, 80, 300);
  const includeText = Boolean(options.includeText);
  const snapshot = await evaluatePage<BrowserDomSnapshot>(runtime.state, domHelpersExpression(`
    const selector = "a,button,input,textarea,select,[role],[onclick],[contenteditable='true'],summary,label,h1,h2,h3,h4,h5,h6";
    const candidates = Array.from(document.querySelectorAll(selector)).filter(__wayangVisible).slice(0, ${limit});
    return {
      url: location.href,
      title: document.title,
      text: ${includeText} && document.body ? String(document.body.innerText || "").slice(0, 50000) : undefined,
      elements: candidates.map((el, index) => __wayangElementInfo(el, index)),
    };
  `));
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
): Promise<BrowserSelectorQueryResult> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  const limit = sanitizeLimit(options.limit, 25, 200);
  const snapshot = await evaluatePage<BrowserSelectorQueryResult>(runtime.state, domHelpersExpression(`
    const selector = ${JSON.stringify(selector)};
    const elements = Array.from(document.querySelectorAll(selector)).slice(0, ${limit});
    return {
      url: location.href,
      title: document.title,
      selector,
      elements: elements.map((el, index) => __wayangElementInfo(el, index)),
    };
  `));
  runtime.state.activeUrl = snapshot.url || runtime.state.activeUrl;
  runtime.state.activeTitle = snapshot.title || runtime.state.activeTitle;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return snapshot;
}

async function getSelectorClickPoint(state: BrowserSessionState, selector: string, index: number): Promise<{ x: number; y: number; url: string; title: string }> {
  return evaluatePage(state, domHelpersExpression(`
    const selector = ${JSON.stringify(selector)};
    const index = ${Math.max(0, Math.floor(index || 0))};
    const elements = Array.from(document.querySelectorAll(selector));
    const el = elements[index];
    if (!el) throw new Error(` + "`No element found for selector ${selector} at index ${index}`" + `);
    el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
    if (typeof el.focus === "function") el.focus({ preventScroll: true });
    const rect = el.getBoundingClientRect();
    return { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, url: location.href, title: document.title };
  `));
}

export async function clickBrowserSelector(lookup: BrowserSessionLookup, selector: string, index = 0): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  const point = await getSelectorClickPoint(runtime.state, selector, index);
  await withCdp(runtime.state, async (cdp) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: point.x, y: point.y, button: "left", clickCount: 1 });
  });
  runtime.state.activeUrl = point.url || runtime.state.activeUrl;
  runtime.state.activeTitle = point.title || runtime.state.activeTitle;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return cloneState(runtime.state);
}

export async function fillBrowserSelector(lookup: BrowserSessionLookup, selector: string, text: string, index = 0): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
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
    return { url: location.href, title: document.title };
  `));
  runtime.state.activeUrl = result.url || runtime.state.activeUrl;
  runtime.state.activeTitle = result.title || runtime.state.activeTitle;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return cloneState(runtime.state);
}

export async function extractBrowserLinks(lookup: BrowserSessionLookup, options: { limit?: number } = {}): Promise<BrowserLinksResult> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  const limit = sanitizeLimit(options.limit, 100, 500);
  const result = await evaluatePage<BrowserLinksResult>(runtime.state, domHelpersExpression(`
    const links = Array.from(document.querySelectorAll("a[href]")).slice(0, ${limit}).map((el, index) => ({
      index,
      text: __wayangText(el) || el.getAttribute("aria-label") || el.getAttribute("title") || "",
      href: el.href,
      selector: __wayangSelector(el),
      visible: __wayangVisible(el),
    }));
    return { url: location.href, title: document.title, links };
  `));
  runtime.state.activeUrl = result.url || runtime.state.activeUrl;
  runtime.state.activeTitle = result.title || runtime.state.activeTitle;
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return result;
}

export async function browserAccessibilitySnapshot(lookup: BrowserSessionLookup, options: { limit?: number } = {}): Promise<BrowserAccessibilitySnapshot> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  const limit = sanitizeLimit(options.limit, 120, 500);
  return withCdp(runtime.state, async (cdp) => {
    await cdp.send("Accessibility.enable");
    const info = await cdp.send<any>("Runtime.evaluate", {
      expression: "({ url: location.href, title: document.title })",
      returnByValue: true,
    });
    const page = info?.result?.value ?? {};
    const tree = await cdp.send<any>("Accessibility.getFullAXTree");
    const nodes = Array.isArray(tree?.nodes) ? tree.nodes : [];
    const simplified = nodes
      .filter((node: any) => !node.ignored)
      .map((node: any) => ({
        role: node.role?.value,
        name: node.name?.value,
        value: node.value?.value,
        description: node.description?.value,
        ignored: node.ignored,
      }))
      .filter((node: any) => node.role || node.name || node.value || node.description)
      .slice(0, limit);
    runtime.state.activeUrl = page.url || runtime.state.activeUrl;
    runtime.state.activeTitle = page.title || runtime.state.activeTitle;
    runtime.state.updatedAt = now();
    persistRuntimeState(runtime);
    return { url: page.url || "", title: page.title || "", nodes: simplified };
  });
}

export async function clickBrowser(lookup: BrowserSessionLookup, x: number, y: number): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  await withCdp(runtime.state, async (cdp) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
  });
  return cloneState(runtime.state);
}

async function insertTextIntoBrowser(lookup: BrowserSessionLookup, text: string): Promise<BrowserSessionState> {
  const runtime = getRuntime(lookup);
  if (runtime.state.status !== "running") await startBrowser(lookup);
  await withCdp(runtime.state, async (cdp) => {
    await cdp.send("Input.insertText", { text });
  });
  runtime.state.updatedAt = now();
  persistRuntimeState(runtime);
  return cloneState(runtime.state);
}

export async function typePublicBrowser(lookup: BrowserSessionLookup, text: string): Promise<BrowserSessionState> {
  return insertTextIntoBrowser(lookup, text);
}

export async function pasteTextBrowser(lookup: BrowserSessionLookup, text: string): Promise<BrowserSessionState> {
  return insertTextIntoBrowser(lookup, text);
}

export async function stopAllBrowsers(): Promise<void> {
  const lookups = Array.from(runtimes.values()).map((runtime) => ({ sessionId: runtime.state.sessionId, projectCwd: runtime.state.projectCwd }));
  await Promise.all(lookups.map((lookup) => stopBrowser(lookup).catch(() => undefined)));
}
