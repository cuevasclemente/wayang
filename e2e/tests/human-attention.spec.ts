import { expect, test, type Page, type Route } from "@playwright/test";

const projectCwd = "/tmp/wayang-human-attention-e2e";
const projectName = "Synthetic attention project";
const sessionId = "synthetic-attention-session";
const sensitiveSessionTitle = "PRIVATE session title derived from user text";

interface SyntheticAttention {
  sessionId: string;
  kind: "question";
  sourceId: string;
  createdAt: number;
  status: "pending";
  requiresWayang: boolean;
  questionText?: string;
  toolArguments?: string;
}

function attention(sourceId: string): SyntheticAttention {
  return {
    sessionId,
    kind: "question",
    sourceId,
    createdAt: Date.now(),
    status: "pending",
    requiresWayang: true,
  };
}

function syntheticSession(humanAttention: unknown[]) {
  const now = Date.now();
  return {
    id: sessionId,
    pi_session_file: null,
    title: sensitiveSessionTitle,
    cwd: projectCwd,
    provider: null,
    model: null,
    agent_profile_id: null,
    pending_agent_switch: null,
    created_at: now,
    last_active: now,
    archived: 0,
    goal: null,
    goal_status: null,
    scheduled_job_id: null,
    scheduled_run_id: null,
    error: null,
    runtime_status: "active",
    runtime_is_streaming: true,
    runtime_is_compacting: false,
    runtime_subscriber_count: 1,
    runtime_last_activity_at: now,
    bash_mode: "sandboxed",
    browser_mode: "unavailable",
    humanAttention,
  };
}

async function installCatalogEvents(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const catalogListeners = new Set<EventListener>();
    class SyntheticEventSource {
      readonly url: string;
      onerror: ((event: Event) => void) | null = null;
      constructor(url: string | URL) {
        this.url = String(url);
      }
      addEventListener(type: string, listener: EventListenerOrEventListenerObject | null): void {
        if (type === "catalog_generation" && typeof listener === "function") catalogListeners.add(listener);
      }
      close(): void {}
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: SyntheticEventSource });
    Object.defineProperty(window, "__emitAttentionCatalog", {
      configurable: true,
      value: () => {
        const event = new Event("catalog_generation");
        for (const listener of catalogListeners) listener(event);
      },
    });
  });
}

async function installNotificationMock(
  page: Page,
  requestedPermission: "granted" | "denied" = "granted",
  initialPermission: NotificationPermission = "default",
): Promise<void> {
  await page.addInitScript(({ permissionAfterRequest, permissionAtLoad }) => {
    const records: Array<{ title: string; body: string; notification: MockNotification }> = [];
    let requestCount = 0;

    class MockNotification {
      static permission: NotificationPermission = permissionAtLoad;
      static async requestPermission(): Promise<NotificationPermission> {
        requestCount += 1;
        MockNotification.permission = permissionAfterRequest;
        return permissionAfterRequest;
      }
      onclick: ((event: Event) => unknown) | null = null;
      constructor(title: string, options: NotificationOptions = {}) {
        records.push({ title, body: options.body ?? "", notification: this });
      }
      close(): void {}
    }

    Object.defineProperty(window, "Notification", { configurable: true, value: MockNotification });
    Object.defineProperty(window, "__notificationRecords", { configurable: true, get: () => records });
    Object.defineProperty(window, "__notificationRequestCount", { configurable: true, get: () => requestCount });
    Object.defineProperty(window, "__clickNotification", {
      configurable: true,
      value: (index: number) => records[index]?.notification.onclick?.(new Event("click")),
    });
  }, { permissionAfterRequest: requestedPermission, permissionAtLoad: initialPermission });
}

interface SyntheticApi {
  setAttention(value: unknown[]): void;
  setArchiveConflict(value: boolean): void;
  emitCatalog(): Promise<void>;
}

