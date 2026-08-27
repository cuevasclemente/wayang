import { expect, test, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

async function installQueuedMessageSocket(
  page: Page,
  initialQueued: Array<{ client_message_id: string; content: string; attachment_names: string[] }> = [],
  deferFirstAgentStart = false,
  rejectQueuedSend = false,
  suppressQueuedAcknowledgement = false,
  suppressFirstEcho = false,
): Promise<void> {
  await page.addInitScript(({ queuedSnapshot, deferFirstStart, rejectQueued, suppressQueuedAck, suppressInitialEcho }) => {
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
      private sessionId: string;
      private selectionId: string | null;
      private messageCount = 0;
      private interruptCount = 0;
      private firstClientMessageId: string | null = null;
      private firstMessageContent: string | null = null;
      private pendingQueuedAcceptance: { clientMessageId: string; content: string } | null = null;

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        (window as unknown as { queuedCancellationState: () => { interruptCount: number } }).queuedCancellationState = () => ({
          interruptCount: this.interruptCount,
        });
        (window as unknown as { forceQueuedSocketClosing: () => void }).forceQueuedSocketClosing = () => {
          this.readyState = QueuedMessageWebSocket.CLOSING;
        };
        (window as unknown as { startDeferredQueuedTurn: () => void }).startDeferredQueuedTurn = () => {
          this.emit({ type: "agent_start" });
          this.emit({ type: "text_delta", delta: "Synthetic deferred active response." });
        };
        (window as unknown as { acknowledgeFirstQueuedSend: () => void }).acknowledgeFirstQueuedSend = () => {
          if (!this.firstClientMessageId) return;
          this.emit({
            type: "queued_message_ack",
            session_id: this.sessionId,
            client_message_id: this.firstClientMessageId,
            status: "accepted",
            cancellable: false,
          });
          this.firstClientMessageId = null;
        };
        (window as unknown as { acceptFirstSendWithHistory: () => void }).acceptFirstSendWithHistory = () => {
          if (!this.firstMessageContent) return;
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            messages: [{
              type: "user",
              id: "durable-first-user",
              message: { role: "user", content: this.firstMessageContent },
            }],
          });
          this.firstMessageContent = null;
        };
        (window as unknown as { acceptQueuedSendWithoutAck: () => void }).acceptQueuedSendWithoutAck = () => {
          if (!this.pendingQueuedAcceptance) return;
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            messages: [{
              type: "user",
              id: `durable-${this.pendingQueuedAcceptance.clientMessageId}`,
              message: {
                role: "user",
                content: this.pendingQueuedAcceptance.content,
              },
            }],
          });
          this.pendingQueuedAcceptance = null;
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
          session_id?: string;
          selection_id?: string;
        };
        if (message.type === "switch_session" && message.session_id) {
          this.sessionId = message.session_id;
          this.selectionId = message.selection_id ?? null;
          this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: [] });
          this.emit({
            type: "queued_message_snapshot",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            messages: [],
          });
          return;
        }
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
          this.firstClientMessageId = message.client_message_id ?? null;
          this.firstMessageContent = message.content;
          if (!suppressInitialEcho) {
            this.emit({ type: "message_start", message: { role: "user", content: message.content } });
          }
          if (!deferFirstStart) {
            this.emit({ type: "agent_start" });
            this.emit({ type: "text_delta", delta: "Synthetic active response remains in progress." });
          }
          return;
        }
        if (message.client_message_id) {
          if (suppressQueuedAck) {
            this.pendingQueuedAcceptance = {
              clientMessageId: message.client_message_id,
              content: message.content,
            };
            return;
          }
          const acknowledgement = {
            type: "queued_message_ack",
            session_id: this.sessionId,
            client_message_id: message.client_message_id,
            status: rejectQueued ? "rejected" : "queued",
            ...(rejectQueued ? {
              error_code: "synthetic_rejection",
              error: "Synthetic queued send rejection",
            } : { cancellable: true }),
          };
          if (rejectQueued) window.setTimeout(() => this.emit(acknowledgement), 0);
          else this.emit(acknowledgement);
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
  }, {
    queuedSnapshot: initialQueued,
    deferFirstStart: deferFirstAgentStart,
    rejectQueued: rejectQueuedSend,
    suppressQueuedAck: suppressQueuedAcknowledgement,
    suppressInitialEcho: suppressFirstEcho,
  });
}

