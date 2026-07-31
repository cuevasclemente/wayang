import { expect, test, type Page, type Route } from "@playwright/test";

const sessionId = "synthetic-app-bridge-session";
const projectCwd = "/tmp/wayang-app-bridge-e2e";
const appId = "bridge-security-app";

function session() {
  const now = Date.now();
  return {
    id: sessionId,
    pi_session_file: null,
    title: "App bridge security",
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

function app() {
  return {
    id: appId,
    sessionId,
    projectCwd,
    manifestPath: `${projectCwd}/.pi/apps/${appId}/app.json`,
    manifest: {
      schemaVersion: 1,
      id: appId,
      name: "Bridge Security App",
      entry: {
        type: "managed-process",
        workingDirectory: `.pi/apps/${appId}`,
        devCommand: "synthetic-app",
      },
    },
    status: "running",
    url: "http://127.0.0.1:19999",
    updatedAt: Date.now(),
  };
}

async function installApi(page: Page) {
  let stateWrites = 0;
  let eventWrites = 0;
  let state: unknown = { visible: "initial-state" };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;

    if (path === `/api/apps/${appId}/proxy/${sessionId}/`) {
      await route.fulfill({
        contentType: "text/html",
        body: `<!doctype html><script>
          window.__receivedStates = [];
          addEventListener('message', (event) => {
            if (event.data?.source === 'wayang' && event.data?.type === 'state:update') {
              window.__receivedStates.push(event.data.state);
            }
          });
        </script><main>bridge app loaded</main>`,
      });
      return;
    }
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "example", provider: "synthetic", version: "test" } });
    if (path === "/api/sessions" && request.method() === "GET") return route.fulfill({ json: [session()] });
    if (path === "/api/sessions/events") return route.fulfill({ status: 204 });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/projects") return route.fulfill({ json: [] });
    if (path === "/api/agent-profiles") return route.fulfill({ json: [] });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/apps") return route.fulfill({ json: [app()] });
    if (path === `/api/apps/${appId}/events` && request.method() === "GET") return route.fulfill({ json: [] });
    if (path === `/api/apps/${appId}/events` && request.method() === "POST") {
      eventWrites += 1;
      return route.fulfill({ status: 201, json: { id: `event-${eventWrites}`, appId, sessionId, projectCwd, type: "app_event", event: "test", createdAt: Date.now() } });
    }
    if (path === `/api/apps/${appId}/state` && request.method() === "GET") {
      return route.fulfill({ json: { appId, sessionId, projectCwd, state, updatedAt: Date.now() } });
    }
    if (path === `/api/apps/${appId}/state` && request.method() === "PUT") {
      stateWrites += 1;
      state = (request.postDataJSON() as { state?: unknown }).state ?? null;
      return route.fulfill({ json: { appId, sessionId, projectCwd, state, updatedAt: Date.now() } });
    }
    return route.fulfill({ json: {} });
  });

  return {
    stateWrites: () => stateWrites,
    eventWrites: () => eventWrites,
  };
}

test("app bridge accepts only the registered same-origin iframe window", async ({ page }) => {
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
      readyState = SyntheticWebSocket.CONNECTING;
      onopen: ((event: Event) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      constructor(_url: string | URL) {
        super();
        setTimeout(() => {
          this.readyState = SyntheticWebSocket.OPEN;
          this.onopen?.(new Event("open"));
        }, 0);
      }
      send(): void {}
      close(): void { this.readyState = SyntheticWebSocket.CLOSED; }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: SyntheticWebSocket });
  });

  const api = await installApi(page);
  await page.goto("/");
  await page.getByText("wayang-app-bridge-e2e", { exact: true }).click();
  await page.getByText("App bridge security", { exact: true }).click();
  await page.getByRole("button", { name: "Apps", exact: true }).click();
  await page.getByRole("button", { name: "Open", exact: true }).click();

  const frame = page.frameLocator('iframe[title="Bridge Security App"]');
  await expect(frame.getByText("bridge app loaded")).toBeVisible();
  await expect.poll(() => frame.locator("body").evaluate(() => (window as typeof window & { __receivedStates?: unknown[] }).__receivedStates?.length ?? 0)).toBeGreaterThan(0);

  // A forged message from the parent window has the right origin but the wrong source.
  await page.evaluate(({ appId }) => {
    window.postMessage({ source: "pi-app", appId, type: "state:set", state: { forged: "parent" } }, window.location.origin);
  }, { appId });
  await page.waitForTimeout(200);
  expect(api.stateWrites()).toBe(0);

  // A nested iframe is also not the registered app window.
  await frame.locator("body").evaluate((_body, { appId }) => {
    const nested = document.createElement("iframe");
    nested.srcdoc = `<script>top.postMessage({source:'pi-app',appId:'${appId}',type:'state:set',state:{forged:'nested'}}, location.origin)<\/script>`;
    document.body.appendChild(nested);
  }, { appId });
  await page.waitForTimeout(300);
  expect(api.stateWrites()).toBe(0);

  // The registered same-origin iframe is accepted.
  await page.evaluate(() => {
    const root = window as typeof window & { __bridgeDebug?: Array<{ origin: string; sourceMatches: boolean; data: unknown }> };
    root.__bridgeDebug = [];
    window.addEventListener("message", (event) => {
      root.__bridgeDebug!.push({
        origin: event.origin,
        sourceMatches: event.source === document.querySelector("iframe")?.contentWindow,
        data: event.data,
      });
    });
  });
  await frame.locator("body").evaluate((_body, { appId }) => {
    window.parent.postMessage({ source: "pi-app", appId, type: "event", event: "accepted" }, window.location.origin);
  }, { appId });
  await expect.poll(() => page.evaluate(() => (window as typeof window & { __bridgeDebug?: unknown[] }).__bridgeDebug?.length ?? 0)).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as typeof window & { __bridgeDebug?: Array<{ origin: string; sourceMatches: boolean; data: unknown }> }).__bridgeDebug?.at(-1))).toEqual({
    origin: new URL(page.url()).origin,
    sourceMatches: true,
    data: { source: "pi-app", appId, type: "event", event: "accepted" },
  });
  await expect.poll(api.eventWrites).toBe(1);
});
