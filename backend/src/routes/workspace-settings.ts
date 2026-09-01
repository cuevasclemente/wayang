import { Router, type Request, type Response } from "express";
import { WorkspaceStoreError } from "../workspace-types.js";
import { workspaceSettingsService } from "../workspace-settings-service.js";

export const router = Router();

const UPDATE_KEYS = new Set(["default_agent_profile_id"]);

function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) {
    throw new WorkspaceStoreError("Request body must be a JSON object");
  }
  return req.body as Record<string, unknown>;
}

function fail(res: Response, error: unknown): void {
  const status = error instanceof WorkspaceStoreError ? error.statusCode : 500;
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

router.get("/workspace-settings", (_req, res) => {
  try {
    res.json(workspaceSettingsService.getWorkspaceSettingsForUi());
  } catch (error) { fail(res, error); }
});

router.put("/workspace-settings", (req, res) => {
  try {
    const value = body(req);
    const unknown = Object.keys(value).find((key) => !UPDATE_KEYS.has(key));
    if (unknown) throw new WorkspaceStoreError(`Unknown field: ${unknown}`);
    if (typeof value.default_agent_profile_id !== "string" || !value.default_agent_profile_id.trim()) {
      throw new WorkspaceStoreError("default_agent_profile_id is required");
    }
    res.json(workspaceSettingsService.setWorkspaceDefaultAgentProfileForUi(value.default_agent_profile_id.trim()));
  } catch (error) { fail(res, error); }
});
