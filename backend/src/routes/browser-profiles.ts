import express, { type RequestHandler, type Router } from "express";
import {
  createManagedBrowserProfile,
  getProjectBrowserDefault,
  getSessionBrowserState,
  listBrowserProfiles,
  materializeSessionBrowserState,
  renameBrowserProfile,
  requestBrowserProfileTrash,
  restoreTrashedBrowserProfile,
  setBrowserProfileEnabled,
  setProjectBrowserDefault,
  setSessionBrowserProfile,
} from "../browser/profile-catalog.js";
import { getSessionById } from "../sessions.js";
import { getProject } from "../projects.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import type { StandardBrowserProfileHostService } from "../browser/standard-service.js";

function exactObject(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkspaceStoreError("Invalid Browser Profile request", 400);
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !keys.includes(key))) throw new WorkspaceStoreError("Unsupported Browser Profile request field", 400);
  return record;
}

function revision(value: unknown): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new WorkspaceStoreError("Browser Profile revision is invalid", 400);
  return parsed;
}

function nullableRevision(value: unknown): number | null {
  return value === null ? null : revision(value);
}

function asyncHandler(handler: (req: express.Request, res: express.Response) => Promise<void> | void): RequestHandler {
  return (req, res) => {
    void Promise.resolve().then(() => handler(req, res)).catch((error) => {
      const status = error instanceof WorkspaceStoreError ? error.statusCode : 500;
      res.setHeader("Cache-Control", "no-store");
      res.status(status).json({ error: status >= 500 ? "Browser Profile operation failed" : error instanceof Error ? error.message : "Browser Profile operation failed" });
    });
  };
}

export function createBrowserProfilesRouter(enabled: boolean, service?: StandardBrowserProfileHostService): Router {
  const router = express.Router();
  router.use("/browser-profiles", (_req, res, next) => {
    res.setHeader("Cache-Control", "no-store");
    if (!enabled) { res.status(404).json({ error: "Browser Profiles are disabled" }); return; }
    next();
  });
  router.get("/browser-profiles", (_req, res) => {
    res.json({
      profiles: listBrowserProfiles(),
      consequence: "Authenticated state in a named Standard Browser Profile is shared with every approved Standard-browser Project/Agent pair.",
    });
  });
  router.post("/browser-profiles", asyncHandler((req, res) => {
    const body = exactObject(req.body, ["name", "confirmSharedState"]);
    if (body.confirmSharedState !== true) throw new WorkspaceStoreError("Shared authenticated-state confirmation is required", 400);
    const profile = createManagedBrowserProfile(typeof body.name === "string" ? body.name : "");
    res.status(201).json({ profile });
  }));
  router.patch("/browser-profiles/:profileId", asyncHandler(async (req, res) => {
    const body = exactObject(req.body, ["expectedRevision", "name", "enabled"]);
    const expectedRevision = revision(body.expectedRevision);
    const hasName = Object.hasOwn(body, "name");
    const hasEnabled = Object.hasOwn(body, "enabled");
    if (hasName === hasEnabled) throw new WorkspaceStoreError("Change exactly one Browser Profile field", 400);
    const profile = hasName
      ? renameBrowserProfile(req.params.profileId, expectedRevision, typeof body.name === "string" ? body.name : "")
      : setBrowserProfileEnabled(req.params.profileId, expectedRevision, body.enabled === true);
    await service?.invalidateProfile(req.params.profileId);
    res.json({ profile });
  }));
  router.post("/browser-profiles/:profileId/trash", asyncHandler(async (req, res) => {
    const body = exactObject(req.body, ["expectedRevision"]);
    const result = requestBrowserProfileTrash(req.params.profileId, revision(body.expectedRevision));
    await service?.invalidateProfile(req.params.profileId);
    res.status(202).json(result);
  }));
  router.post("/browser-profiles/:profileId/restore", asyncHandler((req, res) => {
    const body = exactObject(req.body, ["expectedRevision"]);
    res.json({ profile: restoreTrashedBrowserProfile(req.params.profileId, revision(body.expectedRevision)) });
  }));
  router.get("/browser-profiles/projects/:projectId/default", asyncHandler((req, res) => {
    if (!getProject(req.params.projectId)) throw new WorkspaceStoreError("Project not found", 404);
    res.json({ default: getProjectBrowserDefault(req.params.projectId) });
  }));
  router.put("/browser-profiles/projects/:projectId/default", asyncHandler((req, res) => {
    if (!getProject(req.params.projectId)) throw new WorkspaceStoreError("Project not found", 404);
    const body = exactObject(req.body, ["profileId", "expectedRevision"]);
    const profileId = body.profileId === null ? null : typeof body.profileId === "string" ? body.profileId : undefined;
    if (profileId === undefined) throw new WorkspaceStoreError("Browser Profile selection is invalid", 400);
    const value = setProjectBrowserDefault({
      projectId: req.params.projectId,
      profileId,
      expectedRevision: nullableRevision(body.expectedRevision),
      updatedBy: "owner",
    });
    res.json({ default: value });
  }));
  router.get("/browser-profiles/sessions/:sessionId/state", asyncHandler((req, res) => {
    if (!getSessionById(req.params.sessionId)) throw new WorkspaceStoreError("Session not found", 404);
    res.json({ state: getSessionBrowserState(req.params.sessionId) });
  }));
  router.put("/browser-profiles/sessions/:sessionId/state", asyncHandler((req, res) => {
    if (!getSessionById(req.params.sessionId)) throw new WorkspaceStoreError("Session not found", 404);
    const body = exactObject(req.body, ["profileId", "expectedRevision"]);
    const profileId = body.profileId === null ? null : typeof body.profileId === "string" ? body.profileId : undefined;
    if (profileId === undefined) throw new WorkspaceStoreError("Browser Profile selection is invalid", 400);
    const current = getSessionBrowserState(req.params.sessionId) ?? materializeSessionBrowserState(req.params.sessionId);
    const expectedRevision = revision(body.expectedRevision);
    if (current.revision !== expectedRevision) throw new WorkspaceStoreError("Session Browser state changed; refresh and retry", 409);
    res.json({ state: setSessionBrowserProfile({ sessionId: req.params.sessionId, profileId, expectedRevision }) });
  }));
  return router;
}
