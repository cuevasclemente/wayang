import { Router, type Request, type Response } from "express";
import { getAgentProfile, listAgentProfiles, type AgentProfileCreateInput, type AgentProfileUpdateInput } from "../agent-profiles.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import { runtimeImpactErrorBody } from "../runtime-impact.js";
import { workspaceSettingsService } from "../workspace-settings-service.js";

export const router = Router();

const CREATE_KEYS = new Set(["name", "description", "resource_mode", "instructions", "memory_access", "default_provider", "default_model"]);
const UPDATE_KEYS = new Set(["name", "description", "enabled", "resource_mode", "instructions", "memory_access", "default_provider", "default_model", "replacement_agent_profile_id"]);
const RUNTIME_AFFECTING_UPDATE_KEYS = new Set(["enabled", "resource_mode", "instructions", "memory_access", "default_provider", "default_model", "replacement_agent_profile_id"]);

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

function withoutInstructions<T extends { instructions: string | null }>(profile: T): Omit<T, "instructions"> {
  const { instructions: _privateInstructions, ...safe } = profile;
  return safe;
}

router.get("/agent-profiles", (_req, res) => {
  try { res.json(listAgentProfiles().map(withoutInstructions)); } catch (error) { fail(res, error); }
});

router.post("/agent-profiles", (req, res) => {
  try {
    const value = body(req);
    only(value, CREATE_KEYS);
    if (typeof value.name !== "string") throw new WorkspaceStoreError("name is required");
    res.status(201).json(workspaceSettingsService.createAgentProfileForUi(value as unknown as AgentProfileCreateInput));
  } catch (error) { fail(res, error); }
});

router.get("/agent-profiles/:id", (req, res) => {
  try {
    const profile = getAgentProfile(req.params.id);
    if (!profile) throw new WorkspaceStoreError("Agent profile not found", 404);
    res.json(profile);
  } catch (error) { fail(res, error); }
});

router.put("/agent-profiles/:id", async (req, res) => {
  try {
    const value = body(req);
    only(value, UPDATE_KEYS);
    const replacement = value.replacement_agent_profile_id;
    if (replacement !== undefined && typeof replacement !== "string") throw new WorkspaceStoreError("replacement_agent_profile_id must be a string");
    const { replacement_agent_profile_id: _replacement, ...updates } = value;
    const updated = await workspaceSettingsService.updateAgentProfileForUi(
      req.params.id,
      updates as AgentProfileUpdateInput,
      replacement as string | undefined,
      Object.keys(value).some((key) => RUNTIME_AFFECTING_UPDATE_KEYS.has(key)),
    );
    res.json(updated);
  } catch (error) { fail(res, error); }
});

router.delete("/agent-profiles/:id", async (req, res) => {
  try {
    const value = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
    only(value, new Set(["replacement_agent_profile_id"]));
    const replacement = value.replacement_agent_profile_id;
    if (replacement !== undefined && typeof replacement !== "string") throw new WorkspaceStoreError("replacement_agent_profile_id must be a string");
    await workspaceSettingsService.deleteAgentProfileForUi(req.params.id, replacement as string | undefined);
    res.status(204).end();
  } catch (error) { fail(res, error); }
});
