import { Router, type Request, type Response } from "express";
import { getProject, listProjects, type ProjectCreateInput, type ProjectUpdateInput } from "../projects.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import { runtimeImpactErrorBody } from "../runtime-impact.js";
import { workspaceSettingsService } from "../workspace-settings-service.js";

export const router = Router();

const CREATE_KEYS = new Set(["cwd", "name", "description", "color", "default_agent_profile_id", "default_provider", "default_model", "access_policy"]);
const UPDATE_KEYS = new Set(["name", "description", "color", "default_agent_profile_id", "default_provider", "default_model", "access_policy"]);
const RUNTIME_AFFECTING_UPDATE_KEYS = new Set(["default_agent_profile_id", "default_provider", "default_model", "access_policy"]);

function body(req: Request): Record<string, unknown> {
  if (!req.body || typeof req.body !== "object" || Array.isArray(req.body)) throw new WorkspaceStoreError("Request body must be a JSON object");
  return req.body as Record<string, unknown>;
}

function only(value: Record<string, unknown>, keys: Set<string>): void {
  const unknown = Object.keys(value).filter((key) => !keys.has(key));
  if (unknown.length) throw new WorkspaceStoreError(`Unknown field: ${unknown[0]}`);
}

function fail(res: Response, error: unknown): void {
  const impact = runtimeImpactErrorBody(error);
  if (impact) {
    res.status(409).json(impact);
    return;
  }
  const status = error instanceof WorkspaceStoreError ? error.statusCode : 500;
  res.status(status).json({ error: error instanceof Error ? error.message : String(error) });
}

router.get("/projects", (_req, res) => {
  try { res.json(listProjects()); } catch (error) { fail(res, error); }
});

router.post("/projects", (req, res) => {
  try {
    const value = body(req);
    only(value, CREATE_KEYS);
    if (typeof value.cwd !== "string") throw new WorkspaceStoreError("cwd is required");
    res.status(201).json(workspaceSettingsService.createProjectForUi(value as unknown as ProjectCreateInput));
  } catch (error) { fail(res, error); }
});

router.get("/projects/:id", (req, res) => {
  try {
    const project = getProject(req.params.id);
    if (!project) throw new WorkspaceStoreError("Project not found", 404);
    res.json(project);
  } catch (error) { fail(res, error); }
});

router.put("/projects/:id", async (req, res) => {
  try {
    const value = body(req);
    if ("cwd" in value) throw new WorkspaceStoreError("Project cwd is immutable", 409);
    only(value, UPDATE_KEYS);
    const updated = await workspaceSettingsService.updateProjectForUi(
      req.params.id,
      value as ProjectUpdateInput,
      Object.keys(value).some((key) => RUNTIME_AFFECTING_UPDATE_KEYS.has(key)),
    );
    res.json(updated);
  } catch (error) { fail(res, error); }
});

router.delete("/projects/:id", async (req, res) => {
  try {
    const value = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    only(value, new Set());
    await workspaceSettingsService.deleteProjectForUi(req.params.id);
    res.status(204).end();
  } catch (error) { fail(res, error); }
});

router.get("/projects/:id/instructions", (req, res) => {
  try { res.json(workspaceSettingsService.readProjectInstructionsForUi(req.params.id)); } catch (error) { fail(res, error); }
});

router.put("/projects/:id/instructions", async (req, res) => {
  try {
    const value = body(req);
    only(value, new Set(["text", "expected_sha256", "create_if_missing"]));
    if (typeof value.text !== "string") throw new WorkspaceStoreError("text is required");
    const instructions = await workspaceSettingsService.writeProjectInstructionsForUi(req.params.id, {
      text: value.text,
      expected_sha256: value.expected_sha256 as string | null | undefined,
      create_if_missing: value.create_if_missing as boolean | undefined,
    });
    res.json(instructions);
  } catch (error) { fail(res, error); }
});
