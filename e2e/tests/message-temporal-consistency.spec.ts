import { expect, test } from "@playwright/test";
import {
  formatChatOrderReport,
  getChatOrderReport,
  installChatOrderObserver,
} from "./helpers/chatOrder";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

const firstMarker = "Browser ordering test marker A";
const secondMarker = "Second message during streaming marker B";

async function installDeterministicStreamingSocket(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler<T> = ((event: T) => void) | null;
    class DeterministicWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = DeterministicWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      private readonly sessionId: string;
      private readonly selectionId: string | null;
      private messageCount = 0;

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        window.setTimeout(() => {
          this.readyState = DeterministicWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: [] });
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as { type?: string; content?: string };
        if (message.type !== "message" || typeof message.content !== "string") return;
        this.messageCount++;
        const id = `deterministic-user-${this.messageCount}`;
        if (this.messageCount === 1) {
          this.emit({ type: "message_start", message: { id, role: "user", content: message.content } });
          this.emit({ type: "agent_start" });
          this.emit({ type: "text_delta", delta: "Deterministic assistant output before queued marker.\n" });
          return;
        }
        this.emit({ type: "message_start", message: { id, role: "user", content: message.content } });
        window.setTimeout(() => {
          this.emit({ type: "agent_end", messages: [], will_retry: false });
          this.emit({ type: "agent_settled" });
        }, 20);
      }

      close(): void {
        this.readyState = DeterministicWebSocket.CLOSED;
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }
    (window as unknown as { WebSocket: typeof DeterministicWebSocket }).WebSocket = DeterministicWebSocket;
  });
}

async function sendPrompt(page: import("@playwright/test").Page, prompt: string): Promise<void> {
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await input.fill(prompt);
  await page.getByTestId("chat-send-button").click();
}

test("keeps a mid-stream second user message after the active assistant output", async ({ page, request }, testInfo) => {
  const consoleLines: string[] = [];
  page.on("console", (msg) => {
    consoleLines.push(`[${msg.type()}] ${msg.text()}`);
  });

  let reportText = "chat order observer was not installed";

  try {
    await installDeterministicStreamingSocket(page);
    const session = await createE2eSession(request, "e2e temporal");

    await openSessionInUi(page, session);
    await expect(page.getByTestId("chat-input")).toBeEnabled({ timeout: 45_000 });

    await installChatOrderObserver(page, {
      firstUserText: firstMarker,
      secondUserText: secondMarker,
    });

    await sendPrompt(
      page,
      `${firstMarker}. Do not use tools. Write a long, slow, numbered response of at least 120 short lines. Start immediately and stream the numbered lines one per line.`,
    );

    await page.waitForFunction(() => {
      const streaming = document.querySelector('[data-testid="chat-streaming"]');
      const sendButton = document.querySelector('[data-testid="chat-send-button"]');
      return Boolean(streaming) || Boolean(sendButton?.textContent?.includes("Queue"));
    }, null, { timeout: 60_000 });

    await sendPrompt(
      page,
      `${secondMarker}: acknowledge this after the current response ordering point.`,
    );

    await page.waitForFunction((marker) => {
      return Array.from(document.querySelectorAll('[data-testid="chat-message"][data-role="user"]'))
        .some((node) => (node.textContent || "").includes(marker as string));
    }, secondMarker, { timeout: 150_000 });

    await page.waitForFunction(() => {
      return !document.querySelector('[data-testid="chat-streaming"]');
    }, null, { timeout: 150_000 });
    await expect(page.getByTestId("chat-send-button")).toHaveText("Send");

    const report = await getChatOrderReport(page);
    reportText = formatChatOrderReport(report);

    expect(report.sawFirstUser, reportText).toBe(true);
    expect(report.sawAssistant, reportText).toBe(true);
    expect(report.sawSecondUser, reportText).toBe(true);
    expect(report.violations, reportText).toEqual([]);
  } finally {
    try {
      const report = await getChatOrderReport(page);
      reportText = formatChatOrderReport(report);
    } catch {
      // Page may already be closed after an early startup failure.
    }

    await testInfo.attach("chat-order-report.txt", {
      body: reportText,
      contentType: "text/plain",
    });
    await testInfo.attach("browser-console.txt", {
      body: consoleLines.slice(-300).join("\n"),
      contentType: "text/plain",
    });
  }
});
