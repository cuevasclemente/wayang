import { Router, type Request, type Response } from "express";
import type { AuthService } from "../auth/service.js";
import { CredentialBroker } from "../browser/credentials.js";
import {
  allowAgentAfterCredentialFill,
  fillBrowserCredential,
  getBrowserCredentialContext,
  getPublicBrowserStatus,
  recordBrowserCredentialFill,
  setBrowserControlMode,
} from "../browser/manager.js";
import { assertGenericBrowserTargetAllowed, isBrowserAgentRequest } from "../browser/request-auth.js";
import type { BrowserSessionLookup } from "../browser/types.js";

function lookupFromRequest(req: Request): BrowserSessionLookup {
  const body = req.body ?? {};
  const sessionId = typeof req.query.session_id === "string" ? req.query.session_id
    : typeof body.sessionId === "string" ? body.sessionId
      : typeof body.session_id === "string" ? body.session_id : undefined;
  const projectCwd = typeof req.query.project_cwd === "string" ? req.query.project_cwd
    : typeof body.projectCwd === "string" ? body.projectCwd
      : typeof body.project_cwd === "string" ? body.project_cwd : undefined;
  const requested = body.persistence ?? req.query.persistence;
  const persistence = requested === "session" ? "session" : requested === "project" ? "project" : "shared";
  return { sessionId, projectCwd, persistence };
}

function statusForError(error: unknown): number {
  const message = error instanceof Error ? error.message : String(error);
  if (/Bitwarden CLI is unavailable/i.test(message)) return 503;
  if (/not connected|expired|already used|no longer valid|authorization is unavailable/i.test(message)) return 409;
  if (/required|invalid|unsafe|origin/i.test(message)) return 400;
  return 500;
}

function sendError(res: Response, error: unknown): void {
  const message = error instanceof Error ? error.message : "Credential operation failed";
  res.status(statusForError(error)).json({ error: message });
}

function requireExactUiOrigin(auth: AuthService, req: Request): boolean {
  const raw = req.headers.origin;
  if (typeof raw !== "string" || !raw || raw === "null") return false;
  try {
    return raw === new URL(raw).origin && auth.originIsValid(req);
  } catch {
    return false;
  }
}

function rejectSecretBearingParameters(req: Request, allowChoiceToken = true): void {
  const allowed = new Set(["sessionId", "session_id", "projectCwd", "project_cwd", "persistence", ...(allowChoiceToken ? ["choiceToken"] : [])]);
  for (const key of Object.keys(req.body ?? {})) {
    if (!allowed.has(key)) throw new Error(`Invalid credential request parameter: ${key}`);
  }
}

export interface BrowserCredentialsRouterOptions {
  assertGenericTargetAllowed?: (lookup: BrowserSessionLookup) => void;
}

export function createBrowserCredentialsRouter(
  auth: AuthService,
  broker: CredentialBroker,
  options: BrowserCredentialsRouterOptions = {},
): Router {
  const router = Router();
  const assertTarget = options.assertGenericTargetAllowed ?? assertGenericBrowserTargetAllowed;

  router.use("/browser/credentials", (req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      // This is deliberately before broker.status(), credential context, and
      // every generic browser-manager lookup in the handlers below.
      assertTarget(lookupFromRequest(req));
    } catch {
      res.status(403).json({ error: "Protected targets cannot use the generic credential broker" });
      return;
    }
    if (isBrowserAgentRequest(req)) {
      res.status(403).json({ error: "Credential routes are UI-only" });
      return;
    }
    if (!requireExactUiOrigin(auth, req)) {
      res.status(403).json({ error: "An exact allowed Origin is required" });
      return;
    }
    next();
  });

  // This is intentionally POST: browsers do not reliably attach Origin to a
  // same-origin GET, while the credential surface requires an exact non-empty
  // Origin on every request.
  router.post("/browser/credentials/status", async (req: Request, res: Response) => {
    const status = broker.status();
    try {
      const context = await getBrowserCredentialContext(lookupFromRequest(req));
      res.json({ ...status, origin: context.origin });
    } catch {
      res.json({ ...status, origin: null });
    }
  });

  router.post("/browser/credentials/matches", async (req: Request, res: Response) => {
    try {
      rejectSecretBearingParameters(req);
      const lookup = lookupFromRequest(req);
      setBrowserControlMode(lookup, "user", "Credential picker is open");
      const context = await getBrowserCredentialContext(lookup);
      res.json(await broker.matches(context));
    } catch (error) {
      sendError(res, error);
    }
  });

  const fill = (operation: "login" | "totp") => async (req: Request, res: Response) => {
    try {
      rejectSecretBearingParameters(req);
      const token = typeof req.body?.choiceToken === "string" ? req.body.choiceToken : "";
      if (!token) throw new Error("choiceToken is required");
      const lookup = lookupFromRequest(req);
      setBrowserControlMode(lookup, "user", "Credential fill requires explicit Resume Agent");
      const context = await getBrowserCredentialContext(lookup);
      let redactionValues: { username?: string; password?: string; totp?: string } | null = null;
      const result = await broker.fill(token, operation, context, async (values) => {
        const latest = await getBrowserCredentialContext(lookup);
        if (latest.runtimeKey !== context.runtimeKey || latest.targetId !== context.targetId || latest.documentIdentity !== context.documentIdentity || latest.origin !== context.origin) {
          throw new Error("Credential choice is no longer valid for this page");
        }
        const filled = await fillBrowserCredential(lookup, values, context);
        redactionValues = values;
        return filled;
      });
      if (!redactionValues) throw new Error("Credential fill did not complete");
      recordBrowserCredentialFill(lookup, context, redactionValues);
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  };

  router.post("/browser/credentials/fill", fill("login"));
  router.post("/browser/credentials/fill-totp", fill("totp"));

  router.post("/browser/credentials/allow-agent-inspection", async (req: Request, res: Response) => {
    try {
      rejectSecretBearingParameters(req, false);
      const lookup = lookupFromRequest(req);
      await allowAgentAfterCredentialFill(lookup);
      res.json({
        allowedInspection: "text-only",
        screenshotsAllowed: false,
        mutationsAllowed: false,
        state: getPublicBrowserStatus(lookup, "ui"),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  router.post("/browser/credentials/lock", async (req: Request, res: Response) => {
    try {
      rejectSecretBearingParameters(req);
      await broker.lock();
      res.json({ locked: true });
    } catch (error) {
      sendError(res, error);
    }
  });

  return router;
}
