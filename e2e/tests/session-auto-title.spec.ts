import { expect, test, type APIResponse, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

interface AutoTitleFixture {
  completedExchanges(): number;
  catalogReadsAtCompletion: number[];
  titleRequestMethods: string[];
}

/**
 * Browser-only contract fixture for session auto-titles.
 *
 * It deliberately does not emulate Terra or title generation. Instead, it
 * models the backend boundary the frontend consumes: the catalog keeps the
 * provisional title through two completed exchanges and exposes a canonical
 * title after the third completion. ChatPanel's existing session-change
 * refresh must then pick up that catalog projection.
 */
async function installAutoTitleFixture(
  page: Page,
  sessionId: string,
  generatedTitle: string,
): Promise<AutoTitleFixture> {
  let completedExchanges = 0;
  const catalogReadsAtCompletion: number[] = [];
  const titleRequestMethods: string[] = [];
  const completionEndpoint = "/__e2e/session-auto-title/completed-exchange";
  const titlePath = `/api/sessions/${encodeURIComponent(sessionId)}/title`;

  page.on("request", (request) => {
    if (new URL(request.url()).pathname === titlePath) {
      titleRequestMethods.push(request.method());
    }
  });

  await page.route(`**${completionEndpoint}`, async (route) => {
    const body = route.request().postDataJSON() as {
      sessionId?: unknown;
      completedExchanges?: unknown;
    };
    if (
      route.request().method() === "POST"
      && body.sessionId === sessionId
      && typeof body.completedExchanges === "number"
    ) {
      completedExchanges = Math.max(completedExchanges, body.completedExchanges);
    }
    await route.fulfill({ status: 204 });
  });

  await page.route("**/api/sessions", async (route) => {
    if (route.request().method() !== "GET") {
      await route.continue();
      return;
    }
    let response: APIResponse;
    let payload: unknown;
    try {
      response = await route.fetch();
      payload = await response.json() as unknown;
    } catch {
      // A catalog refresh can still be unwinding while Playwright closes the
      // test context. Do not turn that disposed response into an unhandled
      // route error; completed in-test reads are asserted below.
      await route.abort().catch(() => undefined);
      return;
    }
    catalogReadsAtCompletion.push(completedExchanges);
    const catalog = Array.isArray(payload)
      ? payload.map((value) => {
          if (
            completedExchanges < 3
            || !value
            || typeof value !== "object"
            || (value as { id?: unknown }).id !== sessionId
          ) return value;
          return { ...value, title: generatedTitle };
        })
      : payload;
    await route.fulfill({ response, json: catalog });
  });

  await page.addInitScript(
    ({ expectedSessionId, fixtureEndpoint }) => {
      type Handler<T> = ((event: T) => void) | null;

      class AutoTitleContractWebSocket {
        static readonly CONNECTING = 0;
        static readonly OPEN = 1;
        static readonly CLOSING = 2;
        static readonly CLOSED = 3;

        readyState = AutoTitleContractWebSocket.CONNECTING;
        onopen: Handler<Event> = null;
        onclose: Handler<CloseEvent> = null;
        onerror: Handler<Event> = null;
        onmessage: Handler<MessageEvent> = null;
        private readonly sessionId: string;
        private readonly selectionId: string | null;
        private completedExchanges = 0;

        constructor(url: string) {
          const parsed = new URL(url, window.location.href);
          this.sessionId = parsed.searchParams.get("session_id") ?? "";
          this.selectionId = parsed.searchParams.get("selection_id");
          window.setTimeout(() => {
            this.readyState = AutoTitleContractWebSocket.OPEN;
            this.onopen?.(new Event("open"));
            this.emit({ type: "session_loading" });
            this.emit({ type: "session_ready" });
            this.emit({
              type: "history",
              messages: [],
              streaming_at_snapshot: false,
              compacting_at_snapshot: false,
            });
          }, 0);
        }

        send(raw: string): void {
          const message = JSON.parse(raw) as { type?: unknown; content?: unknown };
          if (
            this.sessionId !== expectedSessionId
            || message.type !== "message"
            || typeof message.content !== "string"
          ) return;

          const exchange = ++this.completedExchanges;
          this.emit({
            type: "message_start",
            message: {
              id: `fixture-user-${exchange}`,
              role: "user",
              content: message.content,
            },
          });
          this.emit({ type: "agent_start" });
          this.emit({ type: "text_delta", delta: `Synthetic assistant response ${exchange}.` });

          void fetch(fixtureEndpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              sessionId: this.sessionId,
              completedExchanges: exchange,
            }),
          }).then(() => {
            this.emit({
              type: "agent_end",
              messages: [{
                role: "assistant",
                content: [{ type: "text", text: `Synthetic assistant response ${exchange}.` }],
                stopReason: "stop",
              }],
              will_retry: false,
            });
            this.emit({ type: "agent_settled" });
          });
        }

        close(): void {
          this.readyState = AutoTitleContractWebSocket.CLOSED;
        }

        private emit(payload: Record<string, unknown>): void {
          this.onmessage?.(new MessageEvent("message", {
            data: JSON.stringify({
              ...payload,
              session_id: this.sessionId,
              selection_id: this.selectionId,
            }),
          }));
        }
      }

      (window as unknown as { WebSocket: typeof AutoTitleContractWebSocket }).WebSocket = AutoTitleContractWebSocket;
    },
    { expectedSessionId: sessionId, fixtureEndpoint: completionEndpoint },
  );

  return {
    completedExchanges: () => completedExchanges,
    catalogReadsAtCompletion,
    titleRequestMethods,
  };
}

