import { expect, test, type Page, type Route } from "@playwright/test";

const sessionId = "synthetic-cancellation-session";
const projectCwd = "/tmp/wayang-interview-cancellation-e2e";
const requestId = "synthetic-cancel-request";

async function installSyntheticBackend(page: Page): Promise<void> {
  const now = Date.now();
  const project = {
    id: "synthetic-cancellation-project",
    cwd: projectCwd,
    name: "Cancellation project",
    description: null,
    color: null,
    default_agent_profile_id: "synthetic-profile",
    default_provider: null,
    default_model: null,
    access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: null },
    created_at: now,
    updated_at: now,
  };
  const session = {
    id: sessionId,
    pi_session_file: null,
    title: "Cancellation session",
    cwd: projectCwd,
    provider: null,
    model: null,
    agent_profile_id: "synthetic-profile",
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
    runtime_is_compacting: false,
    runtime_subscriber_count: 0,
    runtime_last_activity_at: null,
    bash_mode: "unavailable",
    browser_mode: "unavailable",
    humanAttention: [],
  };

  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "synthetic", provider: "synthetic", version: "test" } });
    if (path === "/api/sessions") return route.fulfill({ json: [session] });
    if (path === `/api/sessions/${sessionId}`) return route.fulfill({ json: session });
    if (path === "/api/projects") return route.fulfill({ json: [project] });
    if (path === "/api/agent-profiles") return route.fulfill({ json: [{
      id: "synthetic-profile", name: "Synthetic profile", description: null, enabled: true,
      resource_mode: "project_only", memory_access: "none", default_provider: null,
      default_model: null, allowed_tools: null, allowed_extensions: null, created_at: now, updated_at: now,
    }] });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/protected-automations") return route.fulfill({ json: { milestone: 0, activationAvailable: false, production_services: false } });
    if (path === "/api/protected-automations/jobs") return route.fulfill({ json: { jobs: [] } });
    if (path.match(/^\/api\/sessions\/[^/]+\/slash-commands$/)) return route.fulfill({ json: { commands: [] } });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/fs/tree") return route.fulfill({ json: { root: projectCwd, path: projectCwd, entries: [] } });
    if (path === "/api/apps") return route.fulfill({ json: [] });
    if (path === "/api/capabilities") return route.fulfill({ json: { cwd: projectCwd, capabilities: [] } });
    return route.fulfill({ json: {} });
  });

  await page.addInitScript(({ ownerSessionId, interviewRequestId }) => {
    class SyntheticEventSource {
      onerror: ((event: Event) => void) | null = null;
      addEventListener(): void {}
      close(): void {}
    }
    Object.defineProperty(window, "EventSource", { configurable: true, value: SyntheticEventSource });

    type Handler = ((event: Event & { data?: string; code?: number; reason?: string }) => unknown) | null;
    const sockets: SyntheticWebSocket[] = [];
    const outbound: unknown[] = [];

    class SyntheticWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readyState = SyntheticWebSocket.CONNECTING;
      onopen: Handler = null;
      onmessage: Handler = null;
      onclose: Handler = null;
      onerror: Handler = null;
      private readonly selectionId: string;

      constructor(url: string | URL) {
        this.url = String(url);
        this.selectionId = new URL(this.url).searchParams.get("selection_id") ?? "";
        sockets.push(this);
        window.setTimeout(() => {
          if (this.readyState !== SyntheticWebSocket.CONNECTING) return;
          this.readyState = SyntheticWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.deliver({ type: "session_loading", session_id: ownerSessionId, selection_id: this.selectionId });
          this.deliver({ type: "session_runtime_state", session_id: ownerSessionId, selection_id: this.selectionId, bash_mode: "unavailable" });
          this.deliver({ type: "session_ready", session_id: ownerSessionId, selection_id: this.selectionId });
          this.deliver({ type: "history", session_id: ownerSessionId, selection_id: this.selectionId, reason: "initial", messages: [] });
          this.deliver({ type: "queued_message_snapshot", session_id: ownerSessionId, selection_id: this.selectionId, messages: [] });
        }, 0);
      }

      send(value: string): void { outbound.push(JSON.parse(value)); }
      close(): void { this.readyState = SyntheticWebSocket.CLOSED; }
      deliver(value: unknown): void {
        this.onmessage?.(Object.assign(new Event("message"), { data: JSON.stringify(value) }));
      }
      disconnect(): void {
        this.readyState = SyntheticWebSocket.CLOSED;
        this.onclose?.(Object.assign(new Event("close"), { code: 1006, reason: "synthetic disconnect" }));
      }
    }

    Object.defineProperty(window, "WebSocket", { configurable: true, value: SyntheticWebSocket });
    Object.defineProperty(window, "__showSyntheticInterview", {
      configurable: true,
      value: () => sockets.at(-1)?.deliver({
        type: "interview_request",
        requestId: interviewRequestId,
        sessionId: ownerSessionId,
        createdAt: Date.now(),
        questions: [{
          id: "q1", label: "Synthetic", prompt: "Keep this form until cancellation is acknowledged?",
          options: [{ value: "yes", label: "Yes" }], allowOther: true,
        }],
      }),
    });
    Object.defineProperty(window, "__sendSyntheticCancelAck", {
      configurable: true,
      value: (ack: unknown) => sockets.at(-1)?.deliver(ack),
    });
    Object.defineProperty(window, "__sendSyntheticCancelAckOnSocket", {
      configurable: true,
      value: (index: number, ack: unknown) => sockets[index]?.deliver(ack),
    });
    Object.defineProperty(window, "__disconnectSyntheticChat", {
      configurable: true,
      value: () => sockets.at(-1)?.disconnect(),
    });
    Object.defineProperty(window, "__syntheticChatOutbound", { configurable: true, get: () => outbound });
  }, { ownerSessionId: sessionId, interviewRequestId: requestId });
}

