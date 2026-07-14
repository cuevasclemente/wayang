import { spawn, type ChildProcess } from "node:child_process";
import * as net from "node:net";
import type { RegisteredApp } from "./types.js";
import { refreshManifest, resolveAppWorkingDirectory, updateAppRuntime } from "./registry.js";

const MAX_LOG_LINES = 500;
const STARTUP_TIMEOUT_MS = 20_000;
const HEALTH_INTERVAL_MS = 500;

interface RuntimeHandle {
  app: RegisteredApp;
  child: ChildProcess;
  logs: string[];
  stopping: boolean;
}

const processes = new Map<string, RuntimeHandle>();
const retainedLogs = new Map<string, string[]>();

function runtimeKey(app: RegisteredApp): string {
  return `${app.projectCwd}\u0000${app.id}`;
}

function appendLog(handle: RuntimeHandle, chunk: Buffer | string): void {
  const text = Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : chunk;
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    handle.logs.push(`${new Date().toISOString()} ${line}`);
  }
  if (handle.logs.length > MAX_LOG_LINES) {
    handle.logs.splice(0, handle.logs.length - MAX_LOG_LINES);
  }
}

function allocatePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("Failed to allocate a local port")));
        return;
      }
      const port = address.port;
      server.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeHealthPath(healthPath?: string): string {
  if (!healthPath) return "/";
  return healthPath.startsWith("/") ? healthPath : `/${healthPath}`;
}

async function waitForHealthy(url: string, healthPath?: string): Promise<void> {
  const started = Date.now();
  const healthUrl = new URL(normalizeHealthPath(healthPath), url).toString();
  let lastError = "health check timed out";

  while (Date.now() - started < STARTUP_TIMEOUT_MS) {
    try {
      const res = await fetch(healthUrl, { method: "GET" });
      if (res.ok || res.status < 500) return;
      lastError = `health check returned HTTP ${res.status}`;
    } catch (err: any) {
      lastError = err?.message || String(err);
    }
    await sleep(HEALTH_INTERVAL_MS);
  }
  throw new Error(lastError);
}

function getHandle(app: RegisteredApp): RuntimeHandle | undefined {
  return processes.get(runtimeKey(app));
}

export function isAppRunning(app: RegisteredApp): boolean {
  const handle = getHandle(app);
  return Boolean(handle && !handle.child.killed && handle.child.exitCode === null);
}

export async function startApp(app: RegisteredApp): Promise<RegisteredApp> {
  const existing = getHandle(app);
  if (existing && isAppRunning(existing.app)) return existing.app;

  const latest = refreshManifest(app);
  const port = latest.manifest.entry.port && latest.manifest.entry.port > 0
    ? latest.manifest.entry.port
    : await allocatePort();
  const url = `http://127.0.0.1:${port}`;
  updateAppRuntime(latest.id, latest.projectCwd, { status: "starting", url, port, lastError: undefined });

  const cwd = resolveAppWorkingDirectory(latest.projectCwd, latest.manifest);
  const appBasePath = latest.sessionId
    ? `/api/apps/${encodeURIComponent(latest.id)}/proxy/${encodeURIComponent(latest.sessionId)}/`
    : `/api/apps/${encodeURIComponent(latest.id)}/proxy/`;
  const child = spawn(latest.manifest.entry.devCommand, {
    cwd,
    shell: true,
    detached: process.platform !== "win32",
    env: {
      ...process.env,
      PORT: String(port),
      PI_APP_PORT: String(port),
      PI_APP_ID: latest.id,
      PI_APP_PROJECT_CWD: latest.projectCwd,
      PI_APP_MANIFEST_PATH: latest.manifestPath,
      PI_APP_BASE_PATH: appBasePath,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });

  const handle: RuntimeHandle = { app: latest, child, logs: [], stopping: false };
  processes.set(runtimeKey(latest), handle);
  retainedLogs.set(runtimeKey(latest), handle.logs);
  appendLog(handle, `$ ${latest.manifest.entry.devCommand}`);

  child.stdout?.on("data", (chunk) => appendLog(handle, chunk));
  child.stderr?.on("data", (chunk) => appendLog(handle, chunk));
  child.on("exit", (code, signal) => {
    appendLog(handle, `process exited code=${code ?? "null"} signal=${signal ?? "null"}`);
    retainedLogs.set(runtimeKey(latest), [...handle.logs]);
    processes.delete(runtimeKey(latest));
    const status = handle.stopping ? "stopped" : "errored";
    const lastError = handle.stopping ? undefined : `Process exited code=${code ?? "null"} signal=${signal ?? "null"}`;
    try {
      updateAppRuntime(latest.id, latest.projectCwd, {
        status,
        url: handle.stopping ? undefined : url,
        port: handle.stopping ? undefined : port,
        lastError,
      });
    } catch {
      // app may have been removed from registry
    }
  });

  try {
    await waitForHealthy(url, latest.manifest.entry.healthPath);
    const running = updateAppRuntime(latest.id, latest.projectCwd, { status: "running", url, port, lastError: undefined });
    handle.app = running;
    return running;
  } catch (err: any) {
    appendLog(handle, `startup failed: ${err?.message || String(err)}`);
    await stopApp(latest);
    return updateAppRuntime(latest.id, latest.projectCwd, {
      status: "errored",
      url,
      port,
      lastError: err?.message || String(err),
    });
  }
}

export async function stopApp(app: RegisteredApp): Promise<RegisteredApp> {
  const handle = getHandle(app);
  if (!handle) {
    return updateAppRuntime(app.id, app.projectCwd, { status: "stopped", url: undefined, port: undefined, lastError: undefined });
  }

  handle.stopping = true;
  const child = handle.child;
  if (child.exitCode === null && !child.killed) {
    try {
      if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGTERM");
      else child.kill("SIGTERM");
    } catch {
      try { child.kill("SIGTERM"); } catch {}
    }

    await Promise.race([
      new Promise<void>((resolve) => child.once("exit", () => resolve())),
      sleep(3_000).then(() => {
        if (child.exitCode === null && !child.killed) {
          try {
            if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
            else child.kill("SIGKILL");
          } catch {
            try { child.kill("SIGKILL"); } catch {}
          }
        }
      }),
    ]);
  }
  processes.delete(runtimeKey(app));
  return updateAppRuntime(app.id, app.projectCwd, { status: "stopped", url: undefined, port: undefined, lastError: undefined });
}

export async function restartApp(app: RegisteredApp): Promise<RegisteredApp> {
  await stopApp(app);
  return startApp(app);
}

export function getAppLogs(app: RegisteredApp): string[] {
  return getHandle(app)?.logs ?? retainedLogs.get(runtimeKey(app)) ?? [];
}

export async function stopAllApps(): Promise<void> {
  const handles = Array.from(processes.values());
  await Promise.all(handles.map((handle) => stopApp(handle.app).catch(() => undefined)));
}
