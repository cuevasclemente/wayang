import { expect, test, type Page, type Route } from "@playwright/test";

const projectCwd = "/synthetic/arbitrary-agent-switch";
const projectId = "project-arbitrary-55";
const sessionId = "session-arbitrary-switch";
const currentProfileId = "profile-cobalt-73";
const targetProfileId = "profile-lattice-18";

const models = [
  { provider: "provider-orchid", id: "model-small", name: "Small", api: "synthetic", reasoning: false, input: ["text"], contextWindow: 16_000, available: true },
  { provider: "provider-orchid", id: "model-large", name: "Large", api: "synthetic", reasoning: false, input: ["text"], contextWindow: 32_000, available: true },
];

function session(overrides: Record<string, unknown> = {}) {
  const now = Date.now();
  return {
    id: sessionId,
    pi_session_file: null,
    title: "Synthetic arbitrary profile switch",
    cwd: projectCwd,
    provider: "provider-orchid",
    model: "model-small",
    agent_profile_id: currentProfileId,
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
    ...overrides,
  };
}

function profile(id: string, name: string, defaultModel: string, memoryAccess: "none" | "read") {
  const now = Date.now();
  return {
    id,
    name,
    description: null,
    enabled: true,
    resource_mode: "project_only",
    memory_access: memoryAccess,
    default_provider: "provider-orchid",
    default_model: defaultModel,
    allowed_tools: null,
    allowed_extensions: null,
    capability_grants: [],
    authorization_revision: 1,
    created_at: now,
    updated_at: now,
  };
}

async function installSyntheticWebSocket(page: Page): Promise<void> {
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
        this.emit({
          type: "history",
          session_id: this.sessionId,
          selection_id: this.selectionId,
          messages: [{ type: "user", id: "synthetic-history", message: { role: "user", content: "Synthetic retained transcript marker" } }],
        });
      }
    }
    Object.defineProperty(window, "WebSocket", { configurable: true, value: SyntheticWebSocket });
  });
}

interface SyntheticApi {
  previewBodies: Record<string, unknown>[];
  switchBodies: Record<string, unknown>[];
}

async function installSyntheticApi(page: Page): Promise<SyntheticApi> {
  const profiles = [
    profile(currentProfileId, "Cobalt Finch", "model-small", "none"),
    profile(targetProfileId, "Lattice Observer", "model-large", "read"),
  ];
  let currentSession = session();
  const api: SyntheticApi = { previewBodies: [], switchBodies: [] };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const method = request.method();
    const body = method === "GET" || method === "HEAD" ? {} : (request.postDataJSON() ?? {}) as Record<string, unknown>;

    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "synthetic-user", provider: "synthetic", version: "test" } });
    if (path === "/api/models") return route.fulfill({ json: { models, defaultModel: models[0] } });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/projects/discover" || path === "/api/fs/discover-projects") return route.fulfill({ json: [] });
    if (path === "/api/sessions") return route.fulfill({ json: [currentSession] });
    if (path === `/api/sessions/${sessionId}` && method === "GET") return route.fulfill({ json: currentSession });
    if (path === `/api/sessions/${sessionId}/slash-commands`) return route.fulfill({ json: { commands: [] } });
    if (path === "/api/sessions/events") return route.fulfill({ status: 204 });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/agent-profiles") return route.fulfill({ json: profiles });
    if (path === "/api/projects") return route.fulfill({ json: [{
      id: projectId,
      cwd: projectCwd,
      name: "Quartz Orchard",
      description: null,
      color: null,
      default_agent_profile_id: currentProfileId,
      default_provider: "provider-orchid",
      default_model: "model-small",
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [currentProfileId, targetProfileId] },
      capability_grants: [],
      authorization_revision: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    }] });

    if (path === `/api/sessions/${sessionId}/agent/preview` && method === "POST") {
      api.previewBodies.push(structuredClone(body));
      return route.fulfill({ json: {
        session_id: sessionId,
        from_agent_profile_id: currentProfileId,
        from_agent_name: "Cobalt Finch",
        to_agent_profile_id: targetProfileId,
        to_agent_name: "Lattice Observer",
        current_provider: "provider-orchid",
        current_model: "model-small",
        target_provider: "provider-orchid",
        target_model: "model-large",
        memory_access: "read",
        transcript_retained: true,
        warning: "Identity, resources, tools, memory access, and model may change. Prior transcript context remains visible to the new agent.",
      } });
    }

    if (path === `/api/sessions/${sessionId}/agent` && method === "PUT") {
      api.switchBodies.push(structuredClone(body));
      currentSession = session({ agent_profile_id: targetProfileId, model: "model-large" });
      return route.fulfill({ json: {
        switch_id: "switch-arbitrary-1",
        preview: {
          session_id: sessionId,
          from_agent_profile_id: currentProfileId,
          from_agent_name: "Cobalt Finch",
          to_agent_profile_id: targetProfileId,
          to_agent_name: "Lattice Observer",
          current_provider: "provider-orchid",
          current_model: "model-small",
          target_provider: "provider-orchid",
          target_model: "model-large",
          memory_access: "read",
          transcript_retained: true,
          warning: "Prior transcript context remains visible to the new agent.",
        },
        session: currentSession,
      } });
    }

    return route.fulfill({ json: {} });
  });
  return api;
}

test("arbitrary profile labels switch by stable IDs and preserve the session draft and transcript", async ({ page }) => {
  await installSyntheticWebSocket(page);
  const api = await installSyntheticApi(page);
  await page.goto(`/sessions/${sessionId}`);

  const transcript = page.getByText("Synthetic retained transcript marker", { exact: true });
  const composer = page.getByTestId("chat-input");
  await expect(transcript).toBeVisible();
  await composer.fill("Synthetic unsent composer draft");

  await page.getByRole("button", { name: "Cobalt Finch", exact: true }).click();
  await page.getByRole("option", { name: /Lattice Observer/ }).click();
  const dialog = page.getByRole("dialog", { name: "Switch to Lattice Observer?" });
  await expect(dialog).toContainText("Cobalt Finch → Lattice Observer");
  await expect(dialog).toContainText("provider-orchid/model-small → provider-orchid/model-large");
  await expect(dialog).toContainText("Read only");
  await expect(dialog).toContainText("Prior transcript context remains visible to the new agent.");
  await expect(dialog).toContainText("Your unsent composer draft stays in this browser.");

  expect(api.previewBodies).toEqual([{ agent_profile_id: targetProfileId }]);
  await dialog.getByRole("button", { name: "Switch agent" }).click();

  await expect.poll(() => api.switchBodies).toEqual([{ agent_profile_id: targetProfileId }]);
  await expect(page).toHaveURL(new RegExp(`/sessions/${sessionId}$`));
  await expect(page.getByRole("button", { name: "Lattice Observer", exact: true })).toBeVisible();
  await expect(transcript).toBeVisible();
  await expect(composer).toHaveValue("Synthetic unsent composer draft");
});
