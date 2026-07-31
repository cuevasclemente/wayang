import { expect, test, type Page, type Route } from "@playwright/test";

const syntheticPassword = "synthetic-wayang-password";
const sessionCookie = "wayang_session=synthetic-session";

interface AuthMock {
  expireSession(): void;
}

async function installAuthApi(
  page: Page,
  options: { sessions?: boolean; routeLocalSessionsUnauthorized?: boolean } = {},
): Promise<AuthMock> {
  let sessionValid = true;

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const hasSession = (request.headers().cookie ?? "").includes(sessionCookie) && sessionValid;

    if (path === "/api/auth/status") {
      await route.fulfill({ json: { enabled: true, authenticated: hasSession } });
      return;
    }

    if (path === "/api/auth/login") {
      const body = request.postDataJSON() as { password?: string };
      if (body.password !== syntheticPassword) {
        await route.fulfill({ status: 401, json: { error: "Unauthorized" } });
        return;
      }
      sessionValid = true;
      await route.fulfill({
        json: { enabled: true, authenticated: true },
        headers: { "set-cookie": `${sessionCookie}; Path=/; HttpOnly; SameSite=Strict` },
      });
      return;
    }

    if (path === "/api/auth/logout") {
      sessionValid = false;
      await route.fulfill({
        status: 204,
        headers: { "set-cookie": "wayang_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0" },
      });
      return;
    }

    if (!hasSession) {
      await route.fulfill({
        status: 401,
        headers: { "x-wayang-authentication-required": "1" },
        json: { error: "Unauthorized" },
      });
      return;
    }

    if (path === "/api/sessions" && options.routeLocalSessionsUnauthorized) {
      await route.fulfill({ status: 401, json: { error: "Exact authenticated owner is unavailable" } });
      return;
    }

    if (path === "/api/me") {
      await route.fulfill({ json: { username: "example", provider: "synthetic", version: "test" } });
    } else if (path === "/api/key-mode") {
      await route.fulfill({ json: { mode: "default" } });
    } else if (path === "/api/sessions" && request.method() === "GET") {
      await route.fulfill({ json: options.sessions ? [syntheticSession()] : [] });
    } else if (path === `/api/sessions/${encodeURIComponent(syntheticSession().id)}` && request.method() === "GET") {
      await route.fulfill({ json: syntheticSession() });
    } else if (path === "/api/models") {
      await route.fulfill({ json: { models: [], defaultModel: null } });
    } else if (path === "/api/projects" || path === "/api/agent-profiles") {
      await route.fulfill({ json: [] });
    } else if (path === "/api/scheduled-agent-jobs") {
      await route.fulfill({ json: { jobs: [] } });
    } else if (path === "/api/fs/tree") {
      await route.fulfill({ json: { root: "/tmp/wayang-auth-e2e", path: "/tmp/wayang-auth-e2e", entries: [] } });
    } else if (path === "/api/sessions/events") {
      // HTTP 204 tells EventSource not to reconnect.
      await route.fulfill({ status: 204 });
    } else {
      await route.fulfill({ json: {} });
    }
  });

  return {
    expireSession() {
      sessionValid = false;
    },
  };
}

function syntheticSession() {
  const now = Date.now();
  return {
    id: "synthetic-auth-session",
    pi_session_file: null,
    title: "Authenticated navigation smoke",
    cwd: "/tmp/wayang-auth-e2e",
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

async function signIn(page: Page): Promise<void> {
  await page.getByLabel("Password").fill(syntheticPassword);
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
}

test("login preserves a canonical session deep link, persists across reload, and logs out", async ({ page }) => {
  await installAuthApi(page, { sessions: true });
  const requestedUrl = `/sessions/${encodeURIComponent(syntheticSession().id)}?panel=files#message-42`;

  await page.goto(requestedUrl);
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();

  await page.getByLabel("Password").fill("wrong-synthetic-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toHaveText("The password was not accepted.");

  await signIn(page);
  expect(new URL(page.url()).pathname + new URL(page.url()).search + new URL(page.url()).hash).toBe(requestedUrl);
  await expect(page.locator(`[data-testid="session-row"][data-session-id="${syntheticSession().id}"]`)).toHaveAttribute("aria-current", "page");

  const browserStorage = await page.evaluate(() => ({
    local: Object.values(localStorage),
    session: Object.values(sessionStorage),
  }));
  expect([...browserStorage.local, ...browserStorage.session].join("\n")).not.toContain(syntheticPassword);

  await page.reload();
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);

  await page.getByRole("button", { name: "Log out" }).click();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
});

test("a route-local 401 does not masquerade as Wayang login expiry", async ({ page }) => {
  await installAuthApi(page, { routeLocalSessionsUnauthorized: true });
  await page.goto("/");
  await signIn(page);

  await expect(page.getByRole("heading", { name: "Sign in" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Log out" })).toBeVisible();
});

test("an expired WebSocket session stops reconnects and returns to login", async ({ page }) => {
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
        const counter = window as typeof window & { __authWsAttempts?: number };
        counter.__authWsAttempts = (counter.__authWsAttempts ?? 0) + 1;
        window.setTimeout(() => {
          if (this.readyState !== SyntheticWebSocket.CONNECTING) return;
          this.readyState = SyntheticWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          window.setTimeout(() => {
            if (this.readyState !== SyntheticWebSocket.OPEN) return;
            this.readyState = SyntheticWebSocket.CLOSED;
            this.onclose?.(new CloseEvent("close", { code: 1006 }));
          }, 100);
        }, 0);
      }

      send(): void {}

      close(): void {
        this.readyState = SyntheticWebSocket.CLOSED;
      }
    }

    Object.defineProperty(window, "WebSocket", { configurable: true, value: SyntheticWebSocket });
  });

  const auth = await installAuthApi(page, { sessions: true });
  await page.goto("/");
  await signIn(page);
  await page.getByText("wayang-auth-e2e", { exact: true }).click();
  await page.getByText("Authenticated navigation smoke", { exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __authWsAttempts?: number }).__authWsAttempts ?? 0)).toBeGreaterThan(0);

  auth.expireSession();
  await expect(page.getByRole("heading", { name: "Sign in" })).toBeVisible();
  const attemptsAtLogin = await page.evaluate(() => (window as typeof window & { __authWsAttempts?: number }).__authWsAttempts ?? 0);
  await page.waitForTimeout(800);
  expect(await page.evaluate(() => (window as typeof window & { __authWsAttempts?: number }).__authWsAttempts ?? 0)).toBe(attemptsAtLogin);
});
