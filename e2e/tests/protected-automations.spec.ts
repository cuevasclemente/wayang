import { expect, test, type Page, type Route } from "@playwright/test";

const NOW = Date.UTC(2026, 7, 3, 12, 0, 0);
const JOB_ID = "synthetic-protected-automation";
const RUN_ID = "synthetic-protected-run";

type Overrides = Record<string, unknown>;

function automationJob(overrides: Overrides = {}) {
  return {
    id: JOB_ID,
    project_id: "synthetic-protected-project",
    agent_profile_id: "synthetic-protected-agent",
    capability_revision: 7,
    revision: 11,
    source_revision: 4,
    name: "Synthetic protected export",
    source_manifest_sha256: "a".repeat(64),
    entrypoint: "automation.mjs",
    argv_count: 2,
    uses_browser_profile: false,
    allowed_https_origins: [] as string[],
    cron_expr: "15 4 * * 1",
    timeout_ms: 12 * 60_000,
    missed_run_policy: "run_once",
    enabled: true,
    blocked_reason: null as string | null,
    deleted_at: null as number | null,
    created_at: NOW - 86_400_000,
    updated_at: NOW - 3_600_000,
    last_run_at: NOW - 7_200_000,
    next_run_at: NOW + 86_400_000 as number | null,
    attention: null as null | { required: true; reason: string },
    activationAvailable: false,
    ...overrides,
  };
}

type AutomationJob = ReturnType<typeof automationJob>;

function automationRun(overrides: Overrides = {}) {
  return {
    id: RUN_ID,
    job_id: JOB_ID,
    project_id: "synthetic-protected-project",
    agent_profile_id: "synthetic-protected-agent",
    job_revision: 11,
    capability_revision: 7,
    trigger: "schedule",
    scheduled_for: NOW - 60_000 as number | null,
    started_at: NOW - 30_000,
    finished_at: null as number | null,
    status: "running",
    outcome_code: null as string | null,
    exit_code: null as number | null,
    attention: null as null | { required: true; reason: string },
    ...overrides,
  };
}

type AutomationRun = ReturnType<typeof automationRun>;

interface CapturedRequest {
  method: string;
  pathname: string;
  body: unknown;
}

interface MockState {
  status: { milestone: number; activationAvailable: boolean; production_services: boolean };
  catalogJobs: AutomationJob[];
  detailJobs: Map<string, AutomationJob>;
  runs: Map<string, AutomationRun[]>;
  requests: CapturedRequest[];
  scheduledRequests: CapturedRequest[];
  preparation?: {
    sourceSessionId: string;
    jobId: string;
    preparationId: string;
    websocketPath: string;
  };
}

const scheduledJob = {
  id: "synthetic-scheduled-agent-job",
  name: "Synthetic scheduled agent job",
  schedule_kind: "cron",
  cron_expr: "0 9 * * *",
  timezone: null,
  prompt: "Synthetic prompt with no private or external data.",
  cwd: "/tmp/wayang-e2e-standard-project",
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
  created_at: NOW - 10_000,
  updated_at: NOW - 5_000,
  last_run_at: null,
  next_run_at: NOW + 3_600_000,
};

async function fulfillJson(route: Route, value: unknown, status = 200): Promise<void> {
  await route.fulfill({
    status,
    contentType: "application/json",
    headers: { "Cache-Control": "no-store" },
    body: JSON.stringify(value),
  });
}

