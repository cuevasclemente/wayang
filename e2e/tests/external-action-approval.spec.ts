import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

async function installExternalActionSocketMock(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type SocketEventHandler = ((event: Event) => void) | null;
    type SocketMessageHandler = ((event: MessageEvent) => void) | null;

    const state = {
      sockets: [] as MockWebSocket[],
      sent: [] as Array<Record<string, unknown>>,
    };

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      sessionId: string;
      selectionId: string | null;
      readyState = MockWebSocket.CONNECTING;
      onopen: SocketEventHandler = null;
      onclose: SocketEventHandler = null;
      onerror: SocketEventHandler = null;
      onmessage: SocketMessageHandler = null;

      constructor(url: string) {
        this.url = url;
        const parsed = new URL(url, window.location.href);
        this.sessionId = parsed.searchParams.get("session_id") ?? "";
        this.selectionId = parsed.searchParams.get("selection_id");
        state.sockets.push(this);
        window.setTimeout(() => {
          this.readyState = MockWebSocket.OPEN;
          this.onopen?.(new Event("open"));
          this.syncSelection();
        }, 0);
      }

      send(data: string): void {
        let message: Record<string, unknown>;
        try {
          message = JSON.parse(data) as Record<string, unknown>;
        } catch {
          return;
        }
        state.sent.push(message);
        if (message.type === "switch_session" && typeof message.session_id === "string") {
          this.sessionId = message.session_id;
          this.selectionId = typeof message.selection_id === "string" ? message.selection_id : null;
          this.syncSelection();
        }
      }

      close(): void {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new CloseEvent("close"));
      }

      emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }

      private syncSelection(): void {
        this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
        this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: [] });
        this.emit({
          type: "external_action_snapshot",
          sessionId: this.sessionId,
          selection_id: this.selectionId,
          requests: [],
          syncComplete: true,
        });
      }
    }

    (window as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
    (window as unknown as { __externalActionSocketTest: typeof state & {
      current: () => { sessionId: string; selectionId: string | null };
      emit: (payload: Record<string, unknown>) => void;
      emitCurrent: (payload: Record<string, unknown>) => void;
      closeLatest: () => void;
    } }).__externalActionSocketTest = Object.assign(state, {
      current() {
        const socket = state.sockets.at(-1);
        return { sessionId: socket?.sessionId ?? "", selectionId: socket?.selectionId ?? null };
      },
      emit(payload: Record<string, unknown>) {
        state.sockets.at(-1)?.emit(payload);
      },
      emitCurrent(payload: Record<string, unknown>) {
        const socket = state.sockets.at(-1);
        if (!socket) return;
        socket.emit({
          ...payload,
          sessionId: socket.sessionId,
          selection_id: socket.selectionId,
        });
      },
      closeLatest() {
        state.sockets.at(-1)?.close();
      },
    });
  });
}

async function emitCurrentRequest(page: Page, requestId: string, summary: string): Promise<void> {
  await page.evaluate(({ requestId, summary }) => {
    const testSocket = (window as unknown as {
      __externalActionSocketTest: { emitCurrent: (payload: Record<string, unknown>) => void };
    }).__externalActionSocketTest;
    testSocket.emitCurrent({
      type: "external_action_request",
      requestId,
      connector: "Example connector",
      workspace: "Workspace alpha",
      toolName: "create_record",
      target: "Project beta",
      summary,
      argumentsHash: `sha256:${requestId}`,
      createdAt: Date.now(),
      timeoutMs: 120_000,
    });
  }, { requestId, summary });
}

async function sentResponses(page: Page, requestId: string): Promise<Array<Record<string, unknown>>> {
  return page.evaluate((id) => {
    const state = (window as unknown as {
      __externalActionSocketTest: { sent: Array<Record<string, unknown>> };
    }).__externalActionSocketTest;
    return state.sent.filter((message) => message.type === "external_action_response" && message.requestId === id);
  }, requestId);
}

async function emitCurrentSnapshot(page: Page, requests: Array<Record<string, unknown>>): Promise<void> {
  await page.evaluate((nextRequests) => {
    const testSocket = (window as unknown as {
      __externalActionSocketTest: { emitCurrent: (payload: Record<string, unknown>) => void };
    }).__externalActionSocketTest;
    testSocket.emitCurrent({
      type: "external_action_snapshot",
      requests: nextRequests,
      syncComplete: true,
    });
  }, requests);
}

