import { expect, test, type Page, type Route } from "@playwright/test";

const projectId = "project-derived-authority";
const profileId = "profile-derived-authority";

async function installSyntheticApi(page: Page): Promise<{ capabilityRequests: string[] }> {
  const now = Date.now();
  const capabilityRequests: string[] = [];
  const project = {
    id: projectId,
    cwd: "/synthetic/derived-authority",
    name: "Derived Authority Project",
    description: null,
    color: null,
    default_agent_profile_id: profileId,
    default_provider: "provider-orchid",
    default_model: "model-cascade",
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profileId] },
    created_at: now,
    updated_at: now,
  };
  const profile = {
    id: profileId,
    name: "Derived Authority Agent",
    description: null,
    enabled: true,
    resource_mode: "project_only",
    memory_access: "none",
    default_provider: "provider-orchid",
    default_model: "model-cascade",
    allowed_tools: null,
    allowed_extensions: null,
    created_at: now,
    updated_at: now,
  };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith("/api/workspace-capabilities")) {
      capabilityRequests.push(path);
      return route.fulfill({ status: 404, json: { error: "retired" } });
    }
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "synthetic-user", provider: "synthetic", version: "test" } });
    if (path === "/api/models") return route.fulfill({ json: {
      models: [{ provider: "provider-orchid", id: "model-cascade", name: "Cascade", api: "synthetic", reasoning: false, input: ["text"], contextWindow: 32_000, available: true }],
      defaultModel: { provider: "provider-orchid", id: "model-cascade", name: "Cascade" },
    } });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/projects/discover" || path === "/api/fs/discover-projects") return route.fulfill({ json: [] });
    if (path === "/api/projects") return route.fulfill({ json: [project] });
    if (path === `/api/projects/${projectId}/instructions`) return route.fulfill({ json: {
      path: `${project.cwd}/AGENTS.md`, exists: false, text: "", sha256: null, git_tracked: false, git_changed: false,
    } });
    if (path === "/api/agent-profiles") return route.fulfill({ json: [profile] });
    if (path === `/api/agent-profiles/${profileId}`) return route.fulfill({ json: { ...profile, instructions: null } });
    if (path === "/api/browser-profiles") return route.fulfill({ json: { profiles: [], consequence: "synthetic" } });
    if (path === `/api/browser-profiles/projects/${projectId}/default`) return route.fulfill({ json: { default: null } });
    if (path === "/api/sessions") return route.fulfill({ json: [] });
    if (path === "/api/sessions/events") return route.fulfill({ status: 204 });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    return route.fulfill({ json: {} });
  });

  return { capabilityRequests };
}

test("workspace Settings exposes privacy/RBAC-derived authority without capability association UI or API", async ({ page }) => {
  const api = await installSyntheticApi(page);
  await page.goto("/");
  await page.getByRole("button", { name: "Open workspace settings" }).click();

  const settings = page.getByRole("dialog", { name: "Workspace settings" });
  await expect(settings.getByRole("tab", { name: "Capabilities" })).toHaveCount(0);
  await expect(settings).toContainText("Privacy directly selects the authority available to enabled allowlisted agents");
  await expect(settings).toContainText("adding it automatically grants the authority selected by this Project’s privacy mode");

  await settings.getByRole("tab", { name: "Agents" }).click();
  await expect(settings).toContainText("Standard projects derive global resources, browser, and host execution for every enabled allowed profile");
  await expect(settings).toContainText("re-enabling restores authority wherever the profile remains allowed");
  await expect.poll(() => api.capabilityRequests).toEqual([]);
});
