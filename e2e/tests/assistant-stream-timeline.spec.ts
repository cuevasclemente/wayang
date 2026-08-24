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

async function installTimelineSocket(
  page: Page,
  history: unknown[] = [],
  compactingAtSnapshot = false,
  streamingAtSnapshot = compactingAtSnapshot,
): Promise<void> {
  await page.addInitScript(({ initialHistory, timelineMarkers, initialCompacting, initialStreaming }) => {
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
      private suppressNextUserEcho = false;

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
        (window as unknown as { emitSyntheticOverflowRecovery: () => void }).emitSyntheticOverflowRecovery = () => {
          const overflow = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.",
          };
          this.emit({ type: "message_end", message: overflow });
          this.emit({ type: "agent_end", messages: [overflow], will_retry: false });
          this.emit({ type: "compaction_start", reason: "overflow" });
        };
        (window as unknown as { completeSyntheticOverflowRecovery: () => void }).completeSyntheticOverflowRecovery = () => {
          this.emit({
            type: "compaction_end",
            reason: "overflow",
            succeeded: true,
            aborted: false,
            will_retry: true,
          });
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            reason: "compaction_end_reconciliation",
            streaming_at_snapshot: true,
            compacting_at_snapshot: false,
            messages: [],
          });
          this.emit({ type: "agent_start" });
        };
        (window as unknown as { emitSyntheticTerminalOverflow: () => void }).emitSyntheticTerminalOverflow = () => {
          const overflow = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.",
            errorKind: "context_overflow",
          };
          this.emit({ type: "message_end", message: overflow });
          this.emit({ type: "agent_end", messages: [overflow], will_retry: false });
          this.emit({ type: "agent_settled" });
        };
        (window as unknown as { emitSyntheticTerminalError: () => void }).emitSyntheticTerminalError = () => {
          const terminalError = {
            role: "assistant",
            content: [],
            stopReason: "error",
            errorMessage: "Synthetic terminal provider failure",
          };
          this.emit({ type: "message_end", message: terminalError });
          this.emit({ type: "agent_end", messages: [terminalError], will_retry: false });
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
        (window as unknown as { suppressNextSyntheticUserEcho: () => void }).suppressNextSyntheticUserEcho = () => {
          this.suppressNextUserEcho = true;
        };
        (window as unknown as { emitSyntheticHistory: (messages: unknown[]) => void }).emitSyntheticHistory = (messages) => {
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            reason: "synthetic_reconciliation",
            messages,
          });
        };
        (window as unknown as { emitSyntheticUserReplay: (message: unknown) => void }).emitSyntheticUserReplay = (message) => {
          this.emit(message as Record<string, unknown>);
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
            streaming_at_snapshot: initialStreaming,
            compacting_at_snapshot: initialCompacting,
            messages: initialHistory,
          });
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as { type?: string; content?: string };
        if (message.type !== "message" || typeof message.content !== "string") return;
        const sent = (window as unknown as { __syntheticSentMessages?: string[] }).__syntheticSentMessages ?? [];
        sent.push(message.content);
        (window as unknown as { __syntheticSentMessages?: string[] }).__syntheticSentMessages = sent;
        if (message.content.startsWith("/compact")) return;
        if (this.promptHandled) return;
        this.promptHandled = true;
        if (this.suppressNextUserEcho) {
          this.suppressNextUserEcho = false;
        } else {
          this.emit({ type: "message_start", message: { id: "timeline-user", role: "user", content: message.content } });
        }
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
  }, {
    initialHistory: history,
    timelineMarkers: markers,
    initialCompacting: compactingAtSnapshot,
    initialStreaming: streamingAtSnapshot,
  });
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

