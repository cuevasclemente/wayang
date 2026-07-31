import { expect, test, type Page, type Route } from "@playwright/test";

const profileGranted = "profile-cobalt-73";
const profileWrong = "profile-lattice-18";
const grantedSessionId = "session-maple-granted";
const secondProtectedSessionId = "session-river-ungranted";
const wrongProfileSessionId = "session-maple-wrong-profile";
const ordinarySessionId = "session-sunrise-ordinary";

const projects = [
  { id: "project-maple-10", cwd: "/synthetic/maple-vault", name: "Maple Vault", privacy: "protected", profiles: [profileGranted, profileWrong] },
  { id: "project-river-20", cwd: "/synthetic/river-vault", name: "River Vault", privacy: "protected", profiles: [profileGranted] },
  { id: "project-sunrise-30", cwd: "/synthetic/sunrise-lab", name: "Sunrise Lab", privacy: "standard", profiles: [profileGranted] },
] as const;

const sessions = [
  { id: grantedSessionId, cwd: projects[0].cwd, title: "Maple browser", profileId: profileGranted },
  { id: secondProtectedSessionId, cwd: projects[1].cwd, title: "River browser", profileId: profileGranted },
  { id: wrongProfileSessionId, cwd: projects[0].cwd, title: "Wrong profile browser", profileId: profileWrong },
  { id: ordinarySessionId, cwd: projects[2].cwd, title: "Ordinary browser", profileId: profileGranted },
] as const;

function session(row: typeof sessions[number]) {
  const now = Date.now();
  return {
    id: row.id,
    pi_session_file: null,
    title: row.title,
    cwd: row.cwd,
    provider: "provider-orchid",
    model: "model-cascade",
    agent_profile_id: row.profileId,
    pending_agent_switch: null,
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
    bash_mode: "unavailable",
    browser_mode: row.id === grantedSessionId
      ? "protected"
      : row.id === ordinarySessionId
        ? "standard"
        : "unavailable",
  };
}

function browserState(
  row: typeof sessions[number],
  persistence: "project" | "protected",
  status: "stopped" | "running",
  controlMode: "agent" | "user" | "paused",
) {
  return {
    sessionId: row.id,
    projectCwd: row.cwd,
    status,
    controlMode,
    secretTainted: false,
    localOnlyRecommended: persistence === "protected",
    needsUser: controlMode !== "agent",
    ...(controlMode !== "agent" ? { needsUserReason: "Synthetic human handoff" } : {}),
    cdpReady: status === "running",
    viewerTransport: "cdp-screencast",
    cdpScreencastWsPath: `/ws/browser?session_id=${encodeURIComponent(row.id)}`,
    vncReady: false,
    profile: { persistence },
    ...(persistence === "protected" ? {
      credentialBroker: { supported: true, guarded: true },
      download: {
        status: "completed",
        suggestedFilename: "synthetic-report.csv",
        relativePath: ".wayang/browser-downloads/synthetic-report.csv",
        bytes: 2048,
        updatedAt: Date.now(),
      },
    } : {}),
    ...(status === "running" ? { startedAt: Date.now() } : {}),
    updatedAt: Date.now(),
  };
}

interface SyntheticBrowserApi {
  browserRequests: Array<{ path: string; sessionId: string | null; querySessionId: string | null; fields: string[] }>;
}

async function installSyntheticChatSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler<T> = ((event: T) => void) | null;
    class SyntheticWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = SyntheticWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      private sessionId: string;
      private selectionId: string | null;

      constructor(url: string | URL) {
        const parsed = new URL(String(url), window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        window.setTimeout(() => {
          this.readyState = SyntheticWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emitSelection();
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as { type?: string; session_id?: string; selection_id?: string };
        if (message.type !== "switch_session") return;
        this.sessionId = message.session_id ?? "";
        this.selectionId = message.selection_id ?? null;
        this.emitSelection();
      }

      close(): void { this.readyState = SyntheticWebSocket.CLOSED; }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }

      private emitSelection(): void {
        if (!this.sessionId || !this.selectionId) return;
        this.emit({ type: "session_runtime_state", session_id: this.sessionId, selection_id: this.selectionId, bash_mode: "unavailable" });
        this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: [] });
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: SyntheticWebSocket });
  });
}