async function installStaleSelectionSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler<T> = ((event: T) => void) | null;
    type PendingSend = { sessionId: string; clientMessageId: string };

    class StaleSelectionWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = StaleSelectionWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      private sessionId: string;
      private selectionId: string | null;
      private pendingSend: PendingSend | null = null;

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        window.setTimeout(() => {
          this.readyState = StaleSelectionWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.publishSelection();
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as {
          type?: string;
          session_id?: string;
          selection_id?: string;
          client_message_id?: string;
        };
        if (message.type === "message" && message.client_message_id) {
          this.pendingSend = { sessionId: this.sessionId, clientMessageId: message.client_message_id };
          return;
        }
        if (message.type !== "switch_session" || !message.session_id) return;

        const rejected = this.pendingSend;
        this.pendingSend = null;
        this.sessionId = message.session_id;
        this.selectionId = message.selection_id ?? null;
        this.publishSelection(rejected ? [{
          client_message_id: rejected.clientMessageId,
          content: "Synthetic queue entry owned by the newly selected session.",
          attachment_names: [],
        }] : []);
        if (rejected) {
          this.emit({
            type: "queued_message_ack",
            session_id: rejected.sessionId,
            client_message_id: rejected.clientMessageId,
            status: "rejected",
            error_code: "selection_changed",
            error: "Session action was not sent because the selection changed during runtime attachment",
          });
        }
      }

      close(): void {
        this.readyState = StaleSelectionWebSocket.CLOSED;
      }

      private publishSelection(
        queuedMessages: Array<{ client_message_id: string; content: string; attachment_names: string[] }> = [],
      ): void {
        this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: [] });
        this.emit({
          type: "queued_message_snapshot",
          session_id: this.sessionId,
          selection_id: this.selectionId,
          messages: queuedMessages,
        });
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }

    (window as unknown as { WebSocket: typeof StaleSelectionWebSocket }).WebSocket = StaleSelectionWebSocket;
  });
}

async function installDelayedFileReader(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const originalReadAsDataUrl = FileReader.prototype.readAsDataURL;
    FileReader.prototype.readAsDataURL = function delayedReadAsDataURL(blob: Blob): void {
      window.setTimeout(() => originalReadAsDataUrl.call(this, blob), 150);
    };
  });
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

test("keeps an asynchronously prepared attachment bound to its source session", async ({ page, request }) => {
  await installStaleSelectionSocket(page);
  await installDelayedFileReader(page);
  const first = await createE2eSession(request, "e2e delayed attachment first session");
  const second = await createE2eSession(request, "e2e delayed attachment second session");
  await openSessionInUi(page, first);

  await page.locator('input[type="file"]').setInputFiles({
    name: "source-session-only.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic delayed attachment bytes"),
  });
  await page.getByText(second.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
  await page.waitForTimeout(250);
  await expect(page.getByText("source-session-only.txt", { exact: true })).not.toBeVisible();

  await page.getByText(first.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${first.id}$`));
  await expect(page.getByText("source-session-only.txt", { exact: true })).toBeVisible();
});

test("does not resurrect a sent draft after switching away before acknowledgement", async ({ page, request }) => {
  await installQueuedMessageSocket(page);
  const first = await createE2eSession(request, "e2e sent draft first session");
  const second = await createE2eSession(request, "e2e sent draft second session");
  await openSessionInUi(page, first);

  const sentText = "This successfully sent draft must not return to the composer.";
  await page.getByTestId("chat-input").fill(sentText);
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-input")).toHaveValue("");

  await page.getByText(second.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
  await page.getByText(first.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${first.id}$`));
  await expect(page.getByTestId("chat-input")).toHaveValue("");
  await expect.poll(() => page.evaluate((sessionId) => (
    window.localStorage.getItem(`wayang:chat-draft:${sessionId}`)
  ), first.id)).toBe(sentText);
});

test("reload conservatively restores a sent draft whose delivery stayed uncertain", async ({ page, request }) => {
  await installQueuedMessageSocket(page, [], false, false, false, true);
  const session = await createE2eSession(request, "e2e uncertain sent draft");
  await openSessionInUi(page, session);

  const uncertainText = "Retain this recovery copy because no ACK or authoritative echo arrived.";
  await page.getByTestId("chat-input").fill(uncertainText);
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-input")).toHaveValue("");
  await page.reload();
  await expect(page.getByTestId("chat-input")).toBeEnabled({ timeout: 30_000 });
  await expect(page.getByTestId("chat-input")).toHaveValue(uncertainText);
});

