import { expect, test, type Locator, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

const markers = {
  opening: "Opening checkpoint alpha",
  thinking: "Synthetic reasoning checkpoint",
  firstTool: "read",
  finding: "Finding checkpoint beta",
  secondTool: "bash",
  conclusion: "Conclusion checkpoint gamma",
};

async function expandThinking(locator: Locator): Promise<void> {
  if (!(await locator.innerText()).includes(markers.thinking)) {
    await locator.getByRole("button", { name: "Thinking..." }).click();
  }
  await expect(locator).toContainText(markers.thinking);
}

async function expectMarkerOrder(locator: Locator, orderedMarkers: string[]): Promise<void> {
  const text = await locator.innerText();
  let previousIndex = -1;
  for (const marker of orderedMarkers) {
    const index = text.indexOf(marker);
    expect(index, `Expected ${JSON.stringify(marker)} in:\n${text}`).toBeGreaterThan(-1);
    expect(index, `Expected ${JSON.stringify(marker)} after the previous marker in:\n${text}`).toBeGreaterThan(previousIndex);
    previousIndex = index;
  }
}

async function installTimelineSocket(page: Page, history: unknown[] = []): Promise<void> {
  await page.addInitScript(({ initialHistory, timelineMarkers }) => {
    type Handler<T> = ((event: T) => void) | null;

    class TimelineWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = TimelineWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      private readonly sessionId: string;
      private readonly selectionId: string | null;
      private promptHandled = false;
      private timelineStep = 0;

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        (window as unknown as { advanceSyntheticTimeline: () => void }).advanceSyntheticTimeline = () => {
          this.advanceTimeline();
        };
        (window as unknown as { finishSyntheticTimeline: () => void }).finishSyntheticTimeline = () => {
          this.emit({ type: "agent_end", messages: [], will_retry: false });
          this.emit({ type: "agent_settled" });
        };
        (window as unknown as { emitIntermediateAgentEnd: () => void }).emitIntermediateAgentEnd = () => {
          this.emit({ type: "agent_end", messages: [], will_retry: true });
        };
        (window as unknown as { emitSyntheticSettlement: () => void }).emitSyntheticSettlement = () => {
          this.emit({ type: "agent_settled" });
        };
        (window as unknown as { emitSyntheticSettledHistory: () => void }).emitSyntheticSettledHistory = () => {
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            reason: "agent_settled_reconciliation",
            messages: [
              {
                type: "user",
                id: "timeline-user",
                message: { role: "user", content: "Exercise the synthetic progressive assistant timeline." },
              },
              {
                type: "assistant",
                id: "timeline-assistant",
                message: {
                  role: "assistant",
                  content: [{ type: "text", text: `${timelineMarkers.opening}\n${timelineMarkers.conclusion}` }],
                },
              },
            ],
          });
        };
        window.setTimeout(() => {
          this.readyState = TimelineWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            messages: initialHistory,
          });
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as { type?: string; content?: string };
        if (this.promptHandled || message.type !== "message" || typeof message.content !== "string") return;
        this.promptHandled = true;
        this.emit({ type: "message_start", message: { id: "timeline-user", role: "user", content: message.content } });
        this.emit({ type: "agent_start" });
        this.emit({ type: "text_delta", delta: timelineMarkers.opening });
      }

      private advanceTimeline(): void {
        this.timelineStep++;
        switch (this.timelineStep) {
          case 1:
            this.emit({ type: "thinking_delta", delta: timelineMarkers.thinking });
            break;
          case 2:
            this.emit({
              type: "tool_execution_start",
              tool_call_id: "timeline-read",
              tool_name: timelineMarkers.firstTool,
              input: { path: "/synthetic/example.txt" },
            });
            break;
          case 3:
            this.emit({
              type: "tool_execution_end",
              tool_call_id: "timeline-read",
              tool_name: timelineMarkers.firstTool,
              result: { content: [{ type: "text", text: "synthetic read result" }] },
              is_error: false,
            });
            break;
          case 4:
            this.emit({ type: "text_delta", delta: timelineMarkers.finding });
            break;
          case 5:
            this.emit({
              type: "tool_execution_start",
              tool_call_id: "timeline-bash",
              tool_name: timelineMarkers.secondTool,
              input: { command: "printf synthetic" },
            });
            break;
          case 6:
            this.emit({
              type: "tool_execution_end",
              tool_call_id: "timeline-bash",
              tool_name: timelineMarkers.secondTool,
              result: { content: [{ type: "text", text: "synthetic bash result" }] },
              is_error: false,
            });
            break;
          case 7:
            this.emit({ type: "text_delta", delta: timelineMarkers.conclusion });
            break;
        }
      }

      close(): void {
        this.readyState = TimelineWebSocket.CLOSED;
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }

    (window as unknown as { WebSocket: typeof TimelineWebSocket }).WebSocket = TimelineWebSocket;
  }, { initialHistory: history, timelineMarkers: markers });
}

async function sendPrompt(page: Page, prompt: string): Promise<void> {
  const input = page.getByTestId("chat-input");
  await expect(input).toBeEnabled();
  await input.fill(prompt);
  await page.getByTestId("chat-send-button").click();
}

async function advanceTimeline(page: Page): Promise<void> {
  await page.evaluate(() => {
    (window as unknown as { advanceSyntheticTimeline: () => void }).advanceSyntheticTimeline();
  });
}

