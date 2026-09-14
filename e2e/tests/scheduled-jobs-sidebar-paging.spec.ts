import { expect, test, type Page, type Route } from "@playwright/test";

const projectCwd = "/tmp/wayang-scheduled-jobs-paging-e2e";
const projectName = "Synthetic scheduled jobs project";

function syntheticJob(index: number) {
  const now = Date.now();
  return {
    id: `synthetic-scheduled-job-${index}`,
    name: `Synthetic scheduled job ${index}`,
    schedule_kind: "cron",
    cron_expr: `0 ${index} * * *`,
    timezone: null,
    prompt: "synthetic",
    cwd: projectCwd,
    provider: null,
    model: null,
    agent_profile_id: null,
    permission_mode: "default",
    command_guard_mode: "default",
    timeout_ms: 600_000,
    prompt_timeout_ms: 600_000,
    overlap_policy: "skip",
    missed_run_policy: "skip",
    enabled: true,
    created_at: now,
    updated_at: now,
    last_run_at: null,
    next_run_at: null,
  };
}

async function installSyntheticApi(page: Page, jobCount: number): Promise<void> {
  const project = {
    id: "synthetic-scheduled-jobs-project",
    cwd: projectCwd,
    name: projectName,
    description: null,
    color: "#0ea5e9",
    default_agent_profile_id: "default-profile",
    default_provider: null,
    default_model: null,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  const jobs = Array.from({ length: jobCount }, (_, index) => syntheticJob(index + 1));

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "example", provider: "synthetic", version: "test" } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/projects") return route.fulfill({ json: [project] });
    if (path === "/api/agent-profiles") return route.fulfill({ json: [] });
    if (path === "/api/workspace-settings") return route.fulfill({ json: {
      default_agent_profile_id: "default-profile",
      default_agent_profile: {
        id: "default-profile", name: "Default", description: null, enabled: true,
        resource_mode: "project_only", memory_access: "none", default_provider: null,
        default_model: null, allowed_tools: [], allowed_extensions: [], created_at: 1, updated_at: 1,
      },
    } });
    if (path === "/api/sessions" && request.method() === "GET") return route.fulfill({ json: [] });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs } });
    if (path === "/api/protected-automations") return route.fulfill({ json: { milestone: 0, activationAvailable: false, production_services: false } });
    if (path === "/api/protected-automations/jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/apps") return route.fulfill({ json: [] });
    if (path === "/api/capabilities") return route.fulfill({ json: { cwd: projectCwd, capabilities: [] } });
    return route.fulfill({ json: {} });
  });
}

test("sidebar scheduled jobs reveal the full list beyond the first page", async ({ page }) => {
  await installSyntheticApi(page, 12);
  await page.goto("/");

  const toggle = page.getByTestId("scheduled-jobs-nav-toggle");
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveText("Show all 12 jobs (+4 more)");
  await expect(toggle).toHaveAttribute("aria-expanded", "false");

  // The first page is bounded to eight jobs; later jobs are unreachable until expanded.
  await expect(page.getByText("Synthetic scheduled job 1", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic scheduled job 8", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic scheduled job 9", { exact: true })).toBeHidden();
  await expect(page.getByText("Synthetic scheduled job 12", { exact: true })).toBeHidden();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "true");
  await expect(toggle).toHaveText("Show fewer");
  await expect(page.getByText("Synthetic scheduled job 9", { exact: true })).toBeVisible();
  await expect(page.getByText("Synthetic scheduled job 12", { exact: true })).toBeVisible();

  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-expanded", "false");
  await expect(page.getByText("Synthetic scheduled job 12", { exact: true })).toBeHidden();
});
