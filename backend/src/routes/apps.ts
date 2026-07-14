import { Readable } from "node:stream";
import { Router, type Request, type Response } from "express";
import { addAppEvent, getAppState, listAppEvents, setAppState } from "../apps/bridge.js";
import { getRegisteredApp, listAppsForProject, listAppsForSession, registerApp, AppRegistryError } from "../apps/registry.js";
import { getAppLogs, restartApp, startApp, stopApp } from "../apps/process-manager.js";

export const router = Router();

function statusForError(err: unknown): number {
  return err instanceof AppRegistryError ? err.statusCode : 500;
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendError(res: Response, err: unknown): void {
  res.status(statusForError(err)).json({ error: errorMessage(err) });
}

const APP_PROXY_BLOCKED_REQUEST_HEADERS = new Set([
  "authorization",
  "connection",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "proxy-authorization",
  "transfer-encoding",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
]);

const APP_PROXY_BLOCKED_RESPONSE_HEADERS = new Set([
  "connection",
  "content-encoding",
  "content-length",
  "set-cookie",
  "transfer-encoding",
]);

export function shouldForwardAppProxyRequestHeader(name: string): boolean {
  return !APP_PROXY_BLOCKED_REQUEST_HEADERS.has(name.toLowerCase());
}

export function shouldForwardAppProxyResponseHeader(name: string): boolean {
  return !APP_PROXY_BLOCKED_RESPONSE_HEADERS.has(name.toLowerCase());
}

function appFromRequest(req: Request) {
  const sessionId = typeof req.query.session_id === "string"
    ? req.query.session_id
    : typeof req.body?.sessionId === "string"
      ? req.body.sessionId
      : undefined;
  const projectCwd = typeof req.query.project_cwd === "string"
    ? req.query.project_cwd
    : typeof req.body?.projectCwd === "string"
      ? req.body.projectCwd
      : undefined;
  return getRegisteredApp(req.params.appId, { sessionId, projectCwd });
}

router.get("/apps", (req: Request, res: Response) => {
  try {
    const sessionId = typeof req.query.session_id === "string" ? req.query.session_id : undefined;
    const projectCwd = typeof req.query.project_cwd === "string" ? req.query.project_cwd : undefined;
    const scan = req.query.scan !== "0";
    if (sessionId) {
      res.json(listAppsForSession(sessionId, scan));
      return;
    }
    if (projectCwd) {
      res.json(listAppsForProject(projectCwd, undefined, scan));
      return;
    }
    res.status(400).json({ error: "session_id or project_cwd is required" });
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/apps/register", (req: Request, res: Response) => {
  try {
    const { sessionId, projectCwd, manifestPath } = req.body ?? {};
    if (typeof manifestPath !== "string") {
      res.status(400).json({ error: "manifestPath is required" });
      return;
    }
    const app = registerApp({
      sessionId: typeof sessionId === "string" ? sessionId : undefined,
      projectCwd: typeof projectCwd === "string" ? projectCwd : undefined,
      manifestPath,
    });
    res.status(201).json(app);
  } catch (err) {
    sendError(res, err);
  }
});

router.use("/apps/:appId/proxy/:sessionId", async (req: Request, res: Response) => {
  try {
    if (req.method !== "GET" && req.method !== "HEAD") {
      res.status(405).json({ error: "App proxy currently supports GET and HEAD only" });
      return;
    }

    const app = getRegisteredApp(req.params.appId, { sessionId: req.params.sessionId });
    if (!app.url) {
      res.status(409).json({ error: "App is not running" });
      return;
    }

    // Preserve the same-origin proxy path when forwarding. Vite apps can set
    // their base to PI_APP_BASE_PATH, so stripping the prefix makes Vite
    // redirect back to the base and causes a browser redirect loop.
    const targetUrl = new URL(req.originalUrl, app.url);
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) {
      if (!value) continue;
      if (!shouldForwardAppProxyRequestHeader(name)) continue;
      headers.set(name, Array.isArray(value) ? value.join(", ") : value);
    }
    headers.set("accept-encoding", "identity");

    const upstream = await fetch(targetUrl, {
      method: req.method,
      headers,
      redirect: "manual",
    });

    res.status(upstream.status);
    upstream.headers.forEach((value, name) => {
      if (!shouldForwardAppProxyResponseHeader(name)) return;
      res.setHeader(name, value);
    });

    if (req.method === "HEAD" || !upstream.body) {
      res.end();
      return;
    }

    Readable.fromWeb(upstream.body as any).pipe(res);
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/apps/:appId", (req: Request, res: Response) => {
  try {
    res.json(appFromRequest(req));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/apps/:appId/start", async (req: Request, res: Response) => {
  try {
    res.json(await startApp(appFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/apps/:appId/stop", async (req: Request, res: Response) => {
  try {
    res.json(await stopApp(appFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/apps/:appId/restart", async (req: Request, res: Response) => {
  try {
    res.json(await restartApp(appFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/apps/:appId/logs", (req: Request, res: Response) => {
  try {
    res.json({ lines: getAppLogs(appFromRequest(req)) });
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/apps/:appId/state", (req: Request, res: Response) => {
  try {
    res.json(getAppState(appFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.put("/apps/:appId/state", (req: Request, res: Response) => {
  try {
    const app = appFromRequest(req);
    res.json(setAppState(app, req.body?.state ?? null));
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/apps/:appId/events", (req: Request, res: Response) => {
  try {
    res.json(listAppEvents(appFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/apps/:appId/events", async (req: Request, res: Response) => {
  try {
    const app = appFromRequest(req);
    const event = await addAppEvent(app, {
      event: req.body?.event,
      payload: req.body?.payload,
      summary: req.body?.summary,
      sendToAgent: req.body?.sendToAgent === true,
      sessionId: typeof req.body?.sessionId === "string" ? req.body.sessionId : undefined,
    });
    res.status(201).json(event);
  } catch (err) {
    sendError(res, err);
  }
});