test("interview form survives cancel send, mismatched/rejected ack, and disconnect until exact terminal ack", async ({ page }) => {
  await installSyntheticBackend(page);
  await page.goto("/");
  await page.getByText("Cancellation project", { exact: true }).click();
  await page.getByText("Cancellation session", { exact: true }).click();
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await page.evaluate(() => (window as unknown as { __showSyntheticInterview(): void }).__showSyntheticInterview());
  const form = page.getByTestId("interview-form");
  await expect(form).toBeVisible();
  await form.getByRole("button", { name: "Cancel", exact: true }).click();
  await expect(page.getByTestId("interview-cancellation-status")).toContainText("waiting for acknowledgement");
  await expect(form).toBeVisible();

  await page.evaluate(({ request }) => {
    (window as unknown as { __sendSyntheticCancelAck(value: unknown): void }).__sendSyntheticCancelAck({
      type: "interview_cancel_ack", requestId: `${request}-wrong`, sessionId: "synthetic-cancellation-session", status: "cancelled",
    });
  }, { request: requestId });
  await expect(page.getByTestId("interview-cancellation-status")).toContainText("waiting for acknowledgement");

  await page.evaluate(({ request }) => {
    (window as unknown as { __sendSyntheticCancelAck(value: unknown): void }).__sendSyntheticCancelAck({
      type: "interview_cancel_ack", requestId: request, sessionId: "synthetic-cancellation-session",
      status: "rejected", errorCode: "not_found", error: "Synthetic rejection",
    });
  }, { request: requestId });
  await expect(page.getByTestId("interview-cancellation-status")).toContainText("questionnaire remains available");
  await expect(form.getByRole("button", { name: "Retry cancellation" })).toBeEnabled();

  await form.getByRole("button", { name: "Retry cancellation" }).click();
  await expect(page.getByTestId("interview-cancellation-status")).toContainText("waiting for acknowledgement");
  await page.evaluate(() => (window as unknown as { __disconnectSyntheticChat(): void }).__disconnectSyntheticChat());
  await expect(page.getByTestId("interview-cancellation-status")).toContainText("Connection closed before cancellation acknowledgement");
  await expect(form).toBeVisible();

  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await form.getByRole("button", { name: "Retry cancellation" }).click();
  await page.evaluate(({ request }) => {
    (window as unknown as { __sendSyntheticCancelAckOnSocket(index: number, value: unknown): void })
      .__sendSyntheticCancelAckOnSocket(0, {
        type: "interview_cancel_ack", requestId: request, sessionId: "synthetic-cancellation-session", status: "cancelled",
      });
  }, { request: requestId });
  await expect(page.getByTestId("interview-cancellation-status")).toContainText("waiting for acknowledgement");
  await page.evaluate(({ request }) => {
    (window as unknown as { __sendSyntheticCancelAck(value: unknown): void }).__sendSyntheticCancelAck({
      type: "interview_cancel_ack", requestId: request, sessionId: "synthetic-cancellation-session", status: "cancelled",
    });
  }, { request: requestId });
  await expect(form).toHaveCount(0);

  const cancellationMessages = await page.evaluate(() => (
    (window as unknown as { __syntheticChatOutbound: Array<{ type?: unknown; requestId?: unknown }> }).__syntheticChatOutbound
      .filter((message) => message.type === "interview_cancel" && message.requestId === "synthetic-cancel-request")
  ));
  expect(cancellationMessages).toHaveLength(3);
});
