import express, { type NextFunction, type Request, type Response, type Router } from "express";
import type { Server } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import type { AuthService, AuthenticatedSettingsOwner } from "../auth/service.js";
import type {
  ProtectedAutomationPreparationSelection,
  ProtectedAutomationProductionIntegration,
} from "../protected-automation/production.js";

function routeError(message: string, statusCode = 400): Error {
  return Object.assign(new Error(message), { statusCode });
}

function exactBody(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.getPrototypeOf(value) !== Object.prototype) {
    throw routeError("Request body must be an exact JSON object");
  }
  const actual = Object.keys(value as object).sort();
  if (actual.join("\0") !== [...keys].sort().join("\0")) throw routeError("Request body contains missing or unsupported fields");
  return value as Record<string, unknown>;
}

function preparationSelection(request: Request): ProtectedAutomationPreparationSelection {
  return {
    sourceSessionId: request.params.sourceSessionId,
    jobId: request.params.jobId,
    preparationId: request.params.preparationId,
  };
}

function owner(response: Response): AuthenticatedSettingsOwner {
  return response.locals.protectedAutomationOwner as AuthenticatedSettingsOwner;
}

function requireOwner(auth: AuthService) {
  return (request: Request, response: Response, next: NextFunction): void => {
    const resolution = auth.resolveSettingsOwner(request);
    response.setHeader("Cache-Control", "no-store");
    response.setHeader("Pragma", "no-cache");
    if (resolution.status === "invalid_origin") { response.status(403).json({ error: "Origin not allowed" }); return; }
    if (resolution.status === "unauthenticated") { response.status(401).json({ error: "Authentication required" }); return; }
    response.locals.protectedAutomationOwner = resolution.owner;
    next();
  };
}

function statusCode(error: unknown): number {
  const explicit = error && typeof error === "object" && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode) : NaN;
  return Number.isInteger(explicit) && explicit >= 400 && explicit <= 599 ? explicit : 500;
}

function asyncRoute(handler: (request: Request, response: Response) => Promise<void>) {
  return (request: Request, response: Response, next: NextFunction): void => { void handler(request, response).catch(next); };
}

export function createProtectedAutomationsRouter(
  auth: AuthService,
  integration: ProtectedAutomationProductionIntegration,
): Router {
  const router = express.Router();
  const json = express.json({ limit: "4kb", strict: true });
  router.use("/protected-automations", requireOwner(auth));

  const status = (_request: Request, response: Response) => {
    response.json({ milestone: 5, activationAvailable: true, production_services: true });
  };
  router.get("/protected-automations", status);
  router.get("/protected-automations/status", status);
  router.get("/protected-automations/jobs", (_request, response) => response.json({ jobs: integration.listJobs() }));
  router.get("/protected-automations/jobs/:jobId", (request, response, next) => {
    try { response.json({ job: integration.getJob(request.params.jobId) }); } catch (error) { next(error); }
  });
  router.get("/protected-automations/jobs/:jobId/runs", (request, response, next) => {
    try { response.json({ runs: integration.listRuns(request.params.jobId) }); } catch (error) { next(error); }
  });
  router.post("/protected-automations/jobs/:jobId/pause", json, (request, response, next) => {
    try {
      const body = exactBody(request.body, ["expectedRevision"]);
      if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) {
        throw routeError("expectedRevision is invalid");
      }
      response.json({ job: integration.pauseJob(owner(response), request.params.jobId, Number(body.expectedRevision)) });
    } catch (error) { next(error); }
  });
  router.post("/protected-automations/jobs/:jobId/runs/:runId/cancel", json, (request, response, next) => {
    try {
      if (!request.is("application/json")) throw routeError("An exact JSON body is required");
      exactBody(request.body, []);
      response.json({ run: integration.cancelRun(owner(response), request.params.jobId, request.params.runId) });
    } catch (error) { next(error); }
  });

  const preparationBase = "/protected-automations/sources/:sourceSessionId/jobs/:jobId/preparations/:preparationId";
  router.get(preparationBase, (request, response, next) => {
    try { response.json(integration.getPreparation(owner(response), preparationSelection(request))); } catch (error) { next(error); }
  });
  router.post(`${preparationBase}/close`, json, asyncRoute(async (request, response) => {
    exactBody(request.body ?? {}, []);
    await integration.closePreparation(owner(response), preparationSelection(request));
    response.status(204).end();
  }));
  router.post(`${preparationBase}/navigate`, json, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, ["url"]);
    if (typeof body.url !== "string" || !body.url) throw routeError("url is required");
    response.json(await integration.navigatePreparation(owner(response), preparationSelection(request), body.url));
  }));
  router.post(`${preparationBase}/credentials/status`, json, asyncRoute(async (request, response) => {
    exactBody(request.body ?? {}, []);
    response.json(await integration.credentialStatus(owner(response), preparationSelection(request)));
  }));
  router.post(`${preparationBase}/credentials/matches`, json, asyncRoute(async (request, response) => {
    exactBody(request.body ?? {}, []);
    response.json(await integration.credentialMatches(owner(response), preparationSelection(request)));
  }));
  const fill = (operation: "login" | "totp") => asyncRoute(async (request, response) => {
    const body = exactBody(request.body, ["choiceToken"]);
    if (typeof body.choiceToken !== "string" || !body.choiceToken) throw routeError("choiceToken is required");
    response.json(await integration.credentialFill(owner(response), preparationSelection(request), body.choiceToken, operation));
  });
  router.post(`${preparationBase}/credentials/fill`, json, fill("login"));
  router.post(`${preparationBase}/credentials/fill-totp`, json, fill("totp"));
  router.post(`${preparationBase}/credentials/lock`, json, asyncRoute(async (request, response) => {
    exactBody(request.body ?? {}, []);
    await integration.credentialLock(owner(response), preparationSelection(request));
    response.json({ locked: true });
  }));

  router.post("/protected-automations/jobs/:jobId/purge-requests", json, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, ["expectedRevision"]);
    if (!Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision) < 1) throw routeError("expectedRevision is invalid");
    response.status(201).json(await integration.requestPurge(owner(response), request.params.jobId, Number(body.expectedRevision)));
  }));
  router.post("/protected-automations/jobs/:jobId/purge-requests/:requestId/commit", json, asyncRoute(async (request, response) => {
    const body = exactBody(request.body, ["pin"]);
    if (typeof body.pin !== "string") throw routeError("PIN commit must contain exactly one PIN field");
    const pin = body.pin;
    request.body = undefined;
    response.json(await integration.commitPurge(owner(response), request.params.jobId, request.params.requestId, pin));
  }));
  router.delete("/protected-automations/jobs/:jobId/purge-requests/:requestId", asyncRoute(async (request, response) => {
    await integration.cancelPurge(owner(response), request.params.jobId, request.params.requestId);
    response.status(204).end();
  }));

  router.use((failure: unknown, _request: Request, response: Response, _next: NextFunction) => {
    const status = statusCode(failure);
    const parserStatus = failure && typeof failure === "object" && "status" in failure
      ? Number((failure as { status?: unknown }).status) : NaN;
    const resolvedStatus = parserStatus === 400 || parserStatus === 413 ? parserStatus : status;
    const retryAt = failure && typeof failure === "object" && "retryAt" in failure
      ? Number((failure as { retryAt?: unknown }).retryAt) : NaN;
    if (resolvedStatus === 429 && Number.isFinite(retryAt)) {
      response.setHeader("Retry-After", Math.max(1, Math.ceil((retryAt - Date.now()) / 1_000)));
    }
    response.status(resolvedStatus).json({
      error: resolvedStatus >= 500 ? "Protected automation operation failed" : failure instanceof Error ? failure.message : "Protected automation operation failed",
    });
  });
  return router;
}

