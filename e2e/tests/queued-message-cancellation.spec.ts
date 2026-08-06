import { expect, test, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

async function installQueuedMessageSocket(
  page: Page,
  initialQueued: Array<{ client_message_id: string; content: string; attachment_names: string[] }> = [],
  deferFirstAgentStart = false,
): Promise<void> {
  await page.addInitScript(({ queuedSnapshot, deferFirstStart }) => {
    type Handler<T> = ((event: T) => void) | null;

    class QueuedMessageWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = QueuedMessageWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      private readonly sessionId: string;
      private readonly selectionId: string | null;
      private messageCount = 0;
      private interruptCount = 0;

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        (window as unknown as { queuedCancellationState: () => { interruptCount: number } }).queuedCancellationState = () => ({
          interruptCount: this.interruptCount,
        });
        (window as unknown as { startDeferredQueuedTurn: () => void }).startDeferredQueuedTurn = () => {
          this.emit({ type: "agent_start" });
          this.emit({ type: "text_delta", delta: "Synthetic deferred active response." });
        };
        window.setTimeout(() => {
          this.readyState = QueuedMessageWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: [] });
          this.emit({
            type: "queued_message_snapshot",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            messages: queuedSnapshot,
          });
          if (queuedSnapshot.length > 0) {
            this.emit({ type: "agent_start" });
            this.emit({ type: "text_delta", delta: "Synthetic reattached response remains active." });
          }
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as {
          type?: string;
          content?: string;
          client_message_id?: string;
        };
        if (message.type === "interrupt") {
          this.interruptCount++;
          return;
        }
        if (message.type === "cancel_queued_message" && message.client_message_id) {
          this.emit({
            type: "queued_message_cancel_ack",
            session_id: this.sessionId,
            client_message_id: message.client_message_id,
            status: "cancelled",
          });
          return;
        }
        if (message.type !== "message" || typeof message.content !== "string") return;

        this.messageCount++;
        if (this.messageCount === 1) {
          this.emit({ type: "message_start", message: { role: "user", content: message.content } });
          if (!deferFirstStart) {
            this.emit({ type: "agent_start" });
            this.emit({ type: "text_delta", delta: "Synthetic active response remains in progress." });
          }
          return;
        }
        if (message.client_message_id) {
          this.emit({
            type: "queued_message_ack",
            session_id: this.sessionId,
            client_message_id: message.client_message_id,
            status: "queued",
            cancellable: true,
          });
        }
      }

      close(): void {
        this.readyState = QueuedMessageWebSocket.CLOSED;
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }

    (window as unknown as { WebSocket: typeof QueuedMessageWebSocket }).WebSocket = QueuedMessageWebSocket;
  }, { queuedSnapshot: initialQueued, deferFirstStart: deferFirstAgentStart });
}

async function sendPrompt(page: Page, content: string): Promise<void> {
  await page.getByTestId("chat-input").fill(content);
  await page.getByTestId("chat-send-button").click();
}

test("migrates a rapid optimistic send into the cancellable queue when the backend is already streaming", async ({ page, request }) => {
  await installQueuedMessageSocket(page, [], true);
  const session = await createE2eSession(request, "e2e queued cancellation acknowledgement race");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Start before the browser receives agent_start.");
  await expect(page.getByTestId("chat-send-button")).toContainText("Send");
  await sendPrompt(page, "Backend queues this rapid second message.");

  const queued = page.getByTestId("chat-queued-user-message");
  await expect(queued).toHaveCount(1);
  await expect(queued).toContainText("Backend queues this rapid second message.");
  await expect(queued.getByTestId("chat-cancel-queued-message")).toBeEnabled();
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]')).not.toContainText("Backend queues this rapid second message.");

  await page.evaluate(() => (
    window as unknown as { startDeferredQueuedTurn: () => void }
  ).startDeferredQueuedTurn());
  await expect(page.getByTestId("chat-streaming")).toContainText("deferred active response");
  await queued.getByTestId("chat-cancel-queued-message").click();
  await expect(queued).toHaveCount(0);
});

test("restores cancellation controls from the backend queue snapshot after reattachment", async ({ page, request }) => {
  await installQueuedMessageSocket(page, [{
    client_message_id: "restored-queued-message",
    content: "Restored queued message after switching back.",
    attachment_names: ["restored-note.txt"],
  }]);
  const session = await createE2eSession(request, "e2e queued cancellation reattachment");
  await openSessionInUi(page, session);

  const queued = page.getByTestId("chat-queued-user-message");
  await expect(queued).toHaveCount(1);
  await expect(queued).toContainText("Restored queued message after switching back.");
  await expect(queued).toContainText("restored-note.txt");
  await expect(queued.getByTestId("chat-cancel-queued-message")).toBeEnabled();

  await queued.getByTestId("chat-cancel-queued-message").click();
  await expect(queued).toHaveCount(0);
  await expect(page.getByTestId("chat-streaming")).toContainText("reattached response remains active");
});

test("cancels one queued message without interrupting the active turn or removing its neighbor", async ({ page, request }) => {
  await installQueuedMessageSocket(page);
  const session = await createE2eSession(request, "e2e queued cancellation");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Start the synthetic active turn.");
  await expect(page.getByTestId("chat-streaming")).toContainText("remains in progress");
  await expect(page.getByTestId("chat-send-button")).toContainText("Queue");

  await sendPrompt(page, "Cancel only this queued message.");
  await sendPrompt(page, "Keep this neighboring queued message.");

  const queued = page.getByTestId("chat-queued-user-message");
  await expect(queued).toHaveCount(2);
  await expect(queued.nth(0).getByTestId("chat-cancel-queued-message")).toBeEnabled();
  await expect(queued.nth(1).getByTestId("chat-cancel-queued-message")).toBeEnabled();

  await queued.nth(0).getByTestId("chat-cancel-queued-message").click();

  await expect(queued).toHaveCount(1);
  await expect(queued.first()).toContainText("Keep this neighboring queued message.");
  await expect(queued.first()).not.toContainText("Cancel only this queued message.");
  await expect(page.getByTestId("chat-streaming")).toContainText("remains in progress");
  await expect(page.getByTestId("chat-send-button")).toContainText("Queue");
  await expect.poll(() => page.evaluate(() => (
    window as unknown as { queuedCancellationState: () => { interruptCount: number } }
  ).queuedCancellationState().interruptCount)).toBe(0);
});
