import { expect, test, type Page, type Route } from "@playwright/test";

const projectCwd = "/tmp/wayang-session-url-e2e";
const sessionAId = "synthetic route session A";
const sessionBId = "synthetic-route-session-B";
const scheduledJobId = "synthetic-session-url-job";

function canonicalPath(sessionId: string): string {
  return `/sessions/${encodeURIComponent(sessionId)}`;
}

function syntheticSession(id: string, title: string) {
  const now = Date.now();
  return {
    id,
    pi_session_file: null,
    title,
    cwd: projectCwd,
    provider: null,
    model: null,
    created_at: now,
    last_active: now,
    archived: 0,
    goal: null,
    goal_status: null,
    scheduled_job_id: null,
    scheduled_run_id: null,
    error: null,
    runtime_status: "stopped",
    runtime_is_streaming: false,
    runtime_subscriber_count: 0,
    runtime_last_activity_at: null,
  };
}

const scheduledJob = {
  id: scheduledJobId,
  name: "Synthetic scheduled job",
  schedule_kind: "cron",
  cron_expr: "0 9 * * *",
  timezone: null,
  prompt: "Public synthetic scheduled prompt",
  cwd: projectCwd,
  provider: null,
  model: null,
  permission_mode: "default",
  command_guard_mode: "default",
  timeout_ms: 600_000,
  prompt_timeout_ms: 60_000,
  overlap_policy: "skip",
  missed_run_policy: "skip",
  enabled: true,
  created_at: Date.now(),
  updated_at: Date.now(),
  last_run_at: Date.now(),
  next_run_at: null,
};

interface SyntheticApi {
  setDetailStatus(sessionId: string, status: number | null): void;
}

async function installSyntheticWebSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    class SyntheticWebSocket extends EventTarget {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly CONNECTING = 0;
      readonly OPEN = 1;
      readonly CLOSING = 2;
      readonly CLOSED = 3;
      readonly url: string;
      readyState = SyntheticWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        window.setTimeout(() => {
          this.readyState = SyntheticWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          const parsed = new URL(this.url);
          this.emitSession(parsed.searchParams.get("session_id"), parsed.searchParams.get("selection_id"));
        }, 0);
      }

      private emitSession(sessionId: string | null, selectionId: string | null): void {
        if (!sessionId || !selectionId) return;
        window.setTimeout(() => {
          this.onmessage?.(new MessageEvent("message", {
            data: JSON.stringify({ type: "session_ready", session_id: sessionId, selection_id: selectionId }),
          }));
          this.onmessage?.(new MessageEvent("message", {
            data: JSON.stringify({ type: "history", session_id: sessionId, selection_id: selectionId, messages: [] }),
          }));
        }, 0);
      }

      send(data: string): void {
        try {
          const message = JSON.parse(data) as { type?: string; session_id?: string; selection_id?: string };
          if (message.type === "switch_session") {
            this.emitSession(message.session_id ?? null, message.selection_id ?? null);
          }
        } catch {
          // Ignore non-JSON synthetic traffic.
        }
      }

      close(): void {
        this.readyState = SyntheticWebSocket.CLOSED;
      }
    }

    Object.defineProperty(window, "WebSocket", { configurable: true, value: SyntheticWebSocket });
  });
}