async function installSyntheticApi(page: Page): Promise<SyntheticBrowserApi> {
  const api: SyntheticBrowserApi = { browserRequests: [] };
  const statuses = new Map<string, "stopped" | "running">();
  const controlModes = new Map<string, "agent" | "user" | "paused">();
  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    const method = request.method();
    const body = method === "GET" || method === "HEAD" ? {} : (request.postDataJSON() ?? {}) as Record<string, unknown>;

    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "synthetic-user", provider: "synthetic", version: "test" } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/projects/discover" || path === "/api/fs/discover-projects") return route.fulfill({ json: [] });
    if (path === "/api/sessions") return route.fulfill({ json: sessions.map(session) });
    if (path === "/api/sessions/events") return route.fulfill({ status: 204 });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    const sessionMatch = path.match(/^\/api\/sessions\/([^/]+)$/);
    if (sessionMatch) {
      const row = sessions.find((candidate) => candidate.id === decodeURIComponent(sessionMatch[1]));
      return row ? route.fulfill({ json: session(row) }) : route.fulfill({ status: 404, json: { error: "Session not found" } });
    }
    if (path.match(/^\/api\/sessions\/[^/]+\/slash-commands$/)) return route.fulfill({ json: { commands: [] } });
    if (path === "/api/projects") return route.fulfill({ json: projects.map((row) => ({
      id: row.id,
      cwd: row.cwd,
      name: row.name,
      description: null,
      color: null,
      default_agent_profile_id: row.profiles[0],
      default_provider: "provider-orchid",
      default_model: "model-cascade",
      access_policy: { privacy_mode: row.privacy, allowed_agent_profile_ids: [...row.profiles] },
      capability_grants: [],
      authorization_revision: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    })) });
    if (path === "/api/agent-profiles") return route.fulfill({ json: [profileGranted, profileWrong].map((id, index) => ({
      id,
      name: index === 0 ? "Cobalt Finch" : "Lattice Observer",
      description: null,
      enabled: true,
      resource_mode: "project_only",
      memory_access: "none",
      default_provider: "provider-orchid",
      default_model: "model-cascade",
      allowed_tools: null,
      allowed_extensions: null,
      capability_grants: [],
      authorization_revision: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    })) });

    if (path.startsWith("/api/browser/")) {
      const requestedSessionId = typeof body.sessionId === "string" ? body.sessionId : url.searchParams.get("session_id");
      api.browserRequests.push({
        path,
        sessionId: requestedSessionId,
        querySessionId: url.searchParams.get("session_id"),
        fields: Object.keys(body).sort(),
      });
      const row = sessions.find((candidate) => candidate.id === requestedSessionId);
      if (!row) return route.fulfill({ status: 403, json: { error: "An exact live session binding is required" } });
      if (row.id === secondProtectedSessionId) {
        return route.fulfill({ status: 403, json: { error: "No active protected browser capability exists for this project" } });
      }
      if (row.id === wrongProfileSessionId) {
        return route.fulfill({ status: 403, json: { error: "The active profile does not match the protected browser activation" } });
      }
      if (path === "/api/browser/start" || path === "/api/browser/restart") statuses.set(row.id, "running");
      if (path === "/api/browser/stop" || path === "/api/browser/reset-profile") statuses.set(row.id, "stopped");
      if (path === "/api/browser/control-mode" && (body.mode === "agent" || body.mode === "user" || body.mode === "paused")) {
        controlModes.set(row.id, body.mode);
      }
      const status = statuses.get(row.id) ?? "stopped";
      const controlMode = controlModes.get(row.id) ?? "agent";
      if (row.id === grantedSessionId) return route.fulfill({ json: browserState(row, "protected", status, controlMode) });
      return route.fulfill({ json: browserState(row, "project", status, controlMode) });
    }

    return route.fulfill({ json: {} });
  });
  return api;
}

async function prepare(page: Page): Promise<SyntheticBrowserApi> {
  await installSyntheticChatSocket(page);
  return installSyntheticApi(page);
}

async function openBrowser(page: Page, selectedSessionId: string): Promise<void> {
  await page.goto(`/sessions/${selectedSessionId}`);
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await page.getByRole("button", { name: "Browser", exact: true }).click();
}

