import { expect, test, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

/**
 * Installs a synthetic socket with a tall transcript and a tall queued-message
 * snapshot so the mobile layout invariants can be asserted without a live pi
 * runtime. The active turn stays running so the composer exposes Interrupt and
 * queued messages remain visible.
 */
async function installMobileLayoutSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler<T> = ((event: T) => void) | null;

    const history: Array<Record<string, unknown>> = [];
    for (let index = 0; index < 8; index++) {
      history.push({
        type: "user",
        id: `mobile-user-${index}`,
        message: { role: "user", content: `Synthetic user turn ${index} `.repeat(6) },
      });
      history.push({
        type: "assistant",
        id: `mobile-assistant-${index}`,
        message: { role: "assistant", content: `Synthetic assistant reply ${index} `.repeat(10) },
      });
    }
    const queuedSnapshot = Array.from({ length: 8 }, (_, index) => ({
      client_message_id: `mobile-queued-${index}`,
      content: `Queued message ${index} that must never squeeze the transcript to zero or hide the composer.`,
      attachment_names: [`synthetic-${index}.pdf`],
    }));

    class MobileLayoutWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;

      readyState = MobileLayoutWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      private sessionId: string;
      private selectionId: string | null;

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        window.setTimeout(() => {
          this.readyState = MobileLayoutWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: history });
          this.emit({
            type: "queued_message_snapshot",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            messages: queuedSnapshot,
          });
          this.emit({ type: "agent_start" });
          this.emit({ type: "text_delta", delta: "Synthetic active response remains in progress." });
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as {
          type?: string;
          session_id?: string;
          selection_id?: string;
          client_message_id?: string;
        };
        if (message.type === "switch_session" && message.session_id) {
          this.sessionId = message.session_id;
          this.selectionId = message.selection_id ?? null;
          this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: history });
          this.emit({
            type: "queued_message_snapshot",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            messages: queuedSnapshot,
          });
          this.emit({ type: "agent_start" });
          return;
        }
        if (message.type === "interrupt") return;
        if (message.type === "cancel_queued_message" && message.client_message_id) {
          this.emit({
            type: "queued_message_cancel_ack",
            session_id: this.sessionId,
            client_message_id: message.client_message_id,
            status: "cancelled",
          });
        }
      }

      close(): void {
        this.readyState = MobileLayoutWebSocket.CLOSED;
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }

    (window as unknown as { WebSocket: typeof MobileLayoutWebSocket }).WebSocket = MobileLayoutWebSocket;
  });
}

test.describe("mobile layout", () => {
  test.use({ viewport: { width: 412, height: 915 } });

  test("keeps header controls reachable and uses the composer interrupt on phones", async ({ page, request }) => {
    await installMobileLayoutSocket(page);
    const session = await createE2eSession(request, "e2e mobile header");
    await openSessionInUi(page, session);

    const toggle = page.getByTestId("chat-mobile-controls-toggle");
    await expect(toggle).toBeVisible();
    await expect(page.getByTestId("chat-mobile-controls-menu")).toHaveCount(0);

    // The desktop-only header interrupt is gone; the composer interrupt remains.
    await expect(page.getByTestId("chat-interrupt-button")).toHaveCount(0);
    await expect(page.getByTestId("chat-composer-interrupt-button")).toBeVisible();

    await toggle.click();
    const menu = page.getByTestId("chat-mobile-controls-menu");
    await expect(menu).toBeVisible();
    await expect(menu.getByTestId("chat-model-picker-toggle")).toBeVisible();
    await expect(menu.getByTestId("transcript-event-inspector-button")).toBeVisible();

    // Every control stays inside the viewport rather than overflowing off-screen.
    const box = await toggle.boundingBox();
    expect(box).not.toBeNull();
    expect((box?.x ?? 0) + (box?.width ?? 0)).toBeLessThanOrEqual(413);
  });

  test("bounds the queued dock so the transcript and composer stay usable", async ({ page, request }) => {
    await installMobileLayoutSocket(page);
    const session = await createE2eSession(request, "e2e mobile queued dock");
    await openSessionInUi(page, session);

    const queued = page.getByTestId("chat-queued-user-message");
    await expect(queued).toHaveCount(8);

    // The transcript must still occupy real vertical space.
    const listBox = await page.getByTestId("chat-message-list").boundingBox();
    expect(listBox).not.toBeNull();
    expect(listBox?.height ?? 0).toBeGreaterThan(80);

    // The composer must be inside the viewport, not pushed under the tab bar.
    const inputBox = await page.getByTestId("chat-input").boundingBox();
    expect(inputBox).not.toBeNull();
    expect((inputBox?.y ?? 0) + (inputBox?.height ?? 0)).toBeLessThanOrEqual(915);

    // The queued list is capped and collapsible.
    const dockBox = await page.getByTestId("chat-interaction-dock").boundingBox();
    expect(dockBox?.height ?? 0).toBeLessThan(915 * 0.65);

    await page.getByTestId("chat-queued-toggle").click();
    await expect(queued).toHaveCount(0);
  });
});

test.describe("tablet inner display", () => {
  test.use({ viewport: { width: 760, height: 900 } });

  test("keeps a single column with a reachable composer", async ({ page, request }) => {
    await installMobileLayoutSocket(page);
    const session = await createE2eSession(request, "e2e fold inner layout");
    await openSessionInUi(page, session);

    await expect(page.getByTestId("chat-mobile-controls-toggle")).toBeVisible();
    const inputBox = await page.getByTestId("chat-input").boundingBox();
    expect(inputBox).not.toBeNull();
    expect((inputBox?.y ?? 0) + (inputBox?.height ?? 0)).toBeLessThanOrEqual(900);

    const listBox = await page.getByTestId("chat-message-list").boundingBox();
    expect(listBox?.height ?? 0).toBeGreaterThan(80);
  });
});
