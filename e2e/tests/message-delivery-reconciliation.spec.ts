import { expect, test, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

// Exercise deliberately reordered delivery signals without a provider or any
// production transcript. Session registration uses the isolated E2E backend.
async function installDeliverySocket(page: Page, windowed: boolean): Promise<void> {
  await page.addInitScript(({ windowed }) => {
    type Handler<T> = ((event: T) => void) | null;
    let connections = 0;
    let sendCount = 0;
    class DeliverySocket {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      readyState = 0;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      sessionId: string;
      selectionId: string | null;
      sent: { client_message_id: string; content: string } | null = null;
      persisted: Array<{ type: string; id: string; message: { role: string; content: string } }> = [];
      initialWindow = true;
      persistSent(): void {
        const sent = this.sent!;
        const id = `durable-${sent.client_message_id}`;
        if (!this.persisted.some((message) => message.id === id)) this.persisted.push({
          type: "user", id, message: { role: "user", content: sent.content },
        });
        this.history(this.persisted);
      }
      constructor(url: string) {
        (window as any).deliveryConnections = ++connections;
        const parsed = new URL(url, location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        (window as any).deliveryWire = {
          historyThenAcceptance: () => {
            const sent = this.sent!;
            this.persistSent();
            this.emit({ type: "queued_message_snapshot", reason: "post_message",
              client_message_id: sent.client_message_id, message_status: "accepted", accepted_user_turn: true,
              messages: [], outcomes: [{ client_message_id: sent.client_message_id, status: "accepted", accepted_user_turn: true }] });
          },
          historyThenLiveAcceptance: () => {
            const sent = this.sent!;
            this.persistSent();
            this.emit({ type: "message_start", client_message_id: sent.client_message_id,
              message: { role: "user", content: sent.content } });
          },
          liveAcceptanceThenHistory: () => {
            const sent = this.sent!;
            this.emit({ type: "message_start", client_message_id: sent.client_message_id,
              message: { role: "user", content: sent.content } });
            this.persistSent();
          },
          restartWithoutOutcomes: () => {
            this.readyState = DeliverySocket.CLOSED;
            this.onclose?.(new CloseEvent("close"));
          },
        };
        setTimeout(() => { this.readyState = DeliverySocket.OPEN; this.onopen?.(new Event("open")); this.attach(); }, 0);
      }
      attach(): void {
        this.emit({ type: "session_loading" });
        this.emit({ type: "session_ready" });
        if (windowed) this.emit({ type: "transcript_protocol", protocol: "window-v1", intent: "latest" });
        this.history([]);
        this.emit({ type: "queued_message_snapshot", reason: "attach", messages: [], outcomes: [] });
        this.emit({ type: "agent_start" });
        this.emit({ type: "text_delta", delta: "Synthetic running turn." });
      }
      history(messages: unknown[]): void {
        if (!windowed) { this.emit({ type: "history", messages }); return; }
        this.emit({ type: "transcript_window", reason: this.initialWindow ? "initial" : "tail_reconcile", transcript_epoch: "delivery-epoch",
          branch_tip_id: messages.length ? this.persisted.at(-1)?.id ?? null : null,
          messages, before_cursor: null, after_cursor: null, has_older: false, has_newer: false,
          streaming_at_snapshot: true, compacting_at_snapshot: false,
          message_count: messages.length, payload_bytes: new TextEncoder().encode(JSON.stringify({ messages })).byteLength });
        this.initialWindow = false;
      }
      emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify({
          session_id: this.sessionId, selection_id: this.selectionId, ...payload,
        }) }));
      }
      send(raw: string): void {
        const message = JSON.parse(raw);
        if (message.type === "switch_session") {
          this.sessionId = message.session_id; this.selectionId = message.selection_id; this.attach();
        } else if (message.type === "message") {
          this.sent = message;
          (window as any).deliverySendCount = ++sendCount;
          this.emit({ type: "queued_message_ack", client_message_id: message.client_message_id,
            status: "queued", cancellable: true });
        }
      }
      close(): void { this.readyState = DeliverySocket.CLOSED; }
    }
    (window as any).WebSocket = DeliverySocket;
  }, { windowed });
}