async function sendExchange(page: Page, fixture: AutoTitleFixture, exchange: number): Promise<void> {
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await input.fill(`Synthetic title exchange ${exchange}`);
  await page.getByTestId("chat-send-button").click();
  await expect.poll(fixture.completedExchanges).toBe(exchange);
  await expect.poll(() => fixture.catalogReadsAtCompletion.includes(exchange)).toBe(true);
  await expect(page.getByTestId("chat-send-button")).toHaveText("Send");
}

test("first send does not issue the legacy title PATCH", async ({ page, request }) => {
  const provisionalTitle = `Provisional first message ${Date.now()}`;
  const session = await createE2eSession(request, provisionalTitle);
  const fixture = await installAutoTitleFixture(page, session.id, "Unused generated title");

  await openSessionInUi(page, session);
  await sendExchange(page, fixture, 1);

  // The removed implementation scheduled its PATCH after 2 seconds.
  await page.waitForTimeout(2_300);
  expect(fixture.titleRequestMethods.filter((method) => method === "PATCH")).toEqual([]);
});

test("catalog title stays provisional through two exchanges and updates after the third", async ({ page, request }) => {
  const provisionalTitle = `Provisional catalog title ${Date.now()}`;
  const generatedTitle = `Canonical synthetic title ${Date.now()}`;
  const session = await createE2eSession(request, provisionalTitle);
  const fixture = await installAutoTitleFixture(page, session.id, generatedTitle);
  const sessionRow = page.locator(
    `[data-testid="session-row"][data-session-id="${session.id}"]`,
  );

  await openSessionInUi(page, session);
  await expect(sessionRow).toContainText(provisionalTitle);

  await sendExchange(page, fixture, 1);
  await expect(sessionRow).toContainText(provisionalTitle);

  await sendExchange(page, fixture, 2);
  await expect(sessionRow).toContainText(provisionalTitle);

  await sendExchange(page, fixture, 3);
  await expect(sessionRow).toContainText(generatedTitle);
  await expect(sessionRow).not.toContainText(provisionalTitle);
  expect(fixture.titleRequestMethods.filter((method) => method === "PATCH")).toEqual([]);
});
