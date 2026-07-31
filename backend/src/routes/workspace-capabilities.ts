import express, { type NextFunction, type Request, type Response, type Router } from "express";
import { CapabilityApprovalError } from "../workspace-capability-approval/errors.js";
import type { WorkspaceCapabilityApprovalService } from "../workspace-capability-approval/service.js";
import type { SettingsRequestOwner } from "../workspace-capability-approval/types.js";

export type SettingsOwnerResolution =
  | { status: "authenticated"; owner: SettingsRequestOwner }
  | { status: "unauthenticated"; previousOwner?: SettingsRequestOwner }
  | { status: "invalid_origin" };

/** Resolves the exact authenticated web session and exact validated Origin. */
export interface SettingsOwnerBridge {
  resolve(request: Request): SettingsOwnerResolution | Promise<SettingsOwnerResolution>;
}

export interface WorkspaceCapabilitiesRouterOptions {
  service: WorkspaceCapabilityApprovalService;
  owners: SettingsOwnerBridge;
}

export function createWorkspaceCapabilitiesRouter(options: WorkspaceCapabilitiesRouterOptions): Router {
  const router = express.Router();

  router.use(["/workspace-capabilities", "/workspace-capability-associations"], (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Pragma", "no-cache");
    next();
  });
  // Mount before broad auth/JSON. Rejected requests never submit or parse PIN material.
  const approvalJson = express.json({ limit: "4kb", strict: true });
  const pinJson = express.json({ limit: "256b", strict: true });

  router.get("/workspace-capabilities", requireSettingsOwner(options), asyncRoute(async (req, res) => {
    res.json(await options.service.status(req.query.history_limit));
  }));

  router.post("/workspace-capabilities/requests", requireSettingsOwner(options), approvalJson, asyncRoute(async (req, res) => {
    const challenge = await options.service.requestActivation(settingsOwner(res), req.body);
    res.status(201).json(challenge);
  }));

  router.post("/workspace-capabilities/requests/:id/commit", requireSettingsOwner(options, true), pinJson, asyncRoute(async (req, res) => {
    const body = req.body;
    const exactBody = body && typeof body === "object" && !Array.isArray(body)
      && Object.keys(body).length === 1 && Object.hasOwn(body, "pin") && typeof body.pin === "string";
    if (!exactBody) {
      req.body = undefined;
      await options.service.cancel(settingsOwner(res), req.params.id);
      throw new CapabilityApprovalError("invalid_request", "PIN commit must contain exactly one PIN field", 400);
    }
    const pin = body.pin as string;
    req.body = undefined;
    const result = await options.service.commit(settingsOwner(res), req.params.id, pin);
    res.status(201).json(result);
  }));

  router.delete("/workspace-capabilities/requests/:id", requireSettingsOwner(options, true), asyncRoute(async (req, res) => {
    await options.service.cancel(settingsOwner(res), req.params.id);
    res.status(204).end();
  }));

  // Revocation addresses live authority, never an approval-history event ID.
  router.post("/workspace-capability-associations/revoke", requireSettingsOwner(options), approvalJson, asyncRoute(async (req, res) => {
    const association = await options.service.revoke(settingsOwner(res), req.body);
    res.json({ association });
  }));

  router.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof CapabilityApprovalError) {
      if (error.retryAt !== undefined) res.setHeader("Retry-After", Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000)));
      res.status(error.statusCode).json({ error: error.message, code: error.code });
      return;
    }
    const parserStatus = typeof error === "object" && error !== null && "status" in error
      ? (error as { status?: unknown }).status : undefined;
    const status = parserStatus === 400 ? 400 : parserStatus === 413 ? 413 : 500;
    res.status(status).json({
      error: status === 400 ? "Invalid JSON request body" : status === 413 ? "Request body is too large" : "Capability approval failed",
    });
  });

  return router;
}

function requireSettingsOwner(options: WorkspaceCapabilitiesRouterOptions, abandonApprovalOnAuthLoss = false) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void Promise.resolve().then(() => options.owners.resolve(req)).then(async (resolution) => {
      if (resolution.status === "unauthenticated") {
        if (abandonApprovalOnAuthLoss && resolution.previousOwner && req.params.id) {
          await options.service.cancel(resolution.previousOwner, req.params.id, true).catch(() => undefined);
        }
        throw new CapabilityApprovalError("unauthenticated", "Authentication required", 401);
      }
      if (resolution.status === "invalid_origin") throw new CapabilityApprovalError("invalid_origin", "Origin not allowed", 403);
      res.locals.workspaceCapabilitySettingsOwner = resolution.owner;
      next();
    }).catch(next);
  };
}

function settingsOwner(response: Response): SettingsRequestOwner {
  return response.locals.workspaceCapabilitySettingsOwner as SettingsRequestOwner;
}

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    void handler(req, res).catch(next);
  };
}