test("renders a repeated short user reply as a distinct live turn", async ({ page, request }) => {
  await installTimelineSocket(page, [
    {
      type: "user",
      id: "earlier-done-user",
      message: { role: "user", content: "done", timestamp: 1_700_000_000_000 },
    },
    {
      type: "assistant",
      id: "earlier-done-assistant",
      message: { role: "assistant", content: "Earlier acknowledgement." },
    },
  ]);
  const session = await createE2eSession(request, "e2e repeated short user reply");
  await openSessionInUi(page, session);

  await sendPrompt(page, "done");

  await expect(page.getByTestId("chat-streaming")).toContainText(markers.opening);
  const userMessages = page.locator('[data-testid="chat-message"][data-role="user"]');
  await expect(userMessages).toHaveCount(2);
  await expect(userMessages.nth(0)).toContainText("done");
  await expect(userMessages.nth(1)).toContainText("done");
});

test("reconciles repeated optimistic replies by occurrence without consuming them on old replay", async ({ page, request }) => {
  const earlierUser = {
    type: "user",
    id: "earlier-done-user",
    message: { role: "user", content: "done", timestamp: 1_700_000_000_000 },
  };
  const removedSameContentUser = {
    type: "user",
    id: "removed-done-user",
    message: { role: "user", content: "done", timestamp: 1_699_999_999_000 },
  };
  const earlierAssistant = {
    type: "assistant",
    id: "earlier-done-assistant",
    message: { role: "assistant", content: "Earlier acknowledgement." },
  };
  await installTimelineSocket(page, [removedSameContentUser, earlierUser, earlierAssistant]);
  const session = await createE2eSession(request, "e2e repeated reply reconciliation");
  await openSessionInUi(page, session);

  await page.evaluate(() => {
    (window as unknown as { suppressNextSyntheticUserEcho: () => void }).suppressNextSyntheticUserEcho();
  });
  await sendPrompt(page, "done");
  const userMessages = page.locator('[data-testid="chat-message"][data-role="user"]');
  await expect(userMessages).toHaveCount(3);

  await page.evaluate(({ removedUser, oldUser, oldAssistant }) => {
    (window as unknown as { emitSyntheticHistory: (messages: unknown[]) => void })
      .emitSyntheticHistory([removedUser, oldUser, oldAssistant]);
  }, { removedUser: removedSameContentUser, oldUser: earlierUser, oldAssistant: earlierAssistant });
  await expect(userMessages).toHaveCount(3);

  await page.evaluate((oldUser) => {
    (window as unknown as { emitSyntheticUserReplay: (message: unknown) => void }).emitSyntheticUserReplay(oldUser);
  }, earlierUser);
  await expect(userMessages).toHaveCount(3);
  await expect(page.locator('[data-message-id="earlier-done-user"]')).toHaveCount(1);

  const acceptedUser = {
    type: "user",
    id: "accepted-done-user",
    message: { role: "user", content: "done", timestamp: 1_700_000_001_000 },
  };
  await page.evaluate(({ oldUser, oldAssistant, newUser }) => {
    (window as unknown as { emitSyntheticHistory: (messages: unknown[]) => void })
      .emitSyntheticHistory([oldUser, oldAssistant, newUser]);
  }, { oldUser: earlierUser, oldAssistant: earlierAssistant, newUser: acceptedUser });
  await expect(userMessages).toHaveCount(2);
  await expect(page.locator('[data-message-id="removed-done-user"]')).toHaveCount(0);
  await expect(page.locator('[data-message-id="earlier-done-user"]')).toHaveCount(1);
  await expect(page.locator('[data-message-id="accepted-done-user"]')).toHaveCount(1);
});

