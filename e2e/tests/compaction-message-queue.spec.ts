import { expect, test, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

async function installCompactionQueueSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler<T> = ((event: T) => void) | null;
    type QueuedPrompt = { id: string; content: string };

    class CompactionQueueWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = CompactionQueueWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;

      private readonly sessionId: string;
      private readonly selectionId: string | null;
      private compacting = true;
      private readonly queued: QueuedPrompt[] = [];
      private nextTranscriptId = 0;

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");

        (window as unknown as { finishSyntheticCompaction: () => void }).finishSyntheticCompaction = () => {
          this.compacting = false;
          this.emit({
            type: "compaction_end",
            reason: "manual",
            succeeded: true,
            aborted: false,
            will_retry: false,
          });
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            reason: "compaction_end_reconciliation",
            streaming_at_snapshot: false,
            compacting_at_snapshot: false,
            messages: [],
          });
        };
        (window as unknown as { releaseNextSyntheticQueuedMessage: () => void }).releaseNextSyntheticQueuedMessage = () => {
          const next = this.queued.shift();
          if (!next) return;
          const transcriptId = `compaction-queued-user-${++this.nextTranscriptId}`;
          this.emit({
            type: "message_start",
            id: transcriptId,
            client_message_id: next.id,
            message: { id: transcriptId, role: "user", content: next.content },
          });
          this.emit({ type: "agent_start" });
          this.emit({ type: "agent_end", messages: [], will_retry: false });
          this.emit({ type: "agent_settled" });
        };

        window.setTimeout(() => {
          this.readyState = CompactionQueueWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            streaming_at_snapshot: false,
            compacting_at_snapshot: true,
            messages: [],
          });
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as {
          type?: string;
          content?: string;
          client_message_id?: string;
        };
        if (message.type !== "message" || typeof message.content !== "string" || typeof message.client_message_id !== "string") {
          return;
        }
        if (!this.compacting) return;
        this.queued.push({ id: message.client_message_id, content: message.content });
        this.emit({
          type: "queued_message_ack",
          session_id: this.sessionId,
          client_message_id: message.client_message_id,
          status: "queued",
          cancellable: true,
        });
      }

      close(): void {
        this.readyState = CompactionQueueWebSocket.CLOSED;
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }

    (window as unknown as { WebSocket: typeof CompactionQueueWebSocket }).WebSocket = CompactionQueueWebSocket;
  });
}

async function submit(page: Page, content: string): Promise<void> {
  const input = page.getByTestId("chat-input");
  await input.fill(content);
  await page.getByTestId("chat-send-button").click();
}

test("queues ordinary messages in order while manual compaction is active", async ({ page, request }) => {
  await installCompactionQueueSocket(page);
  const session = await createE2eSession(request, "e2e compaction message queue");
  await openSessionInUi(page, session);

  const input = page.getByTestId("chat-input");
  const send = page.getByTestId("chat-send-button");
  await expect(page.locator("section > header").first()).toContainText("compacting");
  await expect(input).toBeEnabled();

  await input.fill("First message after compaction.");
  await expect(send).toBeEnabled();
  await expect(send).toHaveText("Queue");
  await send.click();
  await submit(page, "Second message after compaction.");

  const queued = page.getByTestId("chat-queued-user-message");
  await expect(queued).toHaveCount(2);
  await expect(queued.nth(0)).toContainText("First message after compaction.");
  await expect(queued.nth(1)).toContainText("Second message after compaction.");
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]')).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as { finishSyntheticCompaction: () => void }).finishSyntheticCompaction();
  });
  await expect(page.locator("section > header").first()).not.toContainText("compacting");
  await expect(queued).toHaveCount(2);

  await page.evaluate(() => {
    (window as unknown as { releaseNextSyntheticQueuedMessage: () => void }).releaseNextSyntheticQueuedMessage();
  });
  await expect(queued).toHaveCount(1);
  await expect(queued.first()).toContainText("Second message after compaction.");
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]')).toContainText("First message after compaction.");

  await page.evaluate(() => {
    (window as unknown as { releaseNextSyntheticQueuedMessage: () => void }).releaseNextSyntheticQueuedMessage();
  });
  await expect(queued).toHaveCount(0);
  const userMessages = page.locator('[data-testid="chat-message"][data-role="user"]');
  await expect(userMessages).toHaveCount(2);
  await expect(userMessages.nth(0)).toContainText("First message after compaction.");
  await expect(userMessages.nth(1)).toContainText("Second message after compaction.");
});
