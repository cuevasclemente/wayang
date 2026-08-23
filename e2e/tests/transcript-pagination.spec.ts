import { expect, test, type APIRequestContext, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";
import { createSyntheticCorpus, type SyntheticSessionFixture } from "./helpers/syntheticSessions";

async function importFixture(request: APIRequestContext, fixture: SyntheticSessionFixture): Promise<void> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const imported = await request.post("/api/sessions/import");
    expect(imported.ok(), await imported.text()).toBe(true);
    const sessions = await request.get("/api/sessions");
    expect(sessions.ok(), await sessions.text()).toBe(true);
    const rows = await sessions.json() as Array<{ id: string }>;
    if (rows.some((row) => row.id === fixture.id)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`synthetic fixture ${fixture.id} was not imported`);
}

async function openFixture(page: Page, fixture: SyntheticSessionFixture): Promise<void> {
  await page.goto("/");
  await page.locator(`div[title="${fixture.cwd}"]`).first().click();
  await page.getByText(fixture.title, { exact: true }).click();
  const transcript = page.getByTestId("chat-message-list");
  await expect(transcript).toHaveAttribute("data-transcript-mode", "window-v1", { timeout: 30_000 });
  await expect(transcript).toHaveAttribute("data-transcript-state", "ready", { timeout: 30_000 });
}

async function pollSearch(
  request: APIRequestContext,
  query: string,
  sessionId: string,
): Promise<void> {
  const reindex = await request.post("/api/sessions/search/reindex", { data: { session_id: sessionId } });
  expect(reindex.ok(), await reindex.text()).toBe(true);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const response = await request.get(`/api/sessions/search?q=${encodeURIComponent(query)}`);
    if (response.ok()) {
      const body = await response.json() as { results?: Array<{ session_id: string }> };
      if (body.results?.some((result) => result.session_id === sessionId)) return;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`search did not return ${sessionId}`);
}

async function eventTop(page: Page, eventId: string): Promise<number> {
  return page.locator(`[data-message-id="${eventId}"]`).evaluate((element) => {
    const container = element.closest<HTMLElement>('[data-testid="chat-message-list"]');
    if (!container) throw new Error("chat message list not found");
    return element.getBoundingClientRect().top - container.getBoundingClientRect().top;
  });
}

async function installActiveWindowSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler<T> = ((event: T) => void) | null;
    class ActiveWindowWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = ActiveWindowWebSocket.CONNECTING;
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
          this.readyState = ActiveWindowWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emitWindow();
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as { type?: string; session_id?: string; selection_id?: string };
        if (message.type !== "switch_session" || !message.session_id) return;
        this.sessionId = message.session_id;
        this.selectionId = message.selection_id ?? null;
        this.emitWindow();
      }

      close(): void {
        this.readyState = ActiveWindowWebSocket.CLOSED;
      }

      private emitWindow(): void {
        this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "transcript_protocol", session_id: this.sessionId, selection_id: this.selectionId, protocol: "window-v1", intent: "latest" });
        const messages = [{
          type: "user",
          id: "persisted-user",
          parentId: null,
          message: { role: "user", content: "Persisted active-session prompt." },
        }];
        this.emit({
          type: "transcript_window",
          session_id: this.sessionId,
          selection_id: this.selectionId,
          reason: "initial",
          transcript_epoch: "active-stream-epoch",
          branch_tip_id: "persisted-user",
          messages,
          streaming_message: {
            type: "assistant",
            message: { role: "assistant", content: [{ type: "text", text: "Frozen partial assistant response." }] },
          },
          before_cursor: null,
          after_cursor: null,
          has_older: false,
          has_newer: false,
          streaming_at_snapshot: true,
          compacting_at_snapshot: false,
          message_count: 1,
          payload_bytes: JSON.stringify(messages).length,
        });
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }
    (window as unknown as { WebSocket: typeof ActiveWindowWebSocket }).WebSocket = ActiveWindowWebSocket;
  });
}

