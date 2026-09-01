import { expect, test, type Page, type Route } from "@playwright/test";

const wrenId = "profile-migration-wren";
const loomId = "profile-owner-loom";
const projectId = "project-owner-loom";

function profile(id: string, name: string, resourceMode: "standard" | "project_only") {
  const now = Date.now();
  return {
    id,
    name,
    description: null,
    enabled: true,
    resource_mode: resourceMode,
    memory_access: resourceMode === "standard" ? "read_write" : "none",
    default_provider: null,
    default_model: null,
    allowed_tools: resourceMode === "standard" ? null : [],
    allowed_extensions: resourceMode === "standard" ? null : [],
    created_at: now,
    updated_at: now,
  };
}

async function installSyntheticApi(page: Page): Promise<{
  workspaceUpdates: Record<string, unknown>[];
  deleteRequests: string[];
}> {
  const profiles = [profile(wrenId, "Wren", "standard"), profile(loomId, "Loom", "standard")];
  let workspaceDefaultId = wrenId;
  const workspaceUpdates: Record<string, unknown>[] = [];
  const deleteRequests: string[] = [];

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" || method === "HEAD" ? {} : (request.postDataJSON() ?? {}) as Record<string, unknown>;

    if (method === "DELETE") deleteRequests.push(path);
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "synthetic-user", provider: "synthetic", version: "test" } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/projects/discover" || path === "/api/fs/discover-projects") return route.fulfill({ json: [] });
    if (path === "/api/sessions") return route.fulfill({ json: [] });
    if (path === "/api/sessions/events") return route.fulfill({ status: 204 });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/agent-profiles") return route.fulfill({ json: profiles });
    if (path === `/api/agent-profiles/${wrenId}`) return route.fulfill({ json: { ...profiles[0], instructions: null } });
    if (path === `/api/agent-profiles/${loomId}`) return route.fulfill({ json: { ...profiles[1], instructions: null } });
    if (path === `/api/agent-profiles/${wrenId}/references`) return route.fulfill({ json: {
      workspace_default: workspaceDefaultId === wrenId,
      project_defaults: 0,
      project_allowlists: 0,
      session_attributions: 2,
      running_sessions: 0,
      pending_switches: 0,
      scheduled_jobs: 0,
      protected_automation_jobs: 0,
      protected_automation_runs: 0,
      messaging_endpoints: 0,
    } });
    if (path === `/api/agent-profiles/${loomId}/references`) return route.fulfill({ json: {
      workspace_default: workspaceDefaultId === loomId,
      project_defaults: 1,
      project_allowlists: 1,
      session_attributions: 0,
      running_sessions: 0,
      pending_switches: 0,
      scheduled_jobs: 0,
      protected_automation_jobs: 0,
      protected_automation_runs: 0,
      messaging_endpoints: 0,
    } });
    if (path === "/api/workspace-settings" && method === "GET") {
      const selected = profiles.find((candidate) => candidate.id === workspaceDefaultId)!;
      return route.fulfill({ json: { default_agent_profile_id: workspaceDefaultId, default_agent_profile: selected } });
    }
    if (path === "/api/workspace-settings" && method === "PUT") {
      workspaceUpdates.push(structuredClone(body));
      workspaceDefaultId = String(body.default_agent_profile_id);
      const selected = profiles.find((candidate) => candidate.id === workspaceDefaultId)!;
      return route.fulfill({ json: { default_agent_profile_id: workspaceDefaultId, default_agent_profile: selected } });
    }
    if (path === "/api/projects") return route.fulfill({ json: [{
      id: projectId,
      cwd: "/synthetic/loom-project",
      name: "Loom Project",
      description: null,
      color: null,
      default_agent_profile_id: loomId,
      default_provider: null,
      default_model: null,
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [loomId] },
      created_at: Date.now(),
      updated_at: Date.now(),
    }] });
    if (path === `/api/projects/${projectId}/instructions`) return route.fulfill({ json: {
      path: "/synthetic/loom-project/AGENTS.md",
      exists: false,
      text: "",
      sha256: null,
      git_tracked: false,
      git_changed: false,
    } });
    if (path === "/api/browser-profiles") return route.fulfill({ json: { profiles: [], consequence: "synthetic" } });
    if (path === `/api/browser-profiles/projects/${projectId}/default`) return route.fulfill({ json: { default: null } });
    return route.fulfill({ json: {} });
  });

  return { workspaceUpdates, deleteRequests };
}

test("Settings changes only the hidden workspace default and leaves the old profile available for nondestructive disable", async ({ page }) => {
  const api = await installSyntheticApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace settings" }).click();
  const settings = page.getByRole("dialog", { name: "Workspace settings" });
  await settings.getByRole("tab", { name: "Agents" }).click();

  const selector = settings.getByLabel("Workspace default agent profile");
  await expect(selector).toHaveValue(wrenId);
  await expect(settings.getByRole("checkbox", { name: "Enabled" })).toBeDisabled();
  await expect(settings).toContainText("Persisted session attribution");
  await expect(settings).toContainText("Set another workspace default above before disabling this profile.");

  await selector.selectOption(loomId);
  await settings.getByRole("button", { name: "Set workspace default" }).click();

  await expect.poll(() => api.workspaceUpdates).toEqual([{ default_agent_profile_id: loomId }]);
  await expect(selector).toHaveValue(loomId);
  await expect(settings).toContainText("Workspace default updated without changing existing attribution.");
  await expect(settings.getByRole("checkbox", { name: "Enabled" })).toBeEnabled();
  await expect.poll(() => api.deleteRequests).toEqual([]);
});