test("content-only legacy history keeps unacknowledged recovery durable but hidden", async ({ page, request }) => {
  await installQueuedMessageSocket(page, [], false, false, false, true);
  const first = await createE2eSession(request, "e2e legacy history first session");
  const second = await createE2eSession(request, "e2e legacy history second session");
  await openSessionInUi(page, first);

  const acceptedText = "Legacy content-only history cannot prove which browser submission was accepted.";
  await page.getByTestId("chat-input").fill(acceptedText);
  await page.getByTestId("chat-send-button").click();
  await page.evaluate(() => (
    window as unknown as { acceptFirstSendWithHistory: () => void }
  ).acceptFirstSendWithHistory());
  await expect.poll(() => page.evaluate((sessionId) => (
    window.localStorage.getItem(`wayang:chat-draft:${sessionId}`)
  ), first.id)).toBe(acceptedText);

  await page.getByText(second.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
  await page.getByText(first.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${first.id}$`));
  await expect(page.getByTestId("chat-input")).toHaveValue("");
});

test("a delayed acknowledgement does not clear a newer identical draft", async ({ page, request }) => {
  await installQueuedMessageSocket(page);
  const first = await createE2eSession(request, "e2e delayed ack first session");
  const second = await createE2eSession(request, "e2e delayed ack second session");
  await openSessionInUi(page, first);

  const repeatedText = "An identical new unsent draft must survive the old acknowledgement.";
  await page.getByTestId("chat-input").fill(repeatedText);
  await page.getByTestId("chat-send-button").click();
  await page.getByTestId("chat-input").fill(repeatedText);
  await page.evaluate(() => (
    window as unknown as { acknowledgeFirstQueuedSend: () => void }
  ).acknowledgeFirstQueuedSend());

  await page.getByText(second.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
  await page.getByText(first.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${first.id}$`));
  await expect(page.getByTestId("chat-input")).toHaveValue(repeatedText);
  await expect.poll(() => page.evaluate((sessionId) => (
    window.localStorage.getItem(`wayang:chat-draft:${sessionId}`)
  ), first.id)).toBe(repeatedText);
});

test("content-only queued history keeps ACK-loss recovery durable but hidden", async ({ page, request }) => {
  await installQueuedMessageSocket(page, [], false, false, true);
  const first = await createE2eSession(request, "e2e ack loss first session");
  const second = await createE2eSession(request, "e2e ack loss second session");
  await openSessionInUi(page, first);

  await sendPrompt(page, "Start the synthetic active turn before ACK loss.");
  await expect(page.getByTestId("chat-streaming")).toContainText("remains in progress");
  const queuedText = "Content-only queued history cannot retire uncertain browser recovery.";
  await page.getByTestId("chat-input").fill(queuedText);
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-queued-user-message")).toContainText(queuedText);

  await page.evaluate(() => (
    window as unknown as { acceptQueuedSendWithoutAck: () => void }
  ).acceptQueuedSendWithoutAck());
  await expect(page.getByTestId("chat-queued-user-message")).toHaveCount(0);
  await expect.poll(() => page.evaluate((sessionId) => (
    window.localStorage.getItem(`wayang:chat-draft:${sessionId}`)
  ), first.id)).toBe(queuedText);

  await page.getByText(second.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
  await page.getByText(first.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${first.id}$`));
  await expect(page.getByTestId("chat-input")).toHaveValue("");
});

test("restores text and attachments when a send is rejected after switching sessions", async ({ page, request }) => {
  await installStaleSelectionSocket(page);
  const first = await createE2eSession(request, "e2e stale send first session");
  const second = await createE2eSession(request, "e2e stale send second session");
  await openSessionInUi(page, first);

  const rejectedText = "Restore this draft after the selection changes.";
  await page.getByTestId("chat-input").fill(rejectedText);
  await page.locator('input[type="file"]').setInputFiles({
    name: "stale-selection-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic attachment bytes"),
  });
  await expect(page.getByText("stale-selection-note.txt", { exact: true })).toBeVisible();
  await page.getByTestId("chat-send-button").click();

  await page.getByText(second.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
  const secondSessionQueue = page.getByTestId("chat-queued-user-message");
  await expect(secondSessionQueue).toContainText("Synthetic queue entry owned by the newly selected session.");
  await expect(secondSessionQueue).not.toContainText(rejectedText);
  await expect(secondSessionQueue).not.toContainText("stale-selection-note.txt");
  await expect(page.getByTestId("chat-input")).toHaveValue("");
  await expect(page.getByText("stale-selection-note.txt", { exact: true })).not.toBeVisible();
  await page.getByText(first.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${first.id}$`));

  await expect(page.getByTestId("chat-input")).toHaveValue(rejectedText);
  await expect(page.getByText("stale-selection-note.txt", { exact: true })).toBeVisible();
});