async function installTerminalCursorSocket(page: Page): Promise<void> {
  await page.addInitScript(() => {
    type Handler<T> = ((event: T) => void) | null;
    class TerminalCursorWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = TerminalCursorWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      private sessionId: string;
      private selectionId: string | null;
      private generation = 0;

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        window.setTimeout(() => {
          this.readyState = TerminalCursorWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emitWindow(true);
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as {
          type?: string;
          request_id?: string;
          direction?: "before" | "after";
          session_id?: string;
          selection_id?: string;
        };
        if (message.type === "transcript_page_request" && message.request_id && message.direction) {
          this.emit({
            type: "transcript_page_error",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            request_id: message.request_id,
            direction: message.direction,
            code: "expired_cursor",
            error: "Reopen the bounded transcript window.",
          });
          return;
        }
        if (message.type === "switch_session" && message.session_id) {
          this.sessionId = message.session_id;
          this.selectionId = message.selection_id ?? null;
          this.generation++;
          (window as Window & { __terminalCursorSwitches?: number }).__terminalCursorSwitches = this.generation;
          this.emitWindow(false);
        }
      }

      close(): void {
        this.readyState = TerminalCursorWebSocket.CLOSED;
      }

      private emitWindow(hasOlder: boolean): void {
        this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "transcript_protocol", session_id: this.sessionId, selection_id: this.selectionId, protocol: "window-v1", intent: "latest" });
        const id = hasOlder ? "stale-window-message" : "fresh-window-message";
        const messages = [{ type: "user", id, parentId: null, message: { role: "user", content: id } }];
        this.emit({
          type: "transcript_window",
          session_id: this.sessionId,
          selection_id: this.selectionId,
          reason: "initial",
          transcript_epoch: hasOlder ? "stale-epoch" : "fresh-epoch",
          branch_tip_id: id,
          messages,
          before_cursor: hasOlder ? "expired-before-cursor" : null,
          after_cursor: null,
          has_older: hasOlder,
          has_newer: false,
          message_count: 1,
          payload_bytes: JSON.stringify(messages).length,
        });
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }
    (window as unknown as { WebSocket: typeof TerminalCursorWebSocket }).WebSocket = TerminalCursorWebSocket;
  });
}

async function scrollToTopAndCapture(page: Page): Promise<{ eventId: string; top: number }> {
  return page.getByTestId("chat-message-list").evaluate((container) => {
    container.scrollTop = 0;
    const containerRect = container.getBoundingClientRect();
    const anchors = container.querySelectorAll<HTMLElement>("[data-message-id]");
    for (const anchor of anchors) {
      const eventId = anchor.dataset.messageId;
      const rect = anchor.getBoundingClientRect();
      if (eventId && rect.top >= containerRect.top - 1 && rect.bottom <= containerRect.bottom + 1) {
        return { eventId, top: rect.top - containerRect.top };
      }
    }
    throw new Error("no fully visible transcript event");
  });
}

test("latest opens bounded and older pages preserve the visible anchor", async ({ page, request }) => {
  const fixture = createSyntheticCorpus({
    sessionCount: 1,
    messagesPerSession: 450,
    projectCount: 1,
    prefix: `pagination-tail-${Date.now()}`,
  })[0]!;
  await importFixture(request, fixture);
  await openFixture(page, fixture);

  const anchors = page.locator("[data-message-id]");
  await expect(anchors).toHaveCount(200);
  await expect(page.locator(`[data-message-id="${fixture.id}-message-449"]`)).toBeAttached();
  await expect(page.getByTestId("transcript-gap-before")).toBeVisible();

  const retained = await scrollToTopAndCapture(page);
  await expect(anchors).toHaveCount(400);
  await expect.poll(async () => Math.abs((await eventTop(page, retained.eventId)) - retained.top)).toBeLessThanOrEqual(2);

  await scrollToTopAndCapture(page);
  await expect(anchors).toHaveCount(450);
  await expect(page.getByTestId("transcript-gap-before")).toHaveCount(0);
});

