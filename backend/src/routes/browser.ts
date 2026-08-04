import { Router, type Request, type RequestHandler, type Response } from "express";
import {
  browserAccessibilitySnapshot,
  browserDomSnapshot,
  browserSnapshot,
  clickBrowser,
  clickBrowserSelector,
  extractBrowserLinks,
  fillBrowserSelector,
  assertBrowserAgentControl,
  getPublicBrowserStatus,
  listPublicBrowserSessions,
  navigateBrowser,
  pasteTextBrowser,
  queryBrowserSelector,
  refreshBrowserNavigationState,
  resetBrowserProfile,
  restartBrowser,
  sanitizeBrowserErrorMessage,
  setBrowserControlMode,
  startBrowser,
  stopBrowser,
  typePublicBrowser,
} from "../browser/manager.js";
import type { BrowserControlMode, BrowserSessionLookup } from "../browser/types.js";
import { assertGenericBrowserTargetAllowed, authorizeBrowserAgentTarget, isBrowserAgentRequest } from "../browser/request-auth.js";

export const router = Router();

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function sendError(res: Response, err: unknown): void {
  const message = errorMessage(err);
  const explicit = err && typeof err === "object" && "statusCode" in err ? Number((err as { statusCode?: unknown }).statusCode) : NaN;
  const status = Number.isInteger(explicit) && explicit >= 400 && explicit <= 599
    ? explicit
    : /not found/i.test(message) ? 404 : /required|invalid/i.test(message) ? 400 : 500;
  res.status(status).json({ error: status >= 500 ? sanitizeBrowserErrorMessage(err) : message });
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
  const requestedPersistence = body.persistence ?? req.query.persistence;
  const persistence = requestedPersistence === "session" ? "session" : requestedPersistence === "project" ? "project" : "shared";
  return { sessionId, projectCwd, persistence };
}

function requireAgentControl(req: Request, lookup: BrowserSessionLookup): number | undefined {
  return isBrowserAgentRequest(req) ? assertBrowserAgentControl(lookup) : undefined;
}

function publicActor(req: Request): "ui" | "agent" {
  return isBrowserAgentRequest(req) ? "agent" : "ui";
}

function sendState(req: Request, res: Response, lookup: BrowserSessionLookup): void {
  res.json(getPublicBrowserStatus(lookup, publicActor(req)));
}

export function createGenericBrowserProtectedIsolation(
  assertTarget: (lookup: BrowserSessionLookup) => void = assertGenericBrowserTargetAllowed,
): RequestHandler {
  return (req, res, next) => {
    try {
      assertTarget(lookupFromRequest(req));
      next();
    } catch {
      res.setHeader("Cache-Control", "no-store");
      res.status(403).json({ error: "Protected targets require capability-bound browser routes" });
    }
  };
}


function normalizeControlMode(value: unknown): BrowserControlMode | null {
  return value === "agent" || value === "user" || value === "paused" ? value : null;
}

// Durable Protected classification precedes agent authorization and every
// generic browser manager/registry lookup.
router.use("/browser/:operation", createGenericBrowserProtectedIsolation());

router.use("/browser/:operation", (req: Request, res: Response, next) => {
  try {
    if (isBrowserAgentRequest(req)) {
      const lookup = lookupFromRequest(req);
      authorizeBrowserAgentTarget(req, lookup);
      if (!["status", "sessions", "control-mode"].includes(req.params.operation)) {
        requireAgentControl(req, lookup);
      }
    }
    next();
  } catch (err) {
    sendError(res, err);
  }
});

router.get("/browser/sessions", (req: Request, res: Response) => {
  res.json({ sessions: listPublicBrowserSessions(publicActor(req)) });
});

router.get("/browser/status", (req: Request, res: Response) => {
  try {
    res.json(getPublicBrowserStatus(lookupFromRequest(req), publicActor(req)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/start", async (req: Request, res: Response) => {
  try {
    const lookup = lookupFromRequest(req);
    await startBrowser(lookup, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/stop", async (req: Request, res: Response) => {
  try {
    const lookup = lookupFromRequest(req);
    await stopBrowser(lookup, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/restart", async (req: Request, res: Response) => {
  try {
    const lookup = lookupFromRequest(req);
    await restartBrowser(lookup, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/reset-profile", async (req: Request, res: Response) => {
  try {
    const lookup = lookupFromRequest(req);
    await resetBrowserProfile(lookup, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/control-mode", async (req: Request, res: Response) => {
  try {
    const mode = normalizeControlMode(req.body?.mode);
    if (!mode) throw new Error("Invalid control mode");
    const reason = typeof req.body?.reason === "string" ? req.body.reason : undefined;
    const lookup = lookupFromRequest(req);
    if (isBrowserAgentRequest(req) && mode === "agent") requireAgentControl(req, lookup);
    if (!isBrowserAgentRequest(req) && mode === "agent") await refreshBrowserNavigationState(lookup);
    setBrowserControlMode(lookup, mode, reason);
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/navigate", async (req: Request, res: Response) => {
  try {
    const url = typeof req.body?.url === "string" ? req.body.url.trim() : "";
    if (!url) throw new Error("url is required");
    const lookup = lookupFromRequest(req);
    const generation = requireAgentControl(req, lookup);
    await navigateBrowser(lookup, url, generation);
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/snapshot", async (req: Request, res: Response) => {
  try {
    const mode = req.body?.mode === "screenshot" ? "screenshot" : "text";
    const lookup = lookupFromRequest(req);
    res.json(await browserSnapshot(lookup, mode, requireAgentControl(req, lookup)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/dom-snapshot", async (req: Request, res: Response) => {
  try {
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    const lookup = lookupFromRequest(req);
    res.json(await browserDomSnapshot(lookup, { includeText: Boolean(req.body?.includeText), limit }, requireAgentControl(req, lookup)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/query-selector", async (req: Request, res: Response) => {
  try {
    const selector = typeof req.body?.selector === "string" ? req.body.selector.trim() : "";
    if (!selector) throw new Error("selector is required");
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    const lookup = lookupFromRequest(req);
    res.json(await queryBrowserSelector(lookup, selector, { limit }, requireAgentControl(req, lookup)));
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
    const lookup = lookupFromRequest(req);
    await clickBrowserSelector(lookup, selector, index, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
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
    const lookup = lookupFromRequest(req);
    await fillBrowserSelector(lookup, selector, text, index, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/links", async (req: Request, res: Response) => {
  try {
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    const lookup = lookupFromRequest(req);
    res.json(await extractBrowserLinks(lookup, { limit }, requireAgentControl(req, lookup)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/accessibility", async (req: Request, res: Response) => {
  try {
    const limit = req.body?.limit === undefined ? undefined : Number(req.body.limit);
    const lookup = lookupFromRequest(req);
    res.json(await browserAccessibilitySnapshot(lookup, { limit }, requireAgentControl(req, lookup)));
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/click", async (req: Request, res: Response) => {
  try {
    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("x and y are required numeric coordinates");
    const lookup = lookupFromRequest(req);
    await clickBrowser(lookup, x, y, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/type-public", async (req: Request, res: Response) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text) throw new Error("text is required");
    const lookup = lookupFromRequest(req);
    await typePublicBrowser(lookup, text, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});

router.post("/browser/paste-text", async (req: Request, res: Response) => {
  try {
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    if (!text) throw new Error("text is required");
    const lookup = lookupFromRequest(req);
    await pasteTextBrowser(lookup, text, requireAgentControl(req, lookup));
    sendState(req, res, lookup);
  } catch (err) {
    sendError(res, err);
  }
});