for (const windowed of [false, true]) {
  test(`late acceptance after ${windowed ? "bounded window" : "legacy history"} leaves one user bubble`, async ({ page, request }) => {
    await installDeliverySocket(page, windowed);
    const session = await createE2eSession(request, `e2e late acceptance ${windowed}`);
    await openSessionInUi(page, session);
    await expect(page.getByTestId("chat-streaming")).toContainText("Synthetic running turn.");
    const text = "One submission with a late exact acceptance.";
    await page.getByTestId("chat-input").fill(text);
    await page.getByTestId("chat-send-button").click();
    await expect(page.getByTestId("chat-queued-user-message")).toContainText(text);
    await page.evaluate(() => (window as any).deliveryWire.historyThenAcceptance());
    await expect(page.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: text })).toHaveCount(1, { timeout: 3_000 });
    await expect(page.getByTestId("chat-queued-user-message")).toHaveCount(0);
  });
}

test("late id-less live acceptance after a bounded window leaves one user bubble", async ({ page, request }) => {
  await installDeliverySocket(page, true);
  const session = await createE2eSession(request, "e2e late live acceptance");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-streaming")).toContainText("Synthetic running turn.");
  const text = "Persisted before the id-less live echo arrives.";
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send-button").click();
  await page.evaluate(() => (window as any).deliveryWire.historyThenLiveAcceptance());
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: text })).toHaveCount(1, { timeout: 3_000 });
});

test("restart without queue outcomes keeps an unresolved submission visible", async ({ page, request }) => {
  await installDeliverySocket(page, true);
  const session = await createE2eSession(request, "e2e restart unresolved delivery");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-streaming")).toContainText("Synthetic running turn.");
  const text = "Do not silently hide this unresolved submission.";
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send-button").click();
  await expect(page.getByTestId("chat-queued-user-message")).toContainText(text);
  const connections = await page.evaluate(() => (window as any).deliveryConnections as number);
  await page.evaluate(() => (window as any).deliveryWire.restartWithoutOutcomes());
  // Wait for a new connected transport, not the old card before reconnect.
  await expect.poll(() => page.evaluate(() => (window as any).deliveryConnections)).toBeGreaterThan(connections);
  await expect(page.getByTestId("chat-streaming")).toContainText("Synthetic running turn.");
  await expect(page.getByTestId("chat-queued-user-message")).toContainText(text, { timeout: 3_000 });
  await expect(page.getByTestId("chat-queued-user-message")).toContainText(/unconfirmed|unknown/i);
  await expect.poll(() => page.evaluate((id) => localStorage.getItem(`wayang:chat-draft:${id}`), session.id)).toBe(text);
  expect(await page.evaluate(() => (window as any).deliverySendCount)).toBe(1);
  await page.getByRole("button", { name: "Restore draft", exact: true }).click();
  await expect(page.getByTestId("chat-input")).toHaveValue(text);
  await expect(page.getByTestId("chat-queued-user-message")).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).deliverySendCount)).toBe(1);
});

for (const windowed of [false, true]) {
  test(`identical intentional sends remain distinct with ${windowed ? "bounded" : "legacy"} history`, async ({ page, request }) => {
    await installDeliverySocket(page, windowed);
    const session = await createE2eSession(request, `e2e repeated late acceptance ${windowed}`);
    await openSessionInUi(page, session);
    await expect(page.getByTestId("chat-streaming")).toContainText("Synthetic running turn.");
    for (const count of [1, 2]) {
      await page.getByTestId("chat-input").fill("done");
      await page.getByTestId("chat-send-button").click();
      await page.evaluate(() => (window as any).deliveryWire.historyThenAcceptance());
      await expect(page.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: "done" })).toHaveCount(count);
    }
  });
}

test("live acceptance before a bounded window still replaces its temporary bubble", async ({ page, request }) => {
  await installDeliverySocket(page, true);
  const session = await createE2eSession(request, "e2e live then history");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-streaming")).toContainText("Synthetic running turn.");
  const text = "Live accepted before persistence is projected.";
  await page.getByTestId("chat-input").fill(text);
  await page.getByTestId("chat-send-button").click();
  await page.evaluate(() => (window as any).deliveryWire.liveAcceptanceThenHistory());
  await expect(page.locator('[data-testid="chat-message"][data-role="user"]').filter({ hasText: text })).toHaveCount(1);
  await expect(page.locator('[data-message-id^="durable-"]').filter({ hasText: text })).toHaveCount(1);
});