const orderedMarkers = [
  markers.opening,
  "Thinking...",
  markers.thinking,
  markers.firstTool,
  markers.finding,
  markers.secondTool,
  markers.conclusion,
];

test("preserves assistant text, thinking, and tool chronology while streaming and after settlement", async ({ page, request }) => {
  await installTimelineSocket(page);
  const session = await createE2eSession(request, "e2e assistant timeline");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Exercise the synthetic progressive assistant timeline.");

  const streaming = page.getByTestId("chat-streaming");
  await expect(streaming).toContainText(markers.opening);

  await advanceTimeline(page);
  await expect(streaming.getByRole("button", { name: "Thinking..." })).toBeVisible();
  await expandThinking(streaming);

  await advanceTimeline(page);
  await expect(streaming).toContainText(markers.firstTool);
  await expectMarkerOrder(streaming, orderedMarkers.slice(0, 4));

  await advanceTimeline(page);
  await advanceTimeline(page);
  await expect(streaming).toContainText(markers.finding);
  await expectMarkerOrder(streaming, orderedMarkers.slice(0, 5));

  await advanceTimeline(page);
  await expect(streaming).toContainText(markers.secondTool);
  await expectMarkerOrder(streaming, orderedMarkers.slice(0, 6));

  await advanceTimeline(page);
  await advanceTimeline(page);
  await expect(streaming).toContainText(markers.conclusion);
  await expectMarkerOrder(streaming, orderedMarkers);

  await page.evaluate(() => {
    (window as unknown as { finishSyntheticTimeline: () => void }).finishSyntheticTimeline();
  });

  await expect(streaming).toHaveCount(0);
  const settledAssistant = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
  await expect(settledAssistant).toContainText(markers.conclusion);
  await expandThinking(settledAssistant);
  await expectMarkerOrder(settledAssistant, orderedMarkers);
});

test("keeps retrying runs active until settlement", async ({ page, request }) => {
  await installTimelineSocket(page);
  const session = await createE2eSession(request, "e2e retry lifecycle");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Exercise the synthetic progressive assistant timeline.");
  await expect(page.getByTestId("chat-streaming")).toContainText(markers.opening);

  await page.evaluate(() => {
    (window as unknown as { emitIntermediateAgentEnd: () => void }).emitIntermediateAgentEnd();
  });

  await expect(page.getByTestId("chat-send-button")).toContainText("Queue");

  await page.evaluate(() => {
    (window as unknown as { finishSyntheticTimeline: () => void }).finishSyntheticTimeline();
  });
  await expect(page.getByTestId("chat-send-button")).toContainText("Send");
});

test("settled history replaces residual mobile streaming content without duplication", async ({ page, request }) => {
  await installTimelineSocket(page);
  const session = await createE2eSession(request, "e2e settled history replacement");
  await openSessionInUi(page, session);
  await page.setViewportSize({ width: 412, height: 915 });

  await sendPrompt(page, "Exercise the synthetic progressive assistant timeline.");
  const streaming = page.getByTestId("chat-streaming");
  await expect(streaming).toContainText(markers.opening);

  await page.evaluate(() => {
    (window as unknown as { emitSyntheticSettlement: () => void }).emitSyntheticSettlement();
  });
  await expect(streaming).toContainText(markers.opening);

  await page.evaluate(() => {
    (window as unknown as { emitSyntheticSettledHistory: () => void }).emitSyntheticSettledHistory();
  });
  await expect(streaming).toHaveCount(0);
  const settledAssistants = page.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(settledAssistants).toHaveCount(1);
  await expect(settledAssistants.first()).toContainText(markers.opening);
  await expect(settledAssistants.first()).toContainText(markers.conclusion);
});

test("preserves chronology when normalizing stored assistant and tool-result messages", async ({ page, request }) => {
  const history = [
    {
      type: "user",
      id: "history-user",
      message: { role: "user", content: [{ type: "text", text: "Synthetic history prompt" }] },
    },
    {
      type: "assistant",
      id: "history-assistant-1",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: markers.opening },
          { type: "thinking", thinking: markers.thinking },
          { type: "toolCall", id: "history-read", name: markers.firstTool, arguments: { path: "/synthetic/example.txt" } },
        ],
      },
    },
    {
      type: "toolResult",
      id: "history-result-1",
      message: {
        role: "toolResult",
        toolCallId: "history-read",
        toolName: markers.firstTool,
        content: [{ type: "text", text: "synthetic read result" }],
        isError: false,
      },
    },
    {
      type: "assistant",
      id: "history-assistant-2",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: markers.finding },
          { type: "toolCall", id: "history-bash", name: markers.secondTool, arguments: { command: "printf synthetic" } },
        ],
      },
    },
    {
      type: "toolResult",
      id: "history-result-2",
      message: {
        role: "toolResult",
        toolCallId: "history-bash",
        toolName: markers.secondTool,
        content: [{ type: "text", text: "synthetic bash result" }],
        isError: false,
      },
    },
    {
      type: "assistant",
      id: "history-assistant-3",
      message: { role: "assistant", content: [{ type: "text", text: markers.conclusion }] },
    },
  ];

  await installTimelineSocket(page, history);
  const session = await createE2eSession(request, "e2e assistant history timeline");
  await openSessionInUi(page, session);

  const assistant = page.locator('[data-testid="chat-message"][data-role="assistant"]').last();
  await expect(assistant).toContainText(markers.conclusion);
  await expandThinking(assistant);
  await expectMarkerOrder(assistant, orderedMarkers);
});