async function installSyntheticApi(
  page: Page,
  initialAttention: unknown[],
  options: { failSettingsLoads?: boolean; archiveConflict?: boolean } = {},
): Promise<SyntheticApi> {
  let humanAttention = initialAttention;
  let archiveConflict = options.archiveConflict === true;
  const project = {
    id: "synthetic-attention-project",
    cwd: projectCwd,
    name: projectName,
    description: null,
    color: "#d97706",
    default_agent_profile_id: "default-profile",
    default_provider: null,
    default_model: null,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
    created_at: Date.now(),
    updated_at: Date.now(),
  };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "example", provider: "synthetic", version: "test" } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/projects") return options.failSettingsLoads
      ? route.fulfill({ status: 503, json: { error: "Synthetic project load failure" } })
      : route.fulfill({ json: [project] });
    if (path === "/api/agent-profiles") return options.failSettingsLoads
      ? route.fulfill({ status: 503, json: { error: "Synthetic profile load failure" } })
      : route.fulfill({ json: [] });
    if (path === "/api/sessions" && request.method() === "GET") return route.fulfill({ json: [syntheticSession(humanAttention)] });
    if (path === `/api/sessions/${sessionId}` && request.method() === "GET") return route.fulfill({ json: syntheticSession(humanAttention) });
    if (path === `/api/sessions/${sessionId}` && request.method() === "DELETE") return archiveConflict
      ? route.fulfill({ status: 409, json: { error: "Resolve or cancel the pending human-input request before archiving this session." } })
      : route.fulfill({ status: 204, body: "" });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/protected-automations") return route.fulfill({ json: { milestone: 0, activationAvailable: false, production_services: false } });
    if (path === "/api/protected-automations/jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path.match(/^\/api\/sessions\/[^/]+\/slash-commands$/)) return route.fulfill({ json: { commands: [] } });
    if (path === "/api/fs/tree") return route.fulfill({ json: { root: projectCwd, path: projectCwd, entries: [] } });
    if (path === "/api/apps") return route.fulfill({ json: [] });
    if (path === "/api/capabilities") return route.fulfill({ json: { cwd: projectCwd, capabilities: [] } });
    return route.fulfill({ json: {} });
  });

  return {
    setAttention(value: unknown[]) { humanAttention = value; },
    setArchiveConflict(value: boolean) { archiveConflict = value; },
    async emitCatalog() {
      await page.evaluate(() => {
        const emit = (window as unknown as { __emitAttentionCatalog: () => void }).__emitAttentionCatalog;
        emit();
      });
    },
  };
}

async function openNotificationSettings(page: Page): Promise<void> {
  await page.getByRole("button", { name: "Open workspace and capability settings" }).click();
  await page.getByRole("tab", { name: "Notifications" }).click();
}

async function notificationSnapshot(page: Page): Promise<{ requestCount: number; records: Array<{ title: string; body: string }> }> {
  return page.evaluate(() => {
    const state = window as unknown as {
      __notificationRequestCount: number;
      __notificationRecords: Array<{ title: string; body: string }>;
    };
    return {
      requestCount: state.__notificationRequestCount,
      records: state.__notificationRecords.map(({ title, body }) => ({ title, body })),
    };
  });
}