function exactQuery(url: URL): ProtectedAutomationPreparationSelection {
  const allowed = new Set(["source_session_id", "job_id"]);
  if ([...url.searchParams.keys()].some((key) => !allowed.has(key))
    || url.searchParams.getAll("source_session_id").length !== 1
    || url.searchParams.getAll("job_id").length !== 1) throw routeError("Exact preparation WebSocket selection is required", 403);
  const parts = /^\/ws\/protected-automations\/preparations\/([^/]+)$/u.exec(url.pathname);
  if (!parts) throw routeError("Preparation WebSocket path is invalid", 404);
  let preparationId: string;
  try { preparationId = decodeURIComponent(parts[1]!); } catch { throw routeError("Preparation WebSocket path is invalid", 400); }
  return { sourceSessionId: url.searchParams.get("source_session_id")!, jobId: url.searchParams.get("job_id")!, preparationId };
}

export function attachProtectedAutomationWs(
  server: Server,
  auth: AuthService,
  integration: ProtectedAutomationProductionIntegration,
): () => void {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  let closed = false;
  const handleUpgrade: Parameters<Server["on"]>[1] = (request: any, socket: any, head: any) => {
    const url = new URL(request.url || "", "http://localhost");
    if (!url.pathname.startsWith("/ws/protected-automations/preparations/")) return;
    if (closed) { socket.destroy(); return; }
    let selection: ProtectedAutomationPreparationSelection;
    try { selection = exactQuery(url); } catch {
      auth.rejectWebSocket(socket, { allowed: false, status: 403, message: "Preparation transport denied" });
      return;
    }
    const decision = auth.authorizeWebSocket(request);
    if (!decision.allowed) { auth.rejectWebSocket(socket, decision); return; }
    const resolution = auth.resolveSettingsOwner(request);
    if (resolution.status !== "authenticated") {
      auth.rejectWebSocket(socket, { allowed: false, status: resolution.status === "invalid_origin" ? 403 : 401,
        message: resolution.status === "invalid_origin" ? "Origin not allowed" : "Authentication required" });
      return;
    }
    try { integration.getPreparation(resolution.owner, selection); }
    catch { auth.rejectWebSocket(socket, { allowed: false, status: 403, message: "Preparation transport denied" }); return; }
    wss.handleUpgrade(request, socket, head, (ws) => {
      void integration.openPreparationViewer(resolution.owner, selection).then((transport) => {
        const unsubscribe = transport.onMessage((message, isBinary) => {
          if (ws.readyState === WebSocket.OPEN) ws.send(message, { binary: isBinary });
        });
        const close = () => { unsubscribe(); void transport.close(); };
        ws.on("message", (raw, isBinary) => {
          const message = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
          void transport.dispatch(message, isBinary).catch(() => ws.close(1008, "Preparation authority ended"));
        });
        ws.on("close", close);
        ws.on("error", close);
      }).catch(() => ws.close(1008, "Preparation transport denied"));
    });
  };
  server.on("upgrade", handleUpgrade);
  return () => {
    if (closed) return;
    closed = true;
    server.off("upgrade", handleUpgrade);
    for (const ws of wss.clients) ws.terminate();
    wss.close();
  };
}