test("search opens around the exact match and can jump latest and back", async ({ page, request }) => {
  const marker = `quartz-anchor-${Date.now()}`;
  const fixture = createSyntheticCorpus({
    sessionCount: 1,
    messagesPerSession: 450,
    projectCount: 1,
    prefix: `pagination-search-${Date.now()}`,
    messageText: ({ messageIndex, role }) => messageIndex === 20
      ? `Exact ${marker} historical search target.`
      : `Public synthetic ${role} message ${messageIndex}.`,
  })[0]!;
  await importFixture(request, fixture);
  await pollSearch(request, marker, fixture.id);

  await page.goto("/");
  await page.getByTestId("session-search-input").fill(marker);
  const result = page.getByTestId("session-search-result").filter({ hasText: fixture.title }).first();
  await expect(result).toBeVisible({ timeout: 20_000 });
  await result.click();

  const transcript = page.getByTestId("chat-message-list");
  await expect(transcript).toHaveAttribute("data-transcript-mode", "window-v1", { timeout: 30_000 });
  const target = page.locator(`[data-message-id="${fixture.id}-message-20"]`);
  await expect(target).toBeInViewport({ timeout: 30_000 });
  expect(await page.locator("[data-message-id]").count()).toBeLessThanOrEqual(200);
  await expect(page.getByTestId("transcript-gap-after")).toBeVisible();

  await page.getByTestId("transcript-jump-latest").click();
  await expect(page.locator(`[data-message-id="${fixture.id}-message-449"]`)).toBeAttached({ timeout: 30_000 });
  await expect(page.getByTestId("transcript-back-to-match")).toBeVisible();

  await page.getByTestId("transcript-back-to-match").click();
  await expect(target).toBeInViewport({ timeout: 30_000 });
});

test("an active session accepts a separate ID-less streaming snapshot", async ({ page, request }) => {
  await installActiveWindowSocket(page);
  const session = await createE2eSession(request, "pagination active stream");
  await openSessionInUi(page, session);

  const transcript = page.getByTestId("chat-message-list");
  await expect(transcript).toHaveAttribute("data-transcript-mode", "window-v1", { timeout: 30_000 });
  await expect(transcript).toHaveAttribute("data-transcript-state", "ready");
  await expect(transcript.getByText("Persisted active-session prompt.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("chat-streaming").getByText("Frozen partial assistant response.", { exact: true })).toBeVisible();
  await expect(page.getByTestId("transcript-window-error")).toHaveCount(0);
});

test("a terminal cursor error performs one fresh bounded reopen", async ({ page, request }) => {
  await installTerminalCursorSocket(page);
  const session = await createE2eSession(request, "pagination cursor recovery");
  await openSessionInUi(page, session);

  await expect(page.getByText("stale-window-message", { exact: true })).toBeVisible();
  await page.getByTestId("transcript-gap-before").getByRole("button", { name: "Load older" }).click();
  await expect(page.getByText("fresh-window-message", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText("stale-window-message", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as Window & { __terminalCursorSwitches?: number }).__terminalCursorSwitches ?? 0)).toBe(1);
  await expect(page.getByTestId("transcript-window-error")).toHaveCount(0);
});

test("an unnegotiated legacy socket still receives complete history", async ({ page, request }) => {
  const fixture = createSyntheticCorpus({
    sessionCount: 1,
    messagesPerSession: 450,
    projectCount: 1,
    prefix: `pagination-legacy-${Date.now()}`,
  })[0]!;
  await importFixture(request, fixture);
  await page.goto("/");

  const historyCount = await page.evaluate(async (sessionId) => {
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/ws/chat?session_id=${encodeURIComponent(sessionId)}`);
    return await new Promise<number>((resolve, reject) => {
      const timeout = window.setTimeout(() => {
        socket.close();
        reject(new Error("legacy history timed out"));
      }, 30_000);
      socket.onmessage = (event) => {
        const message = JSON.parse(String(event.data)) as { type?: string; messages?: unknown[] };
        if (message.type !== "history") return;
        window.clearTimeout(timeout);
        socket.close();
        resolve(Array.isArray(message.messages) ? message.messages.length : -1);
      };
      socket.onerror = () => {
        window.clearTimeout(timeout);
        reject(new Error("legacy socket failed"));
      };
    });
  }, fixture.id);

  expect(historyCount).toBe(fixture.messageCount);
});
