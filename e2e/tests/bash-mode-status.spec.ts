import { expect, test, type Page, type Route } from "@playwright/test";

const projectCwd = "/synthetic/host-status-project";
const projectId = "project-host-status";
const profileId = "profile-host-status";
const sessionId = "session-host-status";

type RuntimeMode = "host" | "sandboxed" | "sandboxed-unix" | "unavailable" | "wren_host";

function session() {
  const now = Date.now();
  return {
    id: sessionId,
    pi_session_file: null,
    title: "Synthetic host status",
    cwd: projectCwd,
    provider: "provider-a",
    model: "model-a",
    agent_profile_id: profileId,
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
  };
}

async function installSyntheticApi(page: Page): Promise<void> {
  await page.route((url) => url.pathname.startsWith("/api/"), async (route: Route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/auth/status") return route.fulfill({ json: { enabled: false, authenticated: true } });
    if (path === "/api/me") return route.fulfill({ json: { username: "synthetic-user", provider: "synthetic", version: "test" } });
    if (path === "/api/models") return route.fulfill({ json: { models: [], defaultModel: null } });
    if (path === "/api/key-mode") return route.fulfill({ json: { mode: "default" } });
    if (path === "/api/projects/discover" || path === "/api/fs/discover-projects") return route.fulfill({ json: [] });
    if (path === "/api/sessions") return route.fulfill({ json: [session()] });
    if (path === `/api/sessions/${sessionId}`) return route.fulfill({ json: session() });
    if (path === `/api/sessions/${sessionId}/slash-commands`) return route.fulfill({ json: { commands: [] } });
    if (path === "/api/sessions/events") return route.fulfill({ status: 204 });
    if (path === "/api/scheduled-agent-jobs") return route.fulfill({ json: { jobs: [] } });
    if (path === "/api/projects") return route.fulfill({ json: [{
      id: projectId,
      cwd: projectCwd,
      name: "Amber Workshop",
      description: null,
      color: null,
      default_agent_profile_id: profileId,
      default_provider: "provider-a",
      default_model: "model-a",
      access_policy: { privacy_mode: "standard", allowed_agent_profile_ids: [profileId] },
      capability_grants: [],
      authorization_revision: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    }] });
    if (path === "/api/agent-profiles") return route.fulfill({ json: [{
      id: profileId,
      name: "Amber Operator",
      description: null,
      enabled: true,
      resource_mode: "project_only",
      memory_access: "none",
      default_provider: "provider-a",
      default_model: "model-a",
      allowed_tools: null,
      allowed_extensions: null,
      capability_grants: [],
      authorization_revision: 1,
      created_at: Date.now(),
      updated_at: Date.now(),
    }] });
    return route.fulfill({ json: {} });
  });
}

async function installControlledRuntimeSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler<T> = ((event: T) => void) | null;
    const sockets: ControlledWebSocket[] = [];

    class ControlledWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = ControlledWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      sessionId: string;
      selectionId: string | null;

      constructor(url: string | URL) {
        const parsed = new URL(String(url), window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        sockets.push(this);
        window.setTimeout(() => {
          this.readyState = ControlledWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.sendSetup();
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as { type?: string; session_id?: string; selection_id?: string };
        if (message.type !== "switch_session" || typeof message.session_id !== "string") return;
        this.sessionId = message.session_id;
        this.selectionId = typeof message.selection_id === "string" ? message.selection_id : null;
        this.sendSetup();
      }

      close(): void { this.readyState = ControlledWebSocket.CLOSED; }

      disconnect(): void {
        this.readyState = ControlledWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close", { code: 1012, reason: "synthetic reconnect" }));
      }

      emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }

      private sendSetup(): void {
        this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "session_runtime_state", session_id: this.sessionId, selection_id: this.selectionId, bash_mode: "unavailable" });
        this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: [] });
      }
    }

    (window as any).__hostStatusSocketHarness = {
      sockets,
      current(): ControlledWebSocket {
        const socket = sockets[sockets.length - 1];
        if (!socket) throw new Error("No controlled WebSocket exists");
        return socket;
      },
    };
    Object.defineProperty(window, "WebSocket", { configurable: true, value: ControlledWebSocket });
  });
}

async function emitRuntimeState(page: Page, mode: RuntimeMode, selectionId?: string): Promise<void> {
  await page.evaluate(({ mode, selectionId }) => {
    const socket = (window as any).__hostStatusSocketHarness.current();
    socket.emit({
      type: "session_runtime_state",
      session_id: socket.sessionId,
      selection_id: selectionId ?? socket.selectionId,
      bash_mode: mode,
    });
  }, { mode, selectionId });
}

async function flushReact(page: Page): Promise<void> {
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
}

test("renders generic host authority and rejects legacy or stale runtime claims", async ({ page }) => {
  await installSyntheticApi(page);
  await installControlledRuntimeSocket(page);
  await page.goto(`/sessions/${sessionId}`);

  const status = page.getByTestId("bash-mode-status");
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await expect(status).toHaveAttribute("data-bash-mode", "unavailable");
  await expect(status).toContainText("Bash unavailable");

  await emitRuntimeState(page, "sandboxed");
  await expect(status).toHaveAttribute("data-bash-mode", "sandboxed");
  await expect(status).toContainText("Sandboxed bash");

  await emitRuntimeState(page, "sandboxed-unix");
  await expect(status).toHaveAttribute("data-bash-mode", "sandboxed-unix");
  await expect(status).toContainText("Sandboxed bash · Unix IPC");
  await expect(status).toHaveAttribute("title", /same-user authority/);

  // A legacy identity-specific value is not a host mode. It must fail closed
  // even when it arrives on the current authoritative selection.
  await emitRuntimeState(page, "wren_host");
  await expect(status).toHaveAttribute("data-bash-mode", "unavailable");
  await expect(status).not.toContainText("Host access");
  await expect(page.getByText(/wren/i)).toHaveCount(0);

  const staleSelectionId = await page.evaluate(() => `${(window as any).__hostStatusSocketHarness.current().selectionId}-stale`);
  await emitRuntimeState(page, "host", staleSelectionId);
  await flushReact(page);
  await expect(status).toHaveAttribute("data-bash-mode", "unavailable");

  await emitRuntimeState(page, "host");
  await expect(status).toHaveAttribute("data-bash-mode", "host");
  await expect(status).toContainText("Host access");
  await expect(status).toHaveAttribute("data-expanded", "false");
  await page.getByTestId("bash-mode-details-toggle").click();
  await expect(status).toHaveAttribute("data-expanded", "true");
  await expect(status).toContainText("Bash commands run as the Wayang OS user outside the filesystem sandbox");

  await page.evaluate(() => {
    const harness = (window as any).__hostStatusSocketHarness;
    harness.staleSocket = harness.current();
    harness.staleSocket.disconnect();
  });
  await expect(status).toHaveAttribute("data-bash-mode", "unavailable");
  await page.waitForFunction(() => {
    const harness = (window as any).__hostStatusSocketHarness;
    return harness.current() !== harness.staleSocket;
  });
  await emitRuntimeState(page, "host");
  await expect(status).toHaveAttribute("data-bash-mode", "host");

  await page.evaluate(() => {
    const harness = (window as any).__hostStatusSocketHarness;
    const current = harness.current();
    harness.staleSocket.emit({
      type: "session_runtime_state",
      session_id: current.sessionId,
      selection_id: current.selectionId,
      bash_mode: "sandboxed",
    });
  });
  await flushReact(page);
  await expect(status).toHaveAttribute("data-bash-mode", "host");
});