test("projects and sessions project valid pending attention without automatically prompting", async ({ page }) => {
  await installCatalogEvents(page);
  await installNotificationMock(page);
  await installSyntheticApi(page, [
    attention("source-question-one"),
    attention("source-question-two"),
    { ...attention("unsupported-kind"), kind: "unsupported" },
    { ...attention("not-wayang"), requiresWayang: false },
    { ...attention("wrong-session"), sessionId: "another-session" },
    { ...attention("resolved-source"), status: "resolved" },
    { ...attention("duplicate-source"), sourceId: "source-question-one" },
    { ...attention(" whitespace-source"), sourceId: " whitespace-source" },
    { ...attention("non-nfc-source"), sourceId: "source-e\u0301" },
    { ...attention("control-source"), sourceId: "control\u0000source" },
    { ...attention("c1-source"), sourceId: "c1\u0085source" },
    { ...attention("bidi-source"), sourceId: "bidi\u202Esource" },
    { ...attention("oversized-source"), sourceId: "x".repeat(513) },
    { ...attention("negative-time"), createdAt: -1 },
    { ...attention("fractional-time"), createdAt: 1.5 },
    { ...attention("unsafe-time"), createdAt: Number.MAX_SAFE_INTEGER + 1 },
  ]);

  await page.goto("/");
  await expect(page.getByTestId("global-human-attention-badge")).toHaveText("2");
  await expect(page.getByTestId("project-human-attention-badge")).toHaveAttribute(
    "aria-label",
    "Project needs human input: 2 pending requests",
  );
  await page.getByText(projectName, { exact: true }).click();
  const sessionBadge = page.getByTestId("session-human-attention-badge");
  await expect(sessionBadge).toContainText("Needs input · 2");
  await expect(sessionBadge).toHaveAttribute(
    "aria-label",
    "Needs human input: 2 pending questions",
  );
  await expect(page.getByText("running", { exact: true })).toBeVisible();

  expect((await notificationSnapshot(page)).requestCount).toBe(0);
  await openNotificationSettings(page);
  await expect(page.getByTestId("browser-notification-state")).toContainText("permission has not been requested");
  expect((await notificationSnapshot(page)).requestCount).toBe(0);
});

test("explicit opt-in deduplicates source replay, uses minimal content, and clicks canonical routing", async ({ page }) => {
  await installCatalogEvents(page);
  await installNotificationMock(page, "granted");
  const api = await installSyntheticApi(page, []);

  await page.goto("/");
  await openNotificationSettings(page);
  expect((await notificationSnapshot(page)).requestCount).toBe(0);
  await page.getByTestId("enable-browser-notifications").click();
  await expect(page.getByTestId("browser-notification-state")).toHaveText("Granted and on");
  expect((await notificationSnapshot(page)).requestCount).toBe(1);
  await page.getByRole("button", { name: "Close settings" }).click();

  api.setAttention([{
    ...attention("new-question-source"),
    questionText: "PRIVATE QUESTION TEXT",
    toolArguments: "--private-argument /private/path",
  }]);
  await api.emitCatalog();
  await expect.poll(async () => (await notificationSnapshot(page)).records.length).toBe(1);
  let snapshot = await notificationSnapshot(page);
  expect(snapshot.records[0]).toEqual({
    title: "Wayang needs your input",
    body: "Question waiting in Wayang",
  });
  expect(JSON.stringify(snapshot.records[0])).not.toContain(sensitiveSessionTitle);
  expect(JSON.stringify(snapshot.records[0])).not.toContain("PRIVATE");
  expect(JSON.stringify(snapshot.records[0])).not.toContain("/private/path");

  await api.emitCatalog();
  await expect.poll(async () => (await notificationSnapshot(page)).records.length).toBe(1);
  api.setAttention([]);
  await api.emitCatalog();
  api.setAttention([attention("new-question-source")]);
  await api.emitCatalog();
  await expect.poll(async () => (await notificationSnapshot(page)).records.length).toBe(1);

  api.setAttention([
    attention("new-question-source"),
    attention("new-question-source-two"),
  ]);
  await api.emitCatalog();
  await expect.poll(async () => (await notificationSnapshot(page)).records.length).toBe(2);
  snapshot = await notificationSnapshot(page);
  expect(snapshot.records[1].body).toBe("Question waiting in Wayang");

  await page.evaluate(() => {
    (window as unknown as { __clickNotification: (index: number) => void }).__clickNotification(0);
  });
  await expect(page).toHaveURL(new RegExp(`/sessions/${encodeURIComponent(sessionId)}$`));
});

test("denied permission leaves in-app attention authoritative", async ({ page }) => {
  await installCatalogEvents(page);
  await installNotificationMock(page, "denied");
  const api = await installSyntheticApi(page, [attention("visible-before-denial")]);

  await page.goto("/");
  await expect(page.getByTestId("global-human-attention-badge")).toHaveText("1");
  await openNotificationSettings(page);
  await page.getByTestId("enable-browser-notifications").click();
  await expect(page.getByTestId("browser-notification-state")).toContainText("Denied in browser settings");

  api.setAttention([attention("visible-before-denial"), attention("visible-after-denial")]);
  await api.emitCatalog();
  await expect(page.getByTestId("global-human-attention-badge")).toHaveText("2");
  const snapshot = await notificationSnapshot(page);
  expect(snapshot.requestCount).toBe(1);
  expect(snapshot.records).toHaveLength(0);
});