test("does not consume a repeated queued reply from an older history occurrence", async ({ page, request }) => {
  const earlierUser = {
    type: "user",
    id: "queued-earlier-done-user",
    message: { role: "user", content: "done", timestamp: 1_700_000_000_000 },
  };
  const activeAssistant = {
    type: "assistant",
    id: "queued-active-assistant",
    message: { role: "assistant", content: "Active response prefix." },
  };
  await installTimelineSocket(page, [earlierUser, activeAssistant], false, true);
  const session = await createE2eSession(request, "e2e repeated queued reply reconciliation");
  await openSessionInUi(page, session);

  await page.evaluate(() => {
    (window as unknown as { suppressNextSyntheticUserEcho: () => void }).suppressNextSyntheticUserEcho();
  });
  await sendPrompt(page, "done");
  const queued = page.getByTestId("chat-queued-user-message");
  await expect(queued).toHaveCount(1);

  await page.evaluate(({ oldUser, assistant }) => {
    (window as unknown as { emitSyntheticHistory: (messages: unknown[]) => void })
      .emitSyntheticHistory([oldUser, assistant]);
  }, { oldUser: earlierUser, assistant: activeAssistant });
  await expect(queued).toHaveCount(1);

  const acceptedUser = {
    type: "user",
    id: "queued-accepted-done-user",
    message: { role: "user", content: "done", timestamp: 1_700_000_001_000 },
  };
  await page.evaluate(({ oldUser, assistant, newUser }) => {
    (window as unknown as { emitSyntheticHistory: (messages: unknown[]) => void })
      .emitSyntheticHistory([oldUser, assistant, newUser]);
  }, { oldUser: earlierUser, assistant: activeAssistant, newUser: acceptedUser });
  await expect(queued).toHaveCount(0);
  await expect(page.locator('[data-message-id="queued-earlier-done-user"]')).toHaveCount(1);
  await expect(page.locator('[data-message-id="queued-accepted-done-user"]')).toHaveCount(1);
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

test("shows context recovery as compaction instead of a terminal error", async ({ page, request }) => {
  await installTimelineSocket(page);
  const session = await createE2eSession(request, "e2e overflow recovery lifecycle");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Exercise synthetic overflow recovery.");
  await page.evaluate(() => {
    (window as unknown as { emitSyntheticOverflowRecovery: () => void }).emitSyntheticOverflowRecovery();
  });

  await expect(page.getByTestId("chat-runtime-error")).toHaveCount(0);
  await expect(page.locator("section > header").first()).toContainText("compacting");
  await expect(page.getByText("Codex error: Your input exceeds the context window of this model.", { exact: false })).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as { completeSyntheticOverflowRecovery: () => void }).completeSyntheticOverflowRecovery();
  });
  await expect(page.locator("section > header").first()).not.toContainText("compacting");
});

test("restores compacting state and suppresses the active overflow error on reattach", async ({ page, request }) => {
  const overflow = "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.";
  await installTimelineSocket(page, [
    { type: "user", id: "recovery-user", message: { role: "user", content: "Synthetic recovery prompt" } },
    {
      type: "assistant",
      id: "recovery-overflow",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: overflow, errorKind: "context_overflow" },
    },
  ], true);
  const session = await createE2eSession(request, "e2e compacting reattach lifecycle");
  await openSessionInUi(page, session);

  await expect(page.locator("section > header").first()).toContainText("compacting");
  await expect(page.getByText(overflow, { exact: false })).toHaveCount(0);
});

test("suppresses the overflow during the reattach race before compaction_start", async ({ page, request }) => {
  const overflow = "Codex error: Your input exceeds the context window of this model. Please adjust your input and try again.";
  await installTimelineSocket(page, [
    { type: "user", id: "race-user", message: { role: "user", content: "Synthetic recovery race prompt" } },
    {
      type: "assistant",
      id: "race-overflow",
      message: { role: "assistant", content: [], stopReason: "error", errorMessage: overflow, errorKind: "context_overflow" },
    },
  ], false, true);
  const session = await createE2eSession(request, "e2e overflow recovery reattach race");
  await openSessionInUi(page, session);

  await expect(page.getByTestId("chat-interrupt-button")).toBeVisible();
  await expect(page.getByText(overflow, { exact: false })).toHaveCount(0);
});