async function installMocks(page: Page, options: {
  status?: Partial<MockState["status"]>;
  catalogJobs?: AutomationJob[];
  detailJobs?: AutomationJob[];
  runs?: AutomationRun[];
  preparation?: MockState["preparation"];
} = {}): Promise<MockState> {
  const catalogJobs = options.catalogJobs ?? [];
  const details = options.detailJobs ?? catalogJobs;
  const state: MockState = {
    status: { milestone: 5, activationAvailable: false, production_services: true, ...options.status },
    catalogJobs,
    detailJobs: new Map(details.map((candidate) => [candidate.id, candidate])),
    runs: new Map(details.map((candidate) => [candidate.id, candidate.id === JOB_ID ? [...(options.runs ?? [])] : []])),
    requests: [],
    scheduledRequests: [],
    preparation: options.preparation,
  };

  await page.route("**/api/protected-automations**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.requests.push({ method: request.method(), pathname, body });

    if (request.method() === "GET" && (pathname === "/api/protected-automations" || pathname === "/api/protected-automations/status")) {
      return fulfillJson(route, state.status);
    }
    if (request.method() === "GET" && pathname === "/api/protected-automations/jobs") {
      return fulfillJson(route, { jobs: state.catalogJobs });
    }

    const preparation = /^\/api\/protected-automations\/sources\/([^/]+)\/jobs\/([^/]+)\/preparations\/([^/]+)$/u.exec(pathname);
    if (request.method() === "GET" && preparation && state.preparation) {
      const [sourceSessionId, selectedJobId, preparationId] = preparation.slice(1).map(decodeURIComponent);
      if (sourceSessionId !== state.preparation.sourceSessionId
        || selectedJobId !== state.preparation.jobId
        || preparationId !== state.preparation.preparationId) {
        return fulfillJson(route, { error: "Exact source-bound preparation was not found" }, 404);
      }
      const selectedJob = state.detailJobs.get(selectedJobId)!;
      return fulfillJson(route, {
        preparation_id: preparationId,
        source_session_id: sourceSessionId,
        job_id: selectedJobId,
        job_revision: selectedJob.revision,
        state: "ready",
        websocket_path: state.preparation.websocketPath,
        project_id: selectedJob.project_id,
        agent_profile_id: selectedJob.agent_profile_id,
        capability_revision: selectedJob.capability_revision,
        source_revision: selectedJob.source_revision,
        allowed_https_origins: selectedJob.allowed_https_origins,
        credential_broker: { supported: false, guarded: true },
      });
    }

    const pause = /^\/api\/protected-automations\/jobs\/([^/]+)\/pause$/u.exec(pathname);
    if (request.method() === "POST" && pause) {
      const selectedJobId = decodeURIComponent(pause[1]!);
      const current = state.detailJobs.get(selectedJobId)!;
      const paused = automationJob({
        ...current,
        revision: current.revision + 1,
        enabled: false,
        blocked_reason: "paused",
        next_run_at: null,
      });
      state.detailJobs.set(selectedJobId, paused);
      state.catalogJobs = state.catalogJobs.map((candidate) => candidate.id === selectedJobId ? paused : candidate);
      return fulfillJson(route, { job: paused });
    }

    const cancel = /^\/api\/protected-automations\/jobs\/([^/]+)\/runs\/([^/]+)\/cancel$/u.exec(pathname);
    if (request.method() === "POST" && cancel) {
      const selectedJobId = decodeURIComponent(cancel[1]!);
      const selectedRunId = decodeURIComponent(cancel[2]!);
      const rows = state.runs.get(selectedJobId) ?? [];
      const current = rows.find((candidate) => candidate.id === selectedRunId);
      if (!current) return fulfillJson(route, { error: "Synthetic run not found" }, 404);
      const cancelled = automationRun({ ...current, status: "cancelled", finished_at: NOW, outcome_code: "cancelled" });
      state.runs.set(selectedJobId, rows.map((candidate) => candidate.id === selectedRunId ? cancelled : candidate));
      return fulfillJson(route, { run: cancelled });
    }

    const purgeRequest = /^\/api\/protected-automations\/jobs\/([^/]+)\/purge-requests$/u.exec(pathname);
    if (request.method() === "POST" && purgeRequest) {
      const selectedJobId = decodeURIComponent(purgeRequest[1]!);
      const selectedJob = state.detailJobs.get(selectedJobId)!;
      return fulfillJson(route, {
        request_id: "synthetic-one-use-purge-request",
        job_id: selectedJobId,
        expected_revision: selectedJob.revision,
        operation_digest: "b".repeat(64),
        expires_at: NOW + 120_000,
        summary: `Permanently purge private synthetic artifacts for ${selectedJobId}; project outputs are retained.`,
      }, 201);
    }

    const purgeCommit = /^\/api\/protected-automations\/jobs\/([^/]+)\/purge-requests\/([^/]+)\/commit$/u.exec(pathname);
    if (request.method() === "POST" && purgeCommit) {
      const selectedJobId = decodeURIComponent(purgeCommit[1]!);
      const purgedRunIds = (state.runs.get(selectedJobId) ?? []).map((candidate) => candidate.id);
      state.catalogJobs = state.catalogJobs.filter((candidate) => candidate.id !== selectedJobId);
      state.detailJobs.delete(selectedJobId);
      state.runs.delete(selectedJobId);
      return fulfillJson(route, { purged_job_id: selectedJobId, purged_run_ids: purgedRunIds });
    }
    if (request.method() === "DELETE" && pathname.includes("/purge-requests/")) {
      return route.fulfill({ status: 204, body: "" });
    }

    const runs = /^\/api\/protected-automations\/jobs\/([^/]+)\/runs$/u.exec(pathname);
    if (request.method() === "GET" && runs) {
      return fulfillJson(route, { runs: state.runs.get(decodeURIComponent(runs[1]!)) ?? [] });
    }
    const detail = /^\/api\/protected-automations\/jobs\/([^/]+)$/u.exec(pathname);
    if (request.method() === "GET" && detail) {
      const selectedJob = state.detailJobs.get(decodeURIComponent(detail[1]!));
      return selectedJob ? fulfillJson(route, { job: selectedJob }) : fulfillJson(route, { error: "Not found" }, 404);
    }
    return fulfillJson(route, { error: `Unexpected synthetic route: ${request.method()} ${pathname}` }, 404);
  });

  await page.route("**/api/scheduled-agent-jobs**", async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    const body = request.postData() ? request.postDataJSON() : undefined;
    state.scheduledRequests.push({ method: request.method(), pathname, body });
    if (request.method() === "GET" && pathname === "/api/scheduled-agent-jobs") {
      return fulfillJson(route, { jobs: [scheduledJob] });
    }
    if (request.method() === "GET" && pathname === `/api/scheduled-agent-jobs/${scheduledJob.id}`) {
      return fulfillJson(route, { job: scheduledJob, runs: [] });
    }
    return fulfillJson(route, { error: "Synthetic scheduled route denied" }, 405);
  });

  return state;
}