test("unsupported Web Notifications leave accessible in-app attention and settings state", async ({ page }) => {
  await installCatalogEvents(page);
  await page.addInitScript(() => {
    Reflect.deleteProperty(window, "Notification");
  });
  await installSyntheticApi(page, [attention("unsupported-source")]);

  await page.goto("/");
  await expect(page.getByTestId("global-human-attention-badge")).toHaveAttribute(
    "aria-label",
    "1 pending human-input request. Open sessions.",
  );
  await openNotificationSettings(page);
  await expect(page.getByTestId("browser-notification-state")).toHaveText("Unsupported by this browser");
  await expect(page.getByTestId("enable-browser-notifications")).toHaveCount(0);
  await expect(page.getByTestId("global-human-attention-badge")).toBeVisible();
});

test("notification dedupe evicts from both bounded order and membership", async ({ page }) => {
  await installCatalogEvents(page);
  await installNotificationMock(page, "granted", "granted");
  const oldest = "bounded-source-0000";
  await page.addInitScript(({ first }) => {
    const ids = Array.from({ length: 4096 }, (_, index) => `bounded-source-${String(index).padStart(4, "0")}`);
    if (ids[0] !== first) throw new Error("Synthetic dedupe fixture is malformed");
    window.localStorage.setItem("wayang:human-attention:browser-notifications-enabled", "1");
    window.localStorage.setItem("wayang:human-attention:seen-source-ids", JSON.stringify(ids));
  }, { first: oldest });
  const api = await installSyntheticApi(page, []);

  await page.goto("/");
  api.setAttention([attention("bounded-source-new")]);
  await api.emitCatalog();
  await expect.poll(async () => (await notificationSnapshot(page)).records.length).toBe(1);

  api.setAttention([attention(oldest)]);
  await api.emitCatalog();
  await expect.poll(async () => (await notificationSnapshot(page)).records.length).toBe(2);
  const stored = await page.evaluate(() => JSON.parse(
    window.localStorage.getItem("wayang:human-attention:seen-source-ids") ?? "[]",
  ) as string[]);
  expect(stored).toHaveLength(4096);
  expect(stored.at(-1)).toBe(JSON.stringify([sessionId, oldest]));
});

test("Notifications Settings remains usable when project and profile loads fail", async ({ page }) => {
  await installCatalogEvents(page);
  await installNotificationMock(page);
  await installSyntheticApi(page, [], { failSettingsLoads: true });

  await page.goto("/");
  await openNotificationSettings(page);
  await expect(page.getByRole("heading", { name: "Human-input notifications" })).toBeVisible();
  await expect(page.getByTestId("browser-notification-state")).toContainText("permission has not been requested");
  await expect(page.getByRole("alert")).toHaveCount(0);
});

test("archive conflict keeps gated session visible and explains the resolution", async ({ page }) => {
  await installCatalogEvents(page);
  const api = await installSyntheticApi(page, [attention("archive-gate")], { archiveConflict: true });
  const alerts: string[] = [];
  page.on("dialog", async (dialog) => {
    if (dialog.type() === "confirm") await dialog.accept();
    else {
      alerts.push(dialog.message());
      await dialog.dismiss();
    }
  });

  await page.goto("/");
  await page.getByText(projectName, { exact: true }).click();
  const row = page.getByTestId("session-row").filter({ has: page.getByText(sensitiveSessionTitle, { exact: true }) });
  await row.hover();
  await row.getByRole("button", { name: "Archive session" }).click();
  await expect.poll(() => alerts.at(-1)).toBe(
    "Archive failed: Resolve or cancel the pending human-input request before archiving this session.",
  );
  await expect(row).toBeVisible();
  await expect(row.getByTestId("session-human-attention-badge")).toBeVisible();
  api.setArchiveConflict(false);
});
