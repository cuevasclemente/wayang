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
          messages: [
            { type: "user", id: "synthetic-history", message: { role: "user", content: "Synthetic retained transcript marker" } },
            { type: "assistant", id: "synthetic-assistant", message: { role: "assistant", content: [{ type: "text", text: "Synthetic named agent response" }] } },
          ],
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

async function installSyntheticApi(page: Page, additionalSessions: ReturnType<typeof session>[] = []): Promise<SyntheticApi> {
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
    if (path === "/api/sessions") return route.fulfill({ json: [currentSession, ...additionalSessions] });
    if (path === `/api/sessions/${sessionId}` && method === "GET") return route.fulfill({ json: currentSession });
    const additionalSession = additionalSessions.find((row) => path === `/api/sessions/${row.id}`);
    if (additionalSession && method === "GET") return route.fulfill({ json: additionalSession });
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

async function flushBrowserCallbacks(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
  }));
}

for (const outcome of ["success", "failure"] as const) {
  test(`late model ${outcome} from A cannot change B's selection or save state`, async ({ page }) => {
    const second = session({ id: "session-model-b", title: "Synthetic model session B" });
    await installSyntheticWebSocket(page);
    await installSyntheticApi(page, [second]);
    const requests: Route[] = [];
    await page.route(/\/api\/sessions\/[^/]+\/model$/, (route) => { requests.push(route); });
    await page.goto(`/sessions/${sessionId}`);
    await expect(page.getByText("Synthetic retained transcript marker", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Small", exact: true }).click();
    await page.getByRole("button", { name: /^Large provider-orchid/ }).click();
    await expect.poll(() => requests.length).toBe(1);

    await page.getByText(second.title, { exact: true }).click();
    await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
    await page.getByTestId("chat-input").fill("B draft remains selected");
    const picker = page.getByRole("button", { name: "Small", exact: true });
    await expect(picker).toBeEnabled();
    if (outcome === "failure") {
      // A's catch/finally must not roll back B or unlock B's pending save.
      await picker.click();
      await page.getByRole("button", { name: /^Large provider-orchid/ }).click();
      await expect.poll(() => requests.length).toBe(2);
    }
    const response = page.waitForResponse((value) => value.url().endsWith(`/sessions/${sessionId}/model`));
    await requests[0]!.fulfill(outcome === "success"
      ? { json: session({ model: "model-large" }) }
      : { status: 400, json: { error: "Synthetic rejected A model" } });
    await (await response).finished();
    await flushBrowserCallbacks(page);
    await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
    await expect(page.getByTestId("chat-input")).toHaveValue("B draft remains selected");
    await expect(page.getByTestId("chat-model-selection-error")).toHaveCount(0);
    if (outcome === "success") await expect(picker).toBeEnabled();
    else {
      await expect(page.getByRole("button", { name: "Large", exact: true })).toBeDisabled();
      await requests[1]!.fulfill({ json: { ...second, model: "model-large" } });
      await expect(page.getByRole("button", { name: "Large", exact: true })).toBeEnabled();
    }
  });
}

test("read aloud resumes when the next chunk arrives after buffering", async ({ page }) => {
  await installSyntheticWebSocket(page);
  await installSyntheticApi(page);
  await page.addInitScript(() => {
    class SyntheticTtsEvents extends EventTarget {
      onerror = null;
      constructor(readonly url: string) {
        super();
        if (url === "/api/tts/jobs/synthetic/events") {
          (window as Window & { __ttsEvents?: SyntheticTtsEvents }).__ttsEvents = this;
        }
      }
      close(): void {}
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: SyntheticTtsEvents });
    HTMLMediaElement.prototype.play = function () { return Promise.resolve(); };
    HTMLMediaElement.prototype.pause = function () {};
  });
  await page.route("**/api/tts/synthesize", (route) => route.fulfill({ json: {
    jobId: "synthetic", status: "queued", manifestUrl: "/api/tts/jobs/synthetic",
    eventsUrl: "/api/tts/jobs/synthetic/events",
  } }));
  await page.route("**/api/tts/jobs/synthetic/chunks/*", (route) => route.fulfill({ status: 204 }));
  await page.goto(`/sessions/${sessionId}`);
  await page.getByRole("button", { name: /Read aloud/ }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window as Window & { __ttsEvents?: EventTarget }).__ttsEvents))).toBe(true);
  const emitChunk = async (index: number) => page.evaluate((chunkIndex) => {
    (window as Window & { __ttsEvents?: EventTarget }).__ttsEvents!.dispatchEvent(new MessageEvent("chunk_completed", {
      data: JSON.stringify({ index: chunkIndex, status: "completed", url: `/api/tts/jobs/synthetic/chunks/${chunkIndex}` }),
    }));
  }, index);
  const audio = page.locator("audio");
  await emitChunk(1);
  await expect(page.getByText("Playing chunk 1", { exact: true })).toBeVisible();
  await audio.dispatchEvent("ended");
  await expect(page.getByText("Buffering next chunk…", { exact: true })).toBeVisible();
  await emitChunk(2);
  await expect(page.getByText("Playing chunk 2", { exact: true })).toBeVisible();
  await expect(audio).toHaveAttribute("src", "/api/tts/jobs/synthetic/chunks/2");
  // Receiving another chunk while playing must not skip the current chunk.
  await emitChunk(3);
  await flushBrowserCallbacks(page);
  await expect(audio).toHaveAttribute("src", "/api/tts/jobs/synthetic/chunks/2");
  await audio.dispatchEvent("ended");
  await expect(page.getByText("Playing chunk 3", { exact: true })).toBeVisible();
  await audio.dispatchEvent("ended");
  await expect(page.getByText("Buffering next chunk…", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const source = (window as Window & { __ttsEvents?: EventTarget }).__ttsEvents!;
    const chunks = [1, 2, 3, 4].map((index) => ({
      index, status: "completed", url: `/api/tts/jobs/synthetic/chunks/${index}`,
    }));
    source.dispatchEvent(new MessageEvent("chunk_completed", { data: JSON.stringify(chunks[3]) }));
    source.dispatchEvent(new MessageEvent("job_completed", { data: JSON.stringify({
      status: "completed", chunks, chunks_total: 4, chunks_completed: 4,
      final_audio_url: "/api/tts/jobs/synthetic/final",
    }) }));
  });
  await expect(page.getByText("Playing chunk 4", { exact: true })).toBeVisible();
  await audio.dispatchEvent("ended");
  await expect(page.getByText("Audio ready", { exact: true })).toBeVisible();
  await expect(audio).toHaveAttribute("src", "/api/tts/jobs/synthetic/chunks/4");
});

test("arbitrary profile labels switch by stable IDs and preserve the session draft and transcript", async ({ page }) => {
  await installSyntheticWebSocket(page);
  const api = await installSyntheticApi(page);
  await page.goto(`/sessions/${sessionId}`);

  const transcript = page.getByText("Synthetic retained transcript marker", { exact: true });
  const assistantResponse = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
  const composer = page.getByTestId("chat-input");
  await expect(transcript).toBeVisible();
  await expect(assistantResponse).toContainText("Synthetic named agent response");
  await expect(assistantResponse.getByTestId("chat-agent-response-name")).toHaveText("Cobalt Finch");
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