test("external action approval is exact, ephemeral, reconnect-safe, and selection-scoped", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const firstSession = await createE2eSession(request, "e2e external action first");
  const secondSession = await createE2eSession(request, "e2e external action second");
  await openSessionInUi(page, firstSession);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  const summary = "Create a synthetic record with every displayed argument.\nBody: full preview marker e2e-action-summary";
  await emitCurrentRequest(page, "action-approve", summary);

  const card = page.getByTestId("external-action-approval");
  await expect(card).toHaveCount(1);
  await expect(card).toContainText("Example connector");
  await expect(card).toContainText("Workspace alpha");
  await expect(card).toContainText("create_record");
  await expect(card).toContainText("Project beta");
  await expect(page.getByTestId("external-action-summary")).toHaveText(summary);
  await expect(page.getByTestId("chat-input")).toBeVisible();
  await expect(page.getByTestId("external-action-approvals")).toHaveClass(/max-h-/);
  await expect(page.getByTestId("external-action-approvals")).toHaveClass(/overflow-y-auto/);
  await expect(card).toHaveAttribute("data-approval-kind", "external-action");
  await expect(page.getByTestId("external-action-summary")).toHaveClass(/max-h-/);
  await expect(page.getByTestId("chat-message").filter({ hasText: "e2e-action-summary" })).toHaveCount(0);
  expect(await page.evaluate(() => {
    const values = [...Object.values(localStorage), ...Object.values(sessionStorage)];
    return values.some((value) => value.includes("e2e-action-summary"));
  })).toBe(false);

  // A request event followed by the authoritative snapshot must not duplicate the card.
  await emitCurrentSnapshot(page, [{
    requestId: "action-approve",
    sessionId: firstSession.id,
    connector: "Example connector",
    workspace: "Workspace alpha",
    toolName: "create_record",
    target: "Project beta",
    summary,
    argumentsHash: "sha256:action-approve",
    createdAt: Date.now(),
    timeoutMs: 120_000,
  }]);
  await expect(card).toHaveCount(1);

  await card.getByRole("button", { name: "Approve" }).click();
  await expect(card.getByRole("button", { name: "Approve" })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Deny" })).toBeDisabled();
  await expect.poll(() => sentResponses(page, "action-approve")).toHaveLength(1);
  const [approvedResponse] = await sentResponses(page, "action-approve");
  expect(approvedResponse).toMatchObject({
    type: "external_action_response",
    requestId: "action-approve",
    sessionId: firstSession.id,
    argumentsHash: "sha256:action-approve",
    approved: true,
  });
  expect(typeof approvedResponse.selection_id).toBe("string");

  // Simulate an acknowledgement lost with the old socket. The reconnect snapshot
  // is authoritative and removes the locally disabled card without resubmission.
  await page.evaluate(() => {
    (window as unknown as { __externalActionSocketTest: { closeLatest: () => void } }).__externalActionSocketTest.closeLatest();
  });
  await expect(card).toHaveCount(0, { timeout: 10_000 });
  await expect.poll(() => sentResponses(page, "action-approve")).toHaveLength(1);

  await emitCurrentRequest(page, "action-deny", "Deny this synthetic action");
  await card.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => sentResponses(page, "action-deny")).toHaveLength(1);
  const [deniedResponse] = await sentResponses(page, "action-deny");
  expect(deniedResponse).toMatchObject({
    requestId: "action-deny",
    sessionId: firstSession.id,
    argumentsHash: "sha256:action-deny",
    approved: false,
  });
  await page.evaluate(() => {
    const state = (window as unknown as {
      __externalActionSocketTest: {
        current: () => { sessionId: string; selectionId: string | null };
        emit: (payload: Record<string, unknown>) => void;
      };
    }).__externalActionSocketTest;
    const current = state.current();
    state.emit({
      type: "external_action_response_ack",
      requestId: "action-deny",
      sessionId: current.sessionId,
      selection_id: current.selectionId,
      status: "denied",
    });
  });
  await expect(card).toHaveCount(0);

  await emitCurrentRequest(page, "action-old-selection", "Must disappear on switch");
  const oldIdentity = await page.evaluate(() => (
    (window as unknown as {
      __externalActionSocketTest: { current: () => { sessionId: string; selectionId: string | null } };
    }).__externalActionSocketTest.current()
  ));
  await page.getByText(secondSession.title, { exact: true }).click();
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await expect(card).toHaveCount(0);
  await page.evaluate(({ oldIdentity }) => {
    const state = (window as unknown as {
      __externalActionSocketTest: { emit: (payload: Record<string, unknown>) => void };
    }).__externalActionSocketTest;
    state.emit({
      type: "external_action_request",
      requestId: "late-old-selection",
      sessionId: oldIdentity.sessionId,
      selection_id: oldIdentity.selectionId,
      connector: "Stale connector",
      toolName: "stale_tool",
      summary: "late stale summary",
      argumentsHash: "sha256:late",
      createdAt: Date.now(),
      timeoutMs: 120_000,
    });
  }, { oldIdentity });
  await expect(card).toHaveCount(0);
});

test("terminal snapshots reconcile the same external action in two tabs", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e external action two tabs");
  const secondPage = await context.newPage();
  await openSessionInUi(page, session);
  await openSessionInUi(secondPage, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await expect(secondPage.getByTestId("chat-input")).toBeEnabled();

  await emitCurrentRequest(page, "action-two-tabs", "Visible in both tabs");
  await emitCurrentRequest(secondPage, "action-two-tabs", "Visible in both tabs");
  await expect(page.getByTestId("external-action-approval")).toHaveCount(1);
  await expect(secondPage.getByTestId("external-action-approval")).toHaveCount(1);

  // The backend broadcasts an authoritative snapshot on every terminal event.
  await emitCurrentSnapshot(page, []);
  await emitCurrentSnapshot(secondPage, []);
  await expect(page.getByTestId("external-action-approval")).toHaveCount(0);
  await expect(secondPage.getByTestId("external-action-approval")).toHaveCount(0);
});