async function installSyntheticApi(page: Page): Promise<SyntheticApi> {
  let sessions = [
    syntheticSession(sessionAId, "Synthetic URL session A"),
    syntheticSession(sessionBId, "Synthetic URL session B"),
  ];
  const detailStatuses = new Map<string, number>();

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "example", provider: "synthetic", version: "test" } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/projects" || path === "/api/agent-profiles") return route.fulfill({ json: [] });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/sessions/events") return route.fulfill({ status: 204 });
    if (path === "/api/fs/tree") return route.fulfill({ json: { root: projectCwd, path: projectCwd, entries: [] } });
    if (path === "/api/apps") return route.fulfill({ json: [] });
    if (path === "/api/capabilities") return route.fulfill({ json: { cwd: projectCwd, capabilities: [] } });

    if (path === "/api/sessions/search") {
      return route.fulfill({
        json: {
          query: url.searchParams.get("q") ?? "",
          took_ms: 1,
          results: [{
            session_id: sessionBId,
            title: "Synthetic URL session B",
            cwd: projectCwd,
            model: null,
            last_active: Date.now(),
            archived: false,
            score: 1,
            best_role: "user",
            snippet_html: "Synthetic search marker",
            best_message_id: null,
          }],
          facets: { cwds: [], models: [] },
        },
      });
    }

    if (path === "/api/sessions" && request.method() === "GET") {
      return route.fulfill({ json: sessions });
    }

    const deleteMatch = path.match(/^\/api\/sessions\/([^/]+)\/delete$/);
    if (deleteMatch && request.method() === "POST") {
      const sessionId = decodeURIComponent(deleteMatch[1]);
      sessions = sessions.filter((session) => session.id !== sessionId);
      return route.fulfill({ json: { deleted: true, deleted_session_file: null } });
    }

    const detailMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (detailMatch && request.method() === "GET") {
      const sessionId = decodeURIComponent(detailMatch[1]);
      const forcedStatus = detailStatuses.get(sessionId);
      if (forcedStatus) return route.fulfill({ status: forcedStatus, json: { error: "Synthetic detail failure" } });
      const session = sessions.find((candidate) => candidate.id === sessionId);
      return session
        ? route.fulfill({ json: session })
        : route.fulfill({ status: 404, json: { error: "Session not found" } });
    }

    if (path.match(/^\/api\/sessions\/[^/]+\/slash-commands$/)) {
      return route.fulfill({ json: { commands: [] } });
    }

    if (path === "/api/scheduled-agent-jobs") {
      return route.fulfill({ json: { jobs: [scheduledJob] } });
    }
    if (path === `/api/scheduled-agent-jobs/${scheduledJobId}`) {
      return route.fulfill({
        json: {
          job: scheduledJob,
          runs: [{
            id: "synthetic-session-url-run",
            job_id: scheduledJobId,
            session_id: sessionAId,
            trigger: "schedule",
            scheduled_for: null,
            started_at: Date.now(),
            finished_at: Date.now(),
            status: "completed",
            error_message: null,
            result_summary: "Synthetic run complete",
          }],
        },
      });
    }

    return route.fulfill({ json: {} });
  });

  return {
    setDetailStatus(sessionId: string, status: number | null) {
      if (status == null) detailStatuses.delete(sessionId);
      else detailStatuses.set(sessionId, status);
    },
  };
}

async function preparePage(page: Page): Promise<SyntheticApi> {
  await installSyntheticWebSocket(page);
  return installSyntheticApi(page);
}

function sessionRow(page: Page, sessionId: string) {
  return page.locator(`[data-testid="session-row"][data-session-id="${sessionId}"]`);
}

async function openProject(page: Page): Promise<void> {
  await page.locator(`div[title="${projectCwd}"]`).click();
}