async function openAutomation(page: Page, selectedJobId?: string): Promise<void> {
  await page.goto("/");
  if (selectedJobId) {
    await page.locator(`[data-testid="protected-automation-nav-job"][data-job-id="${selectedJobId}"]`).click();
  } else {
    await page.getByTestId("protected-automations-open").click();
  }
  await expect(page.getByTestId("protected-automations-panel")).toBeVisible();
}

test("isolated backend exposes production status with activation available", async ({ request }) => {
  const frontendPort = process.env.WAYANG_E2E_FRONTEND_PORT || "15173";
  const response = await request.get("/api/protected-automations", {
    headers: { Origin: `http://127.0.0.1:${frontendPort}` },
  });
  expect(response.ok(), await response.text()).toBe(true);
  expect(response.headers()["cache-control"]).toContain("no-store");
  expect(await response.json()).toEqual({ milestone: 5, activationAvailable: true, production_services: true });
});

test("keeps Protected Automations distinct from Scheduled Agent Jobs", async ({ page }) => {
  const state = await installMocks(page, {
    status: { activationAvailable: true },
    catalogJobs: [automationJob()],
  });
  await page.goto("/");

  const navigation = page.getByTestId("protected-automations-navigation");
  await expect(navigation).toContainText("Protected Automations");
  await expect(navigation).toContainText("available");
  await expect(page.getByText("Scheduled Jobs", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Synthetic scheduled agent job", { exact: true })).toBeVisible();

  await page.getByTestId("protected-automations-open").click();
  const protectedPanel = page.getByTestId("protected-automations-panel");
  await expect(protectedPanel).toContainText("Deterministic protected jobs — not Scheduled Agent Jobs");
  await expect(protectedPanel.getByRole("button", { name: "New" })).toHaveCount(0);
  expect(state.scheduledRequests.filter((candidate) => candidate.method !== "GET")).toEqual([]);

  await page.getByText("Synthetic scheduled agent job", { exact: true }).click();
  await expect(page.getByRole("heading", { name: "Scheduled Jobs" })).toBeVisible();
  await expect(page.getByText("First-class unattended pi agent jobs.")).toBeVisible();
  await expect(protectedPanel).toBeHidden();
  expect(state.requests.filter((candidate) => candidate.method !== "GET")).toEqual([]);
});

test("renders activation-available and activation-held status without creation controls", async ({ page }) => {
  const state = await installMocks(page, { status: { activationAvailable: true } });
  await openAutomation(page);

  await expect(page.getByTestId("protected-automations-status")).toContainText("activation available");
  await expect(page.getByTestId("protected-automations-held")).toHaveCount(0);
  await expect(page.getByTestId("protected-automations-panel").getByRole("button", { name: /create|enable|run now/i })).toHaveCount(0);

  state.status.activationAvailable = false;
  await page.getByTestId("protected-automation-refresh").click();
  await expect(page.getByTestId("protected-automations-status")).toContainText("activation held");
  await expect(page.getByTestId("protected-automations-held")).toContainText("cannot create, enable, rebind, or run jobs");
});

test("hydrates exact metadata and sends backend-owned emergency cancel and pause", async ({ page }) => {
  const catalogShell = automationJob({ name: "Catalog shell", cron_expr: "0 0 * * *", revision: 10 });
  const hydrated = automationJob({ name: "Hydrated synthetic protected export", source_revision: 6 });
  const state = await installMocks(page, {
    catalogJobs: [catalogShell],
    detailJobs: [hydrated],
    runs: [automationRun()],
  });
  await openAutomation(page, JOB_ID);

  const detail = page.getByTestId("protected-automation-detail");
  await expect(detail).toContainText("Hydrated synthetic protected export");
  await expect(detail).not.toContainText("Catalog shell");
  await expect(detail).toContainText("15 4 * * 1");
  await expect(detail).toContainText("revision 11");
  await expect(detail).toContainText("12 min");
  await expect(page.getByTestId("protected-automation-run-status")).toHaveText("running");

  await page.getByTestId("protected-automation-cancel-run").click();
  await expect(page.getByTestId("protected-automation-run-status")).toHaveText("cancelled");
  expect(state.requests.find((candidate) => candidate.pathname.endsWith(`/${RUN_ID}/cancel`))).toEqual(
    expect.objectContaining({ method: "POST", body: {} }),
  );

  await page.getByTestId("protected-automation-pause").click();
  await expect(page.getByTestId("protected-automation-notice")).toContainText("Emergency pause committed");
  await expect(page.getByTestId("protected-automation-job-status")).toHaveText("paused");
  expect(state.requests.find((candidate) => candidate.pathname.endsWith(`/${JOB_ID}/pause`))).toEqual(
    expect.objectContaining({ method: "POST", body: { expectedRevision: 11 } }),
  );
  expect(state.scheduledRequests.filter((candidate) => candidate.method !== "GET")).toEqual([]);
});

test("uses only backend-issued source-bound preparation HTTP and viewer routes", async ({ page }) => {
  const sourceSessionId = "synthetic/source session";
  const preparationId = "synthetic preparation";
  const websocketPath = "/ws/protected-automations/preparations/backend-issued-preparation?source_session_id=synthetic%2Fsource%20session&job_id=synthetic-protected-automation";
  const browserJob = automationJob({
    enabled: false,
    blocked_reason: "paused",
    uses_browser_profile: true,
    allowed_https_origins: ["https://synthetic.example.test"],
  });
  const state = await installMocks(page, {
    catalogJobs: [browserJob],
    detailJobs: [browserJob],
    preparation: { sourceSessionId, jobId: JOB_ID, preparationId, websocketPath },
  });
  let openedViewerUrl: string | null = null;
  await page.routeWebSocket("**/ws/protected-automations/preparations/**", (socket) => {
    openedViewerUrl = socket.url();
    setTimeout(() => socket.send(JSON.stringify({
      type: "frame",
      dataUrl: "data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAUwAOw==",
      metadata: { deviceWidth: 1, deviceHeight: 1 },
      sessionId: 1,
    })), 10);
  });

  await openAutomation(page, JOB_ID);
  await page.getByTestId("protected-automation-preparation-source-session").fill(sourceSessionId);
  await page.getByTestId("protected-automation-preparation-id").fill(preparationId);
  await page.getByTestId("protected-automation-preparation-attach").click();

  await expect(page.getByTestId("protected-automation-preparation-state")).toContainText("state: ready");
  await expect(page.getByTestId("protected-automation-viewer")).toBeVisible();
  const frontendOrigin = `http://127.0.0.1:${process.env.WAYANG_E2E_FRONTEND_PORT || "15173"}`;
  await expect.poll(() => openedViewerUrl).toBe(`${frontendOrigin.replace(/^http/u, "ws")}${websocketPath}`);

  const preparationRequest = state.requests.find((candidate) => candidate.pathname.includes("/preparations/"));
  expect(preparationRequest?.pathname).toBe(
    `/api/protected-automations/sources/${encodeURIComponent(sourceSessionId)}/jobs/${encodeURIComponent(JOB_ID)}/preparations/${encodeURIComponent(preparationId)}`,
  );
  expect(preparationRequest?.method).toBe("GET");
  expect(state.scheduledRequests.filter((candidate) => candidate.method !== "GET")).toEqual([]);
});

test("requires request then one-use PIN commit before purging a tombstoned job", async ({ page }) => {
  const tombstoned = automationJob({
    name: "Synthetic tombstoned automation",
    revision: 19,
    enabled: false,
    blocked_reason: "tombstoned",
    deleted_at: NOW - 1_000,
    next_run_at: null,
  });
  const state = await installMocks(page, {
    catalogJobs: [tombstoned],
    detailJobs: [tombstoned],
    runs: [automationRun({ status: "completed", finished_at: NOW - 2_000, outcome_code: "completed", exit_code: 0 })],
  });
  await openAutomation(page, JOB_ID);

  await page.getByTestId("protected-automation-purge-request").click();
  const dialog = page.getByTestId("protected-automation-purge-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByTestId("protected-automation-purge-summary")).toContainText("project outputs are retained");
  await expect(dialog.getByTestId("protected-automation-purge-commit")).toBeDisabled();
  expect(state.requests.find((candidate) => candidate.pathname.endsWith(`/${JOB_ID}/purge-requests`))).toEqual(
    expect.objectContaining({ method: "POST", body: { expectedRevision: 19 } }),
  );
  expect(state.requests.some((candidate) => candidate.pathname.endsWith("/commit"))).toBe(false);

  await dialog.getByTestId("protected-automation-purge-pin").fill("12345678");
  await dialog.getByTestId("protected-automation-purge-commit").click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId("protected-automations-empty")).toBeVisible();
  expect(state.requests.find((candidate) => candidate.pathname.endsWith("/synthetic-one-use-purge-request/commit"))).toEqual(
    expect.objectContaining({ method: "POST", body: { pin: "12345678" } }),
  );
  expect(state.scheduledRequests.filter((candidate) => candidate.method !== "GET")).toEqual([]);
});

test("keeps protected controls usable without horizontal overflow on mobile", async ({ page }) => {
  const mobileJob = automationJob({
    name: "Synthetic mobile protected automation with a deliberately descriptive name",
    attention: { required: true, reason: "human_review_required" },
  });
  await page.setViewportSize({ width: 390, height: 720 });
  await installMocks(page, {
    catalogJobs: [mobileJob],
    detailJobs: [mobileJob],
    runs: [automationRun()],
  });
  await page.goto("/");

  await page.getByTestId("mobile-tab-bar").getByRole("button", { name: "Sessions" }).click();
  await expect(page.getByTestId("protected-automations-navigation")).toBeVisible();
  await page.getByTestId("protected-automation-nav-job").click();
  const panel = page.getByTestId("protected-automations-panel");
  await expect(panel).toBeVisible();
  await expect(page.getByTestId("protected-automation-pause")).toBeVisible();
  await expect(page.getByTestId("protected-automation-cancel-run")).toBeVisible();
  await expect(page.getByTestId("protected-automation-attention")).toBeVisible();

  const layout = await page.evaluate(() => {
    const element = document.querySelector<HTMLElement>('[data-testid="protected-automations-panel"]')!;
    const rect = element.getBoundingClientRect();
    return {
      documentWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
      panelLeft: rect.left,
      panelRight: rect.right,
    };
  });
  expect(layout.documentWidth).toBeLessThanOrEqual(layout.viewportWidth);
  expect(layout.panelLeft).toBeGreaterThanOrEqual(0);
  expect(layout.panelRight).toBeLessThanOrEqual(layout.viewportWidth);
});