test("retains terminal errors from stored assistant responses with partial content", async ({ page, request }) => {
  const terminalError = "Synthetic terminal failure after partial response";
  await installTimelineSocket(page, [
    { type: "user", id: "partial-user", message: { role: "user", content: "Synthetic partial response prompt" } },
    {
      type: "assistant",
      id: "partial-assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Partial answer before failure" }],
        stopReason: "error",
        errorMessage: terminalError,
      },
    },
  ]);
  const session = await createE2eSession(request, "e2e partial terminal assistant error");
  await openSessionInUi(page, session);

  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toContainText("Partial answer before failure");
  await expect(page.locator('[data-testid="chat-message"][data-role="error"]')).toContainText(terminalError);
});

test("offers deliberate compaction after terminal context recovery failure", async ({ page, request }) => {
  await installTimelineSocket(page);
  const session = await createE2eSession(request, "e2e terminal context recovery failure");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Exercise terminal overflow recovery failure.");
  await page.evaluate(() => {
    (window as unknown as { emitSyntheticTerminalOverflow: () => void }).emitSyntheticTerminalOverflow();
  });

  await expect(page.getByTestId("chat-runtime-error")).toContainText("Context overflow recovery failed");
  const compact = page.getByTestId("compact-after-overflow");
  await expect(compact).toBeEnabled();
  await compact.click();
  await expect(page.getByTestId("chat-runtime-error")).toContainText("Context overflow recovery failed");
  await expect.poll(() => page.evaluate(() => (
    (window as unknown as { __syntheticSentMessages?: string[] }).__syntheticSentMessages ?? []
  ).filter((message) => message.startsWith("/compact")).length)).toBe(1);
  await page.evaluate(() => {
    (window as unknown as { completeSyntheticOverflowRecovery: () => void }).completeSyntheticOverflowRecovery();
  });
  await expect(page.getByTestId("chat-runtime-error")).toHaveCount(0);
});

