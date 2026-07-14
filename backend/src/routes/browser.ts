import { Router, type Request, type Response } from "express";
import {
  browserAccessibilitySnapshot,
  browserDomSnapshot,
  browserSnapshot,
  clickBrowser,
  clickBrowserSelector,
  extractBrowserLinks,
  fillBrowserSelector,
  getBrowserStatus,
  listBrowserSessions,
  navigateBrowser,
  pasteTextBrowser,
  queryBrowserSelector,
  resetBrowserProfile,
  restartBrowser,
  setBrowserControlMode,
  startBrowser,
  stopBrowser,
  typePublicBrowser,
} from "../browser/manager.js";
import type { BrowserControlMode, BrowserSessionLookup } from "../browser/types.js";

export const router = Router();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendError(res: Response, err: unknown): void {
  const message = errorMessage(err);
  const status = /not found/i.test(message) ? 404 : /required|invalid/i.test(message) ? 400 : 500;
  res.status(status).json({ error: message });
}

function lookupFromRequest(req: Request): BrowserSessionLookup {
  const body = req.body ?? {};
  const sessionId = typeof req.query.session_id === "string"
    ? req.query.session_id
    : typeof body.sessionId === "string"
      ? body.sessionId
      : typeof body.session_id === "string"
        ? body.session_id
        : undefined;
  const projectCwd = typeof req.query.project_cwd === "string"
    ? req.query.project_cwd
    : typeof body.projectCwd === "string"
      ? body.projectCwd
      : typeof body.project_cwd === "string"
        ? body.project_cwd
        : undefined;
  const persistence = body.persistence === "session" || req.query.persistence === "session" ? "session" : "project";
  return { sessionId, projectCwd, persistence };
}

function normalizeControlMode(value: unknown): BrowserControlMode | null {
  return value === "agent" || value === "user" || value === "paused" ? value : null;
}

router.get("/browser/sessions", (_req: Request, res: Response) => {
  res.json({ sessions: listBrowserSessions() });
});

router.get("/browser/status", (req: Request, res: Response) => {
  try {
    res.json(getBrowserStatus(lookupFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/start", async (req: Request, res: Response) => {
  try {
    res.json(await startBrowser(lookupFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/stop", async (req: Request, res: Response) => {
  try {
    res.json(await stopBrowser(lookupFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/restart", async (req: Request, res: Response) => {
  try {
    res.json(await restartBrowser(lookupFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/reset-profile", async (req: Request, res: Response) => {
  try {
    res.json(await resetBrowserProfile(lookupFromRequest(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/control-mode", (req: Request, res: Response) => {
  try {
    const mode = normalizeControlMode(req.body?.mode);
    if (!mode) throw new Error("Invalid control mode");
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    res.json(setBrowserControlMode(lookupFromRequest(req), mode, reason));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/navigate", async (req: Request, res: Response) => {
  try {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) throw new Error("url is required");
    res.json(await navigateBrowser(lookupFromRequest(req), url));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/snapshot", async (req: Request, res: Response) => {
  try {
    const mode = req.body?.mode === "screenshot" ? "screenshot" : "text";
    res.json(await browserSnapshot(lookupFromRequest(req), mode));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/dom-snapshot", async (req: Request, res: Response) => {
  try {
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    res.json(await browserDomSnapshot(lookupFromRequest(req), { includeText: Boolean(req.body?.includeText), limit }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/query-selector", async (req: Request, res: Response) => {
  try {
    const selector = typeof req.body?.selector === "string" ? req.body.selector.trim() : "";
    if (!selector) throw new Error("selector is required");
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    res.json(await queryBrowserSelector(lookupFromRequest(req), selector, { limit }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/click-selector", async (req: Request, res: Response) => {
  try {
    const selector = typeof req.body?.selector === "string" ? req.body.selector.trim() : "";
    if (!selector) throw new Error("selector is required");
    const index = req.body?.index === undefined ? 0 : Number(req.body.index);
    if (!Number.isFinite(index) || index < 0) throw new Error("index must be a non-negative number");
    res.json(await clickBrowserSelector(lookupFromRequest(req), selector, index));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/fill-selector", async (req: Request, res: Response) => {
  try {
    const selector = typeof req.body?.selector === "string" ? req.body.selector.trim() : "";
    if (!selector) throw new Error("selector is required");
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const index = req.body?.index === undefined ? 0 : Number(req.body.index);
    if (!Number.isFinite(index) || index < 0) throw new Error("index must be a non-negative number");
    res.json(await fillBrowserSelector(lookupFromRequest(req), selector, text, index));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/links", async (req: Request, res: Response) => {
  try {
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    res.json(await extractBrowserLinks(lookupFromRequest(req), { limit }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/accessibility", async (req: Request, res: Response) => {
  try {
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    res.json(await browserAccessibilitySnapshot(lookupFromRequest(req), { limit }));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/click", async (req: Request, res: Response) => {
  try {
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y are required numeric coordinates");
    res.json(await clickBrowser(lookupFromRequest(req), x, y));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/type-public", async (req: Request, res: Response) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text) throw new Error("text is required");
    res.json(await typePublicBrowser(lookupFromRequest(req), text));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/paste-text", async (req: Request, res: Response) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text) throw new Error("text is required");
    res.json(await pasteTextBrowser(lookupFromRequest(req), text));
  } catch (err) {
    sendError(res, err);
  }
});