test("session selection writes canonical URLs without duplicate history and supports Back/Forward", async ({ page }) => {
  await preparePage(page);
  await page.goto("/");
  await openProject(page);

  await sessionRow(page, sessionAId).click();
  await expect(page).toHaveURL(new RegExp(`${canonicalPath(sessionAId).replace(/%/g, "%")}$`));
  await expect(sessionRow(page, sessionAId)).toHaveAttribute("aria-current", "page");

  // Re-selecting the active row must not add another history entry.
  await sessionRow(page, sessionAId).click();
  await sessionRow(page, sessionBId).click();
  expect(new URL(page.url()).pathname).toBe(canonicalPath(sessionBId));

  await page.goBack();
  await expect(sessionRow(page, sessionAId)).toHaveAttribute("aria-current", "page");
  expect(new URL(page.url()).pathname).toBe(canonicalPath(sessionAId));

  await page.goBack();
  await expect(page.getByText("Select a session or create a new one")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe("/");

  await page.goForward();
  await expect(sessionRow(page, sessionAId)).toHaveAttribute("aria-current", "page");
  await page.goForward();
  await expect(sessionRow(page, sessionBId)).toHaveAttribute("aria-current", "page");
});

test("direct deep links restore, canonicalize a trailing slash, and survive refresh", async ({ page }) => {
  await preparePage(page);
  await page.goto(`${canonicalPath(sessionAId)}/`);

  await expect(sessionRow(page, sessionAId)).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No messages yet")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(canonicalPath(sessionAId));

  await page.reload();
  await expect(sessionRow(page, sessionAId)).toHaveAttribute("aria-current", "page");
  await expect(page.getByText("No messages yet")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(canonicalPath(sessionAId));
});

test("search results and scheduled runs use the canonical session route", async ({ page }) => {
  await preparePage(page);
  await page.goto("/");

  await page.getByTestId("session-search-input").fill("marker");
  await page.getByTestId("session-search-result").click();
  expect(new URL(page.url()).pathname).toBe(canonicalPath(sessionBId));

  await page.getByText("Synthetic scheduled job", { exact: true }).click();
  await page.getByTestId("scheduled-run-open-session").click();
  expect(new URL(page.url()).pathname).toBe(canonicalPath(sessionAId));
});

test("missing, transient, and malformed routes show controlled recovery states", async ({ page }) => {
  const api = await preparePage(page);
  const missingId = "synthetic-missing-session";

  await page.goto(canonicalPath(missingId));
  await expect(page.getByTestId("session-route-not-found")).toContainText("Session not found");
  await expect(page.getByTestId("session-search-input")).toBeVisible();
  expect(new URL(page.url()).pathname).toBe(canonicalPath(missingId));

  api.setDetailStatus(sessionAId, 500);
  await page.goto(canonicalPath(sessionAId));
  await expect(page.getByTestId("session-route-error")).toContainText("Unable to load session");
  await expect(page.getByTestId("session-route-not-found")).toHaveCount(0);
  api.setDetailStatus(sessionAId, null);
  await page.getByTestId("session-route-retry").click();
  await expect(sessionRow(page, sessionAId)).toHaveAttribute("aria-current", "page");

  // Vite rejects malformed URI escapes before its SPA fallback runs. Exercise
  // the browser-side parser through History API navigation instead.
  await page.evaluate(() => {
    window.history.pushState(window.history.state, "", "/sessions/malformed%E0%A4%A");
    window.dispatchEvent(new PopStateEvent("popstate", { state: window.history.state }));
  });
  await expect(page.getByTestId("session-route-not-found")).toContainText("Session not found");
  await page.getByTestId("session-route-browse").click();
  await expect(page.getByTestId("session-search-input")).toBeVisible();
});

test("a missing deep link exposes the session list and recovery notice on mobile", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await preparePage(page);
  await page.goto(canonicalPath("synthetic-mobile-missing"));

  await expect(page.locator('[data-testid="session-route-not-found"]:visible')).toContainText("Session not found");
  await expect(page.getByTestId("session-search-input")).toBeVisible();
  await expect(page.getByTestId("mobile-tab-bar")).toBeVisible();
});

test("permanently deleting the active session replaces its URL with root", async ({ page }) => {
  await preparePage(page);
  await page.goto(canonicalPath(sessionAId));
  const row = sessionRow(page, sessionAId);
  await expect(row).toHaveAttribute("aria-current", "page");

  await row.hover();
  await row.getByRole("button", { name: "Delete session" }).click();
  await page.getByTestId("delete-session-pin").fill("12345678");
  await page.getByTestId("delete-session-confirm").click();

  await expect(row).toHaveCount(0);
  expect(new URL(page.url()).pathname).toBe("/");
  await expect(page.getByText("Select a session or create a new one")).toBeVisible();
});