test("surfaces an assistant provider error after the lifecycle settles without recovery", async ({ page, request }) => {
  await installTimelineSocket(page);
  const session = await createE2eSession(request, "e2e terminal assistant error lifecycle");
  await openSessionInUi(page, session);

  await sendPrompt(page, "Exercise a synthetic terminal provider failure.");
  await page.evaluate(() => {
    (window as unknown as { emitSyntheticTerminalError: () => void }).emitSyntheticTerminalError();
  });

  await expect(page.getByTestId("chat-runtime-error")).toContainText("Synthetic terminal provider failure");
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

test("reattaches to an active stream without dropping or splitting the snapshot continuation", async ({ page, request }) => {
  const firstSession = await createE2eSession(request, "e2e active stream reattach");
  const otherSession = await createE2eSession(request, "e2e active stream other");

  await page.addInitScript(({ opening, conclusion }) => {
    type Handler<T> = ((event: T) => void) | null;

    class ReattachWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readyState = ReattachWebSocket.CONNECTING;
      onopen: Handler<Event> = null;
      onclose: Handler<CloseEvent> = null;
      onerror: Handler<Event> = null;
      onmessage: Handler<MessageEvent> = null;
      private sessionId: string;
      private selectionId: string | null;
      private readonly activeSessionId: string;
      private readonly activeSelectionId: string | null;
      private prompt = "";

      constructor(url: string) {
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.activeSessionId = this.sessionId;
        this.selectionId = parsed.searchParams.get("selection_id");
        this.activeSelectionId = this.selectionId;
        (window as unknown as { finishReattachedStream: () => void }).finishReattachedStream = () => {
          const messages = this.activeHistory(`${opening}${conclusion}`);
          this.emit({ type: "agent_end", messages: [], will_retry: false });
          this.emit({ type: "agent_settled" });
          this.emit({
            type: "history",
            session_id: this.sessionId,
            selection_id: this.selectionId,
            reason: "agent_settled_reconciliation",
            streaming_at_snapshot: false,
            messages,
          });
        };
        window.setTimeout(() => {
          this.readyState = ReattachWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.sendSelectionHistory(false);
        }, 0);
      }

      send(raw: string): void {
        const message = JSON.parse(raw) as { type?: string; session_id?: string; selection_id?: string; content?: string };
        if (message.type === "switch_session" && typeof message.session_id === "string") {
          this.sessionId = message.session_id;
          this.selectionId = typeof message.selection_id === "string" ? message.selection_id : null;
          this.sendSelectionHistory(this.sessionId === this.activeSessionId && this.prompt.length > 0);
          return;
        }
        if (message.type !== "message" || typeof message.content !== "string" || this.sessionId !== this.activeSessionId) return;
        this.prompt = message.content;
        this.emit({ type: "message_start", message: { id: "reattach-user", role: "user", content: this.prompt } });
        this.emit({ type: "agent_start" });
        this.emit({ type: "text_delta", delta: opening });
      }

      close(): void {
        this.readyState = ReattachWebSocket.CLOSED;
      }

      private activeHistory(text: string): unknown[] {
        return [
          {
            type: "user",
            id: "reattach-user",
            message: { role: "user", content: this.prompt },
          },
          {
            type: "assistant",
            id: "reattach-assistant",
            message: { role: "assistant", content: [{ type: "text", text }] },
          },
        ];
      }

      private sendSelectionHistory(active: boolean): void {
        this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
        if (!active && this.prompt.length > 0) {
          // Simulate an A delta that was already queued in the browser when the
          // user selected B. Correlation must keep it out of B's transcript.
          this.emit({
            type: "text_delta",
            session_id: this.activeSessionId,
            selection_id: this.activeSelectionId,
            delta: "STALE_CROSS_SESSION_DELTA",
          });
        }
        this.emit({
          type: "history",
          session_id: this.sessionId,
          selection_id: this.selectionId,
          reason: "initial",
          ...(active ? { streaming_at_snapshot: true } : {}),
          messages: active ? this.activeHistory(opening) : [],
        });
        // This delta is newer than the history snapshot and must survive the
        // attach boundary rather than being cleared by a late synthetic start.
        if (active) this.emit({ type: "text_delta", delta: conclusion });
      }

      private emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }

    (window as unknown as { WebSocket: typeof ReattachWebSocket }).WebSocket = ReattachWebSocket;
  }, { opening: markers.opening, conclusion: markers.conclusion });

  await openSessionInUi(page, firstSession);
  await sendPrompt(page, "Exercise active stream reattachment.");
  await expect(page.getByTestId("chat-streaming")).toContainText(markers.opening);

  await page.getByText(otherSession.title, { exact: true }).click();
  await expect(page.getByTestId("chat-message-list")).toHaveAttribute("data-transcript-state", "ready");
  await expect(page.getByTestId("chat-streaming")).toHaveCount(0);
  await expect(page.locator("body")).not.toContainText("STALE_CROSS_SESSION_DELTA");
  await page.getByText(firstSession.title, { exact: true }).click();

  const reattachedStream = page.getByTestId("chat-streaming");
  await expect(reattachedStream).toContainText(markers.opening);
  await expect(reattachedStream).toContainText(markers.conclusion);
  await expectMarkerOrder(reattachedStream, [markers.opening, markers.conclusion]);
  const reattachedText = await reattachedStream.innerText();
  expect(reattachedText.split(markers.opening).length - 1).toBe(1);
  expect(reattachedText.split(markers.conclusion).length - 1).toBe(1);
  await expect(page.locator('[data-testid="chat-message"][data-role="assistant"]')).toHaveCount(0);

  await page.evaluate(() => {
    (window as unknown as { finishReattachedStream: () => void }).finishReattachedStream();
  });
  await expect(reattachedStream).toHaveCount(0);
  const settledAssistant = page.locator('[data-testid="chat-message"][data-role="assistant"]');
  await expect(settledAssistant).toHaveCount(1);
  await expectMarkerOrder(settledAssistant.first(), [markers.opening, markers.conclusion]);
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