test("backend-issued protected runtime selects the generic protected-browser UX for arbitrary labels", async ({ page }) => {
  const api = await prepare(page);
  await openBrowser(page, grantedSessionId);

  const safetyDetails = page.getByText("Safety, privacy, and browser details", { exact: true });
  await expect(safetyDetails).toBeVisible();
  await expect(page.locator('[role="note"]')).not.toBeVisible();
  await safetyDetails.click();
  await expect(page.getByRole("note")).toContainText("Protected browser capability");
  await expect(page.getByRole("note")).toContainText("purchases, deletions, exports, account changes, logout, or passkey flows");
  const downloads = page.getByTestId("protected-downloads");
  await expect(downloads).toContainText(".wayang/browser-downloads/");
  await expect(downloads.getByTestId("protected-download-status")).toContainText("completed");
  await expect(downloads.getByTestId("protected-download-status")).toContainText("2.0 KiB");
  await expect(downloads.getByRole("button", { name: /Recover|Discard|quarantine/i })).toHaveCount(0);
  await expect(page.getByText("Protected capability", { exact: true })).toBeVisible();
  await expect(page.getByText("Start the backend-issued protected browser runtime.", { exact: true })).toBeVisible();

  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Credentials", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste…", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset profile", exact: true })).toBeVisible();
  await expect(page.getByRole("radio", { name: "Fast page", exact: true })).toHaveAttribute("aria-checked", "true");
  await expect(page.getByText("VNC unavailable", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Browser URL")).toBeVisible();

  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect(page.getByRole("button", { name: "Human control", exact: true })).toBeEnabled();
  await page.getByRole("button", { name: "Human control", exact: true }).click();
  await expect(page.getByTestId("protected-human-handoff")).toContainText("owner-only route");
  await expect(page.getByTestId("protected-human-handoff")).toContainText("fresh safe page");

  await page.getByRole("button", { name: "Paste…", exact: true }).click();
  await page.getByLabel("Direct paste target").fill("synthetic owner-only text");
  await expect.poll(() => api.browserRequests.some((entry) => entry.path === "/api/browser/paste-text" && entry.sessionId === grantedSessionId)).toBe(true);

  await page.getByRole("button", { name: "Restart", exact: true }).click();
  await expect.poll(() => api.browserRequests.some((entry) => entry.path === "/api/browser/restart" && entry.sessionId === grantedSessionId)).toBe(true);

  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Reset profile", exact: true }).click();
  await expect.poll(() => api.browserRequests.some((entry) => entry.path === "/api/browser/reset-profile" && entry.fields.includes("confirmed"))).toBe(true);

  expect(api.browserRequests.some((entry) => entry.path === "/api/browser/status" && entry.sessionId === grantedSessionId)).toBe(true);
  expect(api.browserRequests.some((entry) => entry.path === "/api/browser/control-mode" && entry.sessionId === grantedSessionId)).toBe(true);
  expect(api.browserRequests.filter((entry) => entry.path !== "/api/browser/status").every((entry) => entry.querySessionId === grantedSessionId)).toBe(true);
});

for (const denied of [
  { sessionId: secondProtectedSessionId },
  { sessionId: wrongProfileSessionId },
]) {
  test(`protected browser fails closed for ${denied.sessionId}`, async ({ page }) => {
    const api = await prepare(page);
    await page.goto(`/sessions/${denied.sessionId}`);
    await expect(page.getByTestId("chat-input")).toBeEnabled();

    await expect(page.getByRole("button", { name: "Browser", exact: true })).toHaveCount(0);
    await expect(page.getByRole("note")).toHaveCount(0);
    expect(api.browserRequests.filter((entry) => entry.sessionId === denied.sessionId)).toEqual([]);
  });
}

test("ordinary sessions retain generic browser behavior", async ({ page }) => {
  const api = await prepare(page);
  await openBrowser(page, ordinarySessionId);

  await expect(page.getByRole("note")).toHaveCount(0);
  await expect(page.getByTestId("protected-downloads")).toHaveCount(0);
  await expect(page.getByText("Start Chromium to use the backend-selected browser runtime.", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Restart", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Credentials", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Paste…", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Reset profile", exact: true })).toBeVisible();
  await expect(page.getByLabel("Browser URL")).toBeVisible();
  expect(api.browserRequests.some((entry) => entry.path === "/api/browser/status" && entry.sessionId === ordinarySessionId)).toBe(true);
});