test("removes a rejected queue item after restoring its text and attachment", async ({ page, request }) => {
  await installQueuedMessageSocket(page, [], false, true);
  const session = await createE2eSession(request, "e2e rejected queued attachment");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Start the synthetic turn before queue rejection.");
  await expect(page.getByTestId("chat-streaming")).toContainText("remains in progress");
  const rejectedText = "Restore this rejected queued draft exactly once.";
  await page.getByTestId("chat-input").fill(rejectedText);
  await page.locator('input[type="file"]').setInputFiles({
    name: "rejected-queue-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic rejected queue attachment"),
  });
  await page.getByTestId("chat-send-button").click();

  await expect(page.getByTestId("chat-queued-user-message")).toHaveCount(0);
  await expect(page.getByTestId("chat-input")).toHaveValue(rejectedText);
  await expect(page.getByText("rejected-queue-note.txt", { exact: true })).toBeVisible();
});

test("keeps the composer intact when the socket closes before send", async ({ page, request }) => {
  await installQueuedMessageSocket(page);
  const session = await createE2eSession(request, "e2e closing socket send");
  await openSessionInUi(page, session);

  const unsentText = "Keep this unsent draft during the closing-socket race.";
  await page.getByTestId("chat-input").fill(unsentText);
  await page.locator('input[type="file"]').setInputFiles({
    name: "unsent-closing-socket.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic unsent attachment"),
  });
  await expect(page.getByText("unsent-closing-socket.txt", { exact: true })).toBeVisible();
  await page.evaluate(() => (
    window as unknown as { forceQueuedSocketClosing: () => void }
  ).forceQueuedSocketClosing());
  await page.getByTestId("chat-send-button").click();

  await expect(page.getByTestId("chat-input")).toHaveValue(unsentText);
  await expect(page.getByText("unsent-closing-socket.txt", { exact: true })).toBeVisible();
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]')).toHaveCount(0);
});

test("failed interrupt send leaves queued recovery state unconsumed", async ({ page, request }) => {
  await installQueuedMessageSocket(page);
  const session = await createE2eSession(request, "e2e failed interrupt send");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Start active output before the failed interrupt.");
  await expect(page.getByTestId("chat-streaming")).toContainText("remains in progress");
  const queuedText = "Keep this queued draft until interrupt is actually sent.";
  await page.getByTestId("chat-input").fill(queuedText);
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-queued-user-message")).toContainText(queuedText);

  await page.evaluate(() => (
    window as unknown as { forceQueuedSocketClosing: () => void }
  ).forceQueuedSocketClosing());
  await page.getByTestId("chat-composer-interrupt-button").click();
  await expect(page.getByTestId("chat-queued-user-message")).toContainText(queuedText);
  await expect(page.getByTestId("chat-input")).toHaveValue("");
});

test("keeps interrupted queued attachments in the source-session draft across switches", async ({ page, request }) => {
  await installQueuedMessageSocket(page);
  const first = await createE2eSession(request, "e2e interrupted attachment first session");
  const second = await createE2eSession(request, "e2e interrupted attachment second session");
  await openSessionInUi(page, first);

  await sendPrompt(page, "Start the synthetic turn before interruption.");
  await expect(page.getByTestId("chat-streaming")).toContainText("remains in progress");
  const restoredText = "Restore this queued attachment on interrupt.";
  await page.getByTestId("chat-input").fill(restoredText);
  await page.locator('input[type="file"]').setInputFiles({
    name: "interrupted-queue-note.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("synthetic interrupted queue attachment"),
  });
  await expect(page.getByText("interrupted-queue-note.txt", { exact: true })).toBeVisible();
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-queued-user-message")).toHaveCount(1);

  await page.getByTestId("chat-composer-interrupt-button").click();
  await expect(page.getByTestId("chat-input")).toHaveValue(restoredText);
  await expect(page.getByText("interrupted-queue-note.txt", { exact: true })).toBeVisible();

  await page.getByText(second.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${second.id}$`));
  await expect(page.getByText("interrupted-queue-note.txt", { exact: true })).not.toBeVisible();
  await page.getByText(first.title, { exact: true }).click();
  await expect(page).toHaveURL(new RegExp(`/sessions/${first.id}$`));
  await expect(page.getByTestId("chat-input")).toHaveValue(restoredText);
  await expect(page.getByText("interrupted-queue-note.txt", { exact: true })).toBeVisible();
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
