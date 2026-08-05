import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

async function installExternalActionSocketMock(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    type SocketEventHandler = ((event: Event) => void) | null;
    type SocketMessageHandler = ((event: MessageEvent) => void) | null;

    const state = {
      sockets: [] as MockWebSocket[],
      sent: [] as Array<Record<string, unknown>>,
      closeCount: 0,
      autoResolveResponses: false,
      autoAuthoritativeSnapshot: true,
    };
    const serverChannel = new BroadcastChannel("wayang-external-action-test-server");

    const emitForSession = (sessionId: string, payload: Record<string, unknown>) => {
      for (const socket of state.sockets) {
        if (socket.readyState !== MockWebSocket.OPEN || socket.sessionId !== sessionId) continue;
        socket.emit({
          ...payload,
          sessionId,
          selection_id: socket.selectionId,
        });
      }
    };

    serverChannel.onmessage = (event: MessageEvent) => {
      const message = event.data as { sessionId?: unknown; payload?: unknown };
      if (
        typeof message?.sessionId !== "string"
        || !message.payload
        || typeof message.payload !== "object"
      ) return;
      emitForSession(message.sessionId, message.payload as Record<string, unknown>);
    };

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readonly isChat: boolean;
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
        this.isChat = parsed.pathname === "/ws/chat";
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
          return;
        }
        if (
          state.autoResolveResponses
          && message.type === "external_action_response"
          && typeof message.requestId === "string"
          && typeof message.sessionId === "string"
          && typeof message.selection_id === "string"
          && typeof message.approved === "boolean"
          && (!message.approved || typeof message.pin === "string")
        ) {
          const status = message.approved ? "approved" : "denied";
          const terminal = {
            type: "external_action_terminal",
            requestId: message.requestId,
            status,
          };
          const terminalSnapshot = {
            type: "external_action_snapshot",
            requests: [],
            syncComplete: true,
          };
          // Production sends the explicit outcome before its authoritative
          // pending snapshot, then acknowledges the submitting client.
          emitForSession(message.sessionId, terminal);
          emitForSession(message.sessionId, terminalSnapshot);
          this.emit({
            type: "external_action_response_ack",
            requestId: message.requestId,
            sessionId: message.sessionId,
            selection_id: message.selection_id,
            status,
          });
          serverChannel.postMessage({ sessionId: message.sessionId, payload: terminal });
          serverChannel.postMessage({ sessionId: message.sessionId, payload: terminalSnapshot });
        }
      }

      close(): void {
        if (this.readyState === MockWebSocket.CLOSED) return;
        if (this.isChat) state.closeCount += 1;
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
        if (state.autoAuthoritativeSnapshot) this.syncAuthoritativeSnapshot();
      }

      syncAuthoritativeSnapshot(): void {
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
      emitBroadcast: (payload: Record<string, unknown>) => void;
      closeLatest: () => void;
      setAutoResolveResponses: (enabled: boolean) => void;
      setAutoAuthoritativeSnapshot: (enabled: boolean) => void;
      syncLatestAuthoritativeSnapshot: () => void;
      stats: () => { closeCount: number; socketCount: number; openCount: number };
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
      emitBroadcast(payload: Record<string, unknown>) {
        const socket = state.sockets.at(-1);
        if (!socket) return;
        emitForSession(socket.sessionId, payload);
        serverChannel.postMessage({ sessionId: socket.sessionId, payload });
      },
      closeLatest() {
        state.sockets.at(-1)?.close();
      },
      setAutoResolveResponses(enabled: boolean) {
        state.autoResolveResponses = enabled;
      },
      setAutoAuthoritativeSnapshot(enabled: boolean) {
        state.autoAuthoritativeSnapshot = enabled;
      },
      syncLatestAuthoritativeSnapshot() {
        state.sockets.at(-1)?.syncAuthoritativeSnapshot();
      },
      stats() {
        return {
          closeCount: state.closeCount,
          socketCount: state.sockets.filter((socket) => socket.isChat).length,
          openCount: state.sockets.filter((socket) => socket.isChat && socket.readyState === MockWebSocket.OPEN).length,
        };
      },
    });
  });
}

async function emitCurrent(page: Page, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate((nextPayload) => {
    const testSocket = (window as unknown as {
      __externalActionSocketTest: { emitCurrent: (payload: Record<string, unknown>) => void };
    }).__externalActionSocketTest;
    testSocket.emitCurrent(nextPayload);
  }, payload);
}

async function emitCurrentRequest(
  page: Page,
  requestId: string,
  summary: string,
  options: { createdAt?: number; timeoutMs?: number; argumentsHash?: string } = {},
): Promise<void> {
  await emitCurrent(page, {
    type: "external_action_request",
    requestId,
    connector: "Example connector",
    workspace: "Workspace alpha",
    toolName: "create_record",
    target: "Project beta",
    summary,
    argumentsHash: options.argumentsHash ?? "a".repeat(64),
    createdAt: options.createdAt ?? Date.now(),
    timeoutMs: options.timeoutMs ?? 120_000,
  });
}

async function emitBroadcastRequest(page: Page, requestId: string, summary: string): Promise<void> {
  await page.evaluate(({ requestId, summary }) => {
    const testSocket = (window as unknown as {
      __externalActionSocketTest: { emitBroadcast: (payload: Record<string, unknown>) => void };
    }).__externalActionSocketTest;
    testSocket.emitBroadcast({
      type: "external_action_request",
      requestId,
      connector: "Example connector",
      workspace: "Workspace alpha",
      toolName: "create_record",
      target: "Project beta",
      summary,
      argumentsHash: "a".repeat(64),
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
  await emitCurrent(page, {
    type: "external_action_snapshot",
    requests,
    syncComplete: true,
  });
}

async function emitTerminal(
  page: Page,
  requestId: string,
  status: "approved" | "denied" | "timeout" | "cancelled",
): Promise<void> {
  await emitCurrent(page, { type: "external_action_terminal", requestId, status });
}

async function emitAck(
  page: Page,
  requestId: string,
  status: "approved" | "denied" | "stale" | "rejected",
  extra: Record<string, unknown> = {},
): Promise<void> {
  await emitCurrent(page, { type: "external_action_response_ack", requestId, status, ...extra });
}

function cardFor(page: Page, summary: string) {
  return page.getByTestId("external-action-approval").filter({ hasText: summary });
}

test("approval requires a transient PIN while denial remains PIN-free", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e external action pin boundary");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  const summary = "Create a synthetic record.\nBody: full preview marker e2e-action-summary";
  const actionCreatedAt = Date.now();
  await emitCurrentRequest(page, "action-approve", summary, { createdAt: actionCreatedAt });
  const card = cardFor(page, summary);
  await expect(card).toHaveAccessibleName("External action approval required");
  await expect(page.getByTestId("external-action-approvals")).toHaveAttribute("aria-label", "External action approvals");
  await expect(card.getByTestId("external-action-arrival-announcement")).toHaveAttribute("role", "alert");
  await expect(card.getByTestId("external-action-arrival-announcement")).toHaveAttribute("aria-live", "assertive");
  await expect(page.getByTestId("external-action-summary")).toHaveText(summary);
  await expect(card.getByTestId("external-action-status")).toHaveAttribute("aria-live", "polite");
  await expect(card).toContainText("Pending review");
  await expect(card).toContainText("Example connector");
  await expect(card).toContainText("Workspace alpha");
  await expect(card).toContainText("create_record");
  await expect(card).toContainText("Project beta");
  await expect(card).toContainText("Connector-provided action summary (unverified by Wayang)");
  await expect(card).toContainText("action-approve");
  await expect(card).toContainText("a".repeat(64));
  await expect(page.getByTestId("chat-message").filter({ hasText: "e2e-action-summary" })).toHaveCount(0);

  // Event delivery followed by the authoritative replay must upsert, not
  // duplicate, the immutable request.
  await emitCurrentSnapshot(page, [{
    requestId: "action-approve",
    sessionId: session.id,
    connector: "Example connector",
    workspace: "Workspace alpha",
    toolName: "create_record",
    target: "Project beta",
    summary,
    argumentsHash: "a".repeat(64),
    createdAt: actionCreatedAt,
    timeoutMs: 120_000,
  }]);
  await expect(card).toHaveCount(1);

  await card.getByRole("button", { name: "Approve", exact: true }).click();
  const pinPrompt = page.getByTestId("identity-pin-prompt");
  await expect(pinPrompt).toHaveAccessibleName("External action identity PIN");
  await expect(pinPrompt).toContainText("External action identity check");
  await expect(pinPrompt).toContainText("External action under review");
  await expect(pinPrompt).toContainText("sent transiently");
  const pinInput = pinPrompt.getByLabel("8-digit identity PIN");
  const pinSubmit = pinPrompt.getByRole("button", { name: "Approve with PIN" });
  await expect(pinInput).toBeFocused();
  await expect(pinSubmit).toBeDisabled();
  await pinInput.fill("1234");
  await expect(pinSubmit).toBeDisabled();
  await expect.poll(() => sentResponses(page, "action-approve")).toHaveLength(0);

  await pinPrompt.getByRole("button", { name: "Cancel" }).click();
  await expect(pinPrompt).toHaveCount(0);
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeFocused();
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await expect.poll(() => sentResponses(page, "action-approve")).toHaveLength(0);

  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await pinPrompt.getByPlaceholder("8-digit PIN").fill("12345678");
  await pinPrompt.getByRole("button", { name: "Approve with PIN" }).click();
  await expect.poll(() => sentResponses(page, "action-approve")).toHaveLength(1);
  const [approvedResponse] = await sentResponses(page, "action-approve");
  expect(approvedResponse).toMatchObject({
    type: "external_action_response",
    requestId: "action-approve",
    sessionId: session.id,
    argumentsHash: "a".repeat(64),
    approved: true,
    pin: "12345678",
  });
  expect(typeof approvedResponse.selection_id).toBe("string");
  expect(await page.evaluate(() => {
    const values = [...Object.values(localStorage), ...Object.values(sessionStorage)];
    return values.some((value) => value.includes("12345678") || value.includes("e2e-action-summary"));
  })).toBe(false);

  await emitTerminal(page, "action-approve", "approved");
  await emitCurrentSnapshot(page, []);
  await expect(card).toHaveAttribute("data-approval-status", "approved");
  await expect(card).toContainText("Wayang confirmed approval for this exact request and argument hash");
  await expect(card.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await card.getByRole("button", { name: "Dismiss" }).click();
  await expect(card).toHaveCount(0);

  await emitCurrentRequest(page, "action-deny", "Deny without PIN");
  const denyCard = cardFor(page, "Deny without PIN");
  await denyCard.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => sentResponses(page, "action-deny")).toHaveLength(1);
  const [deniedResponse] = await sentResponses(page, "action-deny");
  expect(deniedResponse).toMatchObject({ approved: false });
  expect(deniedResponse).not.toHaveProperty("pin");
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);
});

test("PIN review freezes every non-key immutable field and same-key changes fail closed", async ({ context, page, request }) => {
  test.setTimeout(45_000);
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e immutable external action review");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  type ImmutableWireRequest = {
    requestId: string;
    sessionId: string;
    connector: string;
    workspace?: string;
    toolName: string;
    target?: string;
    summary: string;
    argumentsHash: string;
    createdAt: number;
    timeoutMs: number;
  };
  const withoutOptional = (value: ImmutableWireRequest, field: "workspace" | "target"): ImmutableWireRequest => {
    const next = { ...value };
    delete next[field];
    return next;
  };
  const mutations: Array<{
    name: string;
    mutate: (value: ImmutableWireRequest) => ImmutableWireRequest;
  }> = [
    { name: "connector", mutate: (value) => ({ ...value, connector: "Changed connector" }) },
    { name: "workspace presence", mutate: (value) => withoutOptional(value, "workspace") },
    { name: "workspace value", mutate: (value) => ({ ...value, workspace: "Changed workspace" }) },
    { name: "toolName", mutate: (value) => ({ ...value, toolName: "changed_tool" }) },
    { name: "target presence", mutate: (value) => withoutOptional(value, "target") },
    { name: "target value", mutate: (value) => ({ ...value, target: "Changed target" }) },
    { name: "summary", mutate: (value) => ({ ...value, summary: "Changed immutable summary" }) },
    { name: "argumentsHash", mutate: (value) => ({ ...value, argumentsHash: "c".repeat(64) }) },
    { name: "createdAt", mutate: (value) => ({ ...value, createdAt: value.createdAt + 1 }) },
    { name: "timeoutMs", mutate: (value) => ({ ...value, timeoutMs: value.timeoutMs + 1 }) },
  ];

  for (const [index, mutation] of mutations.entries()) {
    const requestId = `action-immutable-${index}`;
    const original: ImmutableWireRequest = {
      requestId,
      sessionId: session.id,
      connector: "Example connector",
      workspace: "Workspace alpha",
      toolName: "create_record",
      target: "Project beta",
      summary: `Immutable ${mutation.name} marker`,
      argumentsHash: "b".repeat(64),
      createdAt: Date.now() + index,
      timeoutMs: 120_000,
    };
    await emitCurrent(page, { type: "external_action_request", ...original });
    const card = cardFor(page, original.summary);
    await card.getByRole("button", { name: "Approve", exact: true }).click();
    const pinPrompt = page.getByTestId("identity-pin-prompt");
    const pinInput = pinPrompt.getByPlaceholder("8-digit PIN");
    // A prior collision unmounted its prompt, so no entered PIN may survive
    // into this genuinely fresh review.
    await expect(pinInput).toHaveValue("");
    await pinInput.fill("12345678");

    const changed = mutation.mutate(original);
    if (index % 2 === 0) {
      await emitCurrent(page, { type: "external_action_request", ...changed });
    } else {
      await emitCurrentSnapshot(page, [changed]);
    }

    await expect(pinPrompt).toHaveCount(0);
    await expect(card).toHaveAttribute("data-approval-status", "stale");
    await expect(card).toContainText("immutable request details changed");
    await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Deny" })).toBeDisabled();
    await expect.poll(() => sentResponses(page, requestId)).toHaveLength(0);
  }

  // Final unmount proof and unchanged-flow recovery under a genuinely fresh ID.
  await emitCurrentRequest(page, "action-genuinely-fresh", "Fresh request after collisions");
  const freshCard = cardFor(page, "Fresh request after collisions");
  await freshCard.getByRole("button", { name: "Approve", exact: true }).click();
  const freshPrompt = page.getByTestId("identity-pin-prompt");
  await expect(freshPrompt.getByPlaceholder("8-digit PIN")).toHaveValue("");
  await freshPrompt.getByRole("button", { name: "Cancel" }).click();
});

test("immutable collision poisoning survives terminal ordering races", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e sticky immutable collision");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  const makeRequest = (requestId: string, summary: string, createdAt: number) => ({
    requestId,
    sessionId: session.id,
    connector: "Example connector",
    workspace: "Workspace alpha",
    toolName: "create_record",
    target: "Project beta",
    summary,
    argumentsHash: "d".repeat(64),
    createdAt,
    timeoutMs: 120_000,
  });
  const assertCollisionStaysPoisoned = async (requestId: string, summary: string) => {
    const card = cardFor(page, summary);
    await expect(card).toHaveAttribute("data-approval-status", "stale");
    await expect(card).toContainText("immutable request details changed");
    await expect(card).not.toContainText("Wayang confirmed approval for this exact request");
    await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
    await expect(card.getByRole("button", { name: "Deny" })).toBeDisabled();
    await expect.poll(() => sentResponses(page, requestId)).toHaveLength(0);
  };

  // Collision first: neither a later approved terminal nor its following
  // authoritative snapshot may rehabilitate the poisoned identity.
  const collisionFirst = makeRequest("poison-collision-first", "Collision before terminal", Date.now());
  await emitCurrent(page, { type: "external_action_request", ...collisionFirst });
  await emitCurrent(page, {
    type: "external_action_request",
    ...collisionFirst,
    argumentsHash: "e".repeat(64),
  });
  await emitTerminal(page, collisionFirst.requestId, "approved");
  await assertCollisionStaysPoisoned(collisionFirst.requestId, collisionFirst.summary);
  await emitCurrentSnapshot(page, [{ ...collisionFirst, argumentsHash: "e".repeat(64) }]);
  await emitAck(page, collisionFirst.requestId, "approved");
  await assertCollisionStaysPoisoned(collisionFirst.requestId, collisionFirst.summary);

  // Dismissing only removes the card. Replaying the poisoned identity must
  // reconstruct the collision-stale, noninteractive outcome.
  await cardFor(page, collisionFirst.summary).getByRole("button", { name: "Dismiss" }).click();
  await expect(cardFor(page, collisionFirst.summary)).toHaveCount(0);
  await emitCurrent(page, { type: "external_action_request", ...collisionFirst });
  await assertCollisionStaysPoisoned(collisionFirst.requestId, collisionFirst.summary);

  // Terminal first via request upsert: immutable comparison must happen before
  // preserving the normal approved terminal card.
  const requestAfterTerminal = makeRequest("poison-request-after-terminal", "Changed request after approval", Date.now() + 1);
  await emitCurrent(page, { type: "external_action_request", ...requestAfterTerminal });
  await emitTerminal(page, requestAfterTerminal.requestId, "approved");
  await expect(cardFor(page, requestAfterTerminal.summary)).toHaveAttribute("data-approval-status", "approved");
  await emitCurrent(page, {
    type: "external_action_request",
    ...requestAfterTerminal,
    summary: "Wire summary changed after terminal",
  });
  await assertCollisionStaysPoisoned(requestAfterTerminal.requestId, requestAfterTerminal.summary);

  // Terminal first via authoritative snapshot follows the same fail-closed
  // ordering and cannot retain the earlier approved outcome.
  const snapshotAfterTerminal = makeRequest("poison-snapshot-after-terminal", "Changed snapshot after approval", Date.now() + 2);
  await emitCurrent(page, { type: "external_action_request", ...snapshotAfterTerminal });
  await emitTerminal(page, snapshotAfterTerminal.requestId, "approved");
  await expect(cardFor(page, snapshotAfterTerminal.summary)).toHaveAttribute("data-approval-status", "approved");
  await emitCurrentSnapshot(page, [{
    ...snapshotAfterTerminal,
    timeoutMs: snapshotAfterTerminal.timeoutMs + 1,
  }]);
  await assertCollisionStaysPoisoned(snapshotAfterTerminal.requestId, snapshotAfterTerminal.summary);

  // A terminal can arrive before this browser has a card. Its tombstone must
  // prevent a later request with the same current-selection key from reopening.
  const unknownTerminal = makeRequest("terminal-before-request", "Terminal remembered before request", Date.now() + 3);
  await emitTerminal(page, unknownTerminal.requestId, "approved");
  await expect(cardFor(page, unknownTerminal.summary)).toHaveCount(0);
  await emitCurrent(page, { type: "external_action_request", ...unknownTerminal });
  const rememberedTerminalCard = cardFor(page, unknownTerminal.summary);
  await expect(rememberedTerminalCard).toHaveAttribute("data-approval-status", "approved");
  await expect(rememberedTerminalCard).toContainText("Wayang confirmed approval for this exact request");
  await expect(rememberedTerminalCard.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(rememberedTerminalCard.getByRole("button", { name: "Deny" })).toBeDisabled();
});

test("disconnect and pre-sync authority loss disable responses and close external-action PIN", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e external action authority generation");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  const createdAt = Date.now();
  const requestSnapshot = {
    requestId: "action-authority-race",
    sessionId: session.id,
    connector: "Example connector",
    workspace: "Workspace alpha",
    toolName: "create_record",
    target: "Project beta",
    summary: "Authority generation race",
    argumentsHash: "a".repeat(64),
    createdAt,
    timeoutMs: 120_000,
  };
  await emitCurrentRequest(page, requestSnapshot.requestId, requestSnapshot.summary, { createdAt });
  const card = cardFor(page, requestSnapshot.summary);
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("identity-pin-prompt")).toBeVisible();

  await page.evaluate(() => {
    const state = (window as unknown as {
      __externalActionSocketTest: {
        setAutoAuthoritativeSnapshot: (enabled: boolean) => void;
        closeLatest: () => void;
      };
    }).__externalActionSocketTest;
    state.setAutoAuthoritativeSnapshot(false);
    state.closeLatest();
  });
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);
  await expect(card).toBeFocused();
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(card.getByRole("button", { name: "Deny" })).toBeDisabled();
  await expect(card).toContainText("authoritatively synchronized");
  await expect.poll(() => sentResponses(page, requestSnapshot.requestId)).toHaveLength(0);

  // The reconnect can become chat-ready, but it remains non-authoritative for
  // approvals until the exact new transport/selection snapshot arrives.
  await expect(page.getByTestId("chat-input")).toBeEnabled({ timeout: 10_000 });
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  const preSyncCreatedAt = Date.now();
  await emitCurrentRequest(page, "action-before-authoritative-sync", "Delivered before authoritative sync", {
    createdAt: preSyncCreatedAt,
  });
  const preSyncCard = cardFor(page, "Delivered before authoritative sync");
  await expect(preSyncCard.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);
  await emitCurrentSnapshot(page, [requestSnapshot, {
    requestId: "action-before-authoritative-sync",
    sessionId: session.id,
    connector: "Example connector",
    workspace: "Workspace alpha",
    toolName: "create_record",
    target: "Project beta",
    summary: "Delivered before authoritative sync",
    argumentsHash: "a".repeat(64),
    createdAt: preSyncCreatedAt,
    timeoutMs: 120_000,
  }]);
  await expect(card.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await expect(preSyncCard.getByRole("button", { name: "Approve", exact: true })).toBeEnabled();
  await card.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("identity-pin-prompt")).toBeVisible();
  await page.getByTestId("identity-pin-prompt").getByRole("button", { name: "Cancel" }).click();
  await card.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => sentResponses(page, requestSnapshot.requestId)).toHaveLength(1);
});

test("terminal, stale, rejected, unknown, and expired outcomes remain truthful", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e external action outcomes");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await emitCurrentRequest(page, "action-cancelled", "Cancelled outcome marker");
  const cancelled = cardFor(page, "Cancelled outcome marker");
  await cancelled.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("identity-pin-prompt")).toBeVisible();
  await emitTerminal(page, "action-cancelled", "cancelled");
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);
  await expect(cancelled).toBeFocused();
  await expect(cancelled).toHaveAttribute("data-approval-status", "cancelled");
  await expect(cancelled.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await cancelled.getByRole("button", { name: "Dismiss" }).click();

  await emitCurrentRequest(page, "action-stale", "Stale outcome marker");
  const stale = cardFor(page, "Stale outcome marker");
  await stale.getByRole("button", { name: "Deny" }).click();
  await emitAck(page, "action-stale", "stale");
  await expect(stale).toHaveAttribute("data-approval-status", "stale");
  await expect(stale).toContainText("approval was not confirmed");
  await expect(stale.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await stale.getByRole("button", { name: "Dismiss" }).click();

  await emitCurrentRequest(page, "action-rejected", "Rejected outcome marker");
  const rejected = cardFor(page, "Rejected outcome marker");
  await rejected.getByRole("button", { name: "Deny" }).click();
  await emitAck(page, "action-rejected", "rejected", { errorCode: "realm_busy" });
  await expect(rejected).toHaveAttribute("data-approval-status", "rejected");
  await expect(rejected).toContainText("Another identity PIN verification is in progress");
  await expect(rejected.getByRole("button", { name: "Deny" })).toBeEnabled();
  await emitCurrentSnapshot(page, []);
  await expect(rejected).toHaveAttribute("data-approval-status", "unknown");
  await expect(rejected).toContainText("success cannot be inferred");
  await expect(rejected.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await rejected.getByRole("button", { name: "Dismiss" }).click();

  await emitCurrentRequest(page, "action-wrong-pin", "Wrong PIN denial marker");
  const wrongPin = cardFor(page, "Wrong PIN denial marker");
  await wrongPin.getByRole("button", { name: "Approve", exact: true }).click();
  const wrongPinPrompt = page.getByTestId("identity-pin-prompt");
  await wrongPinPrompt.getByPlaceholder("8-digit PIN").fill("00000000");
  await wrongPinPrompt.getByRole("button", { name: "Approve with PIN" }).click();
  await emitTerminal(page, "action-wrong-pin", "denied");
  await emitAck(page, "action-wrong-pin", "denied", { errorCode: "wrong_pin" });
  await expect(wrongPin).toHaveAttribute("data-approval-status", "denied");
  await expect(wrongPin).toContainText("The identity PIN was not accepted. This action was denied and was not approved.");
  await expect(wrongPin.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await wrongPin.getByRole("button", { name: "Dismiss" }).click();

  await emitCurrentRequest(page, "action-pin-unavailable", "PIN unavailable denial marker");
  const pinUnavailable = cardFor(page, "PIN unavailable denial marker");
  await pinUnavailable.getByRole("button", { name: "Approve", exact: true }).click();
  const unavailablePrompt = page.getByTestId("identity-pin-prompt");
  await unavailablePrompt.getByPlaceholder("8-digit PIN").fill("11111111");
  await unavailablePrompt.getByRole("button", { name: "Approve with PIN" }).click();
  await emitTerminal(page, "action-pin-unavailable", "denied");
  await emitAck(page, "action-pin-unavailable", "denied", { errorCode: "pin_unavailable" });
  await expect(pinUnavailable).toHaveAttribute("data-approval-status", "denied");
  await expect(pinUnavailable).toContainText("Identity PIN verification is unavailable, so the action cannot be approved.");
  await pinUnavailable.getByRole("button", { name: "Dismiss" }).click();

  await emitCurrentRequest(page, "action-terminal-wins", "Authoritative terminal marker");
  const terminalWins = cardFor(page, "Authoritative terminal marker");
  await emitTerminal(page, "action-terminal-wins", "approved");
  await emitAck(page, "action-terminal-wins", "stale", { errorCode: "request_not_pending" });
  await expect(terminalWins).toHaveAttribute("data-approval-status", "approved");
  await expect(terminalWins).toContainText("Wayang confirmed approval for this exact request and argument hash");
  await terminalWins.getByRole("button", { name: "Dismiss" }).click();

  await emitCurrentRequest(page, "action-cooldown", "Cooldown denial marker");
  const cooldown = cardFor(page, "Cooldown denial marker");
  await cooldown.getByRole("button", { name: "Approve", exact: true }).click();
  const cooldownPrompt = page.getByTestId("identity-pin-prompt");
  await cooldownPrompt.getByLabel("8-digit identity PIN").fill("22222222");
  await cooldownPrompt.getByRole("button", { name: "Approve with PIN" }).click();
  await emitAck(page, "action-cooldown", "rejected", { errorCode: "cooldown", retryAt: Date.now() + 60_000 });
  await expect(cooldown.getByRole("button", { name: "Approve with PIN again" })).toBeDisabled();
  await expect(cooldown.getByRole("button", { name: "Deny" })).toBeEnabled();
  await cooldown.getByRole("button", { name: "Deny" }).click();
  await expect.poll(() => sentResponses(page, "action-cooldown")).toHaveLength(2);
  const cooldownResponses = await sentResponses(page, "action-cooldown");
  expect(cooldownResponses[1]).toMatchObject({ approved: false });
  expect(cooldownResponses[1]).not.toHaveProperty("pin");
  await emitTerminal(page, "action-cooldown", "denied");

  await emitCurrentRequest(page, "action-snapshot-prompt", "Snapshot closes prompt marker");
  const snapshotPrompt = cardFor(page, "Snapshot closes prompt marker");
  await snapshotPrompt.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("identity-pin-prompt")).toBeVisible();
  await emitCurrentSnapshot(page, []);
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);
  await expect(snapshotPrompt).toHaveAttribute("data-approval-status", "unknown");
  await expect(snapshotPrompt).toBeFocused();
  await snapshotPrompt.getByRole("button", { name: "Dismiss" }).click();

  await emitCurrentRequest(page, "action-expiring-prompt", "Expiry closes prompt marker", { timeoutMs: 300 });
  const expiringPrompt = cardFor(page, "Expiry closes prompt marker");
  await expiringPrompt.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("identity-pin-prompt")).toBeVisible();
  await expect(expiringPrompt).toHaveAttribute("data-approval-status", "timeout", { timeout: 2_000 });
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);
  await expect(expiringPrompt).toBeFocused();
  await expiringPrompt.getByRole("button", { name: "Dismiss" }).click();

  await emitCurrentRequest(page, "action-expired", "Expired outcome marker", { timeoutMs: 150 });
  const expired = cardFor(page, "Expired outcome marker");
  await expect(expired).toHaveAttribute("data-approval-status", "timeout", { timeout: 2_000 });
  await expect(expired.getByRole("button", { name: "Dismiss" })).toBeVisible();
  await expect(expired.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(expired.getByRole("button", { name: "Deny" })).toBeDisabled();

  // A later authoritative terminal event may refine a locally inferred timeout.
  await emitTerminal(page, "action-expired", "denied");
  await expect(expired).toHaveAttribute("data-approval-status", "denied");
});

test("an identity prompt cannot silently replace another prompt", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e external action prompt collision");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await emitCurrentRequest(page, "action-first", "First exact action summary");
  await emitCurrentRequest(page, "action-second", "Second exact action summary");
  const first = cardFor(page, "First exact action summary");
  const second = cardFor(page, "Second exact action summary");
  await first.getByRole("button", { name: "Approve", exact: true }).click();
  const prompt = page.getByTestId("identity-pin-prompt");
  await expect(prompt).toContainText("First exact action summary");

  await second.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(prompt).toHaveCount(1);
  await expect(prompt).toContainText("First exact action summary");
  await expect(prompt).not.toContainText("Second exact action summary");
  await expect(second).toContainText("Finish or cancel the current identity PIN prompt");

  const collisionBinding = await page.evaluate(() => (
    (window as unknown as {
      __externalActionSocketTest: { current: () => { sessionId: string; selectionId: string | null } };
    }).__externalActionSocketTest.current()
  ));
  await emitCurrent(page, {
    type: "command_guard_pin_request",
    requestId: "guard-collision",
    prompt: "A later command guard prompt",
    command: "must not replace",
  });
  await expect(prompt).toContainText("First exact action summary");
  await expect(prompt).not.toContainText("A later command guard prompt");
  await expect.poll(() => page.evaluate((binding) => {
    const sent = (window as unknown as {
      __externalActionSocketTest: { sent: Array<Record<string, unknown>> };
    }).__externalActionSocketTest.sent;
    return sent.some((message) => (
      message.type === "command_guard_pin_response"
      && message.requestId === "guard-collision"
      && message.sessionId === binding.sessionId
      && message.selection_id === binding.selectionId
      && message.cancelled === true
    ));
  }, collisionBinding)).toBe(true);
});

test("missing acknowledgement becomes retryable uncertainty and snapshots never imply success", async ({ context, page, request }) => {
  test.setTimeout(25_000);
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e external action uncertain");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await emitCurrentRequest(page, "action-uncertain", "Uncertain acknowledgement marker");
  const card = cardFor(page, "Uncertain acknowledgement marker");
  await card.getByRole("button", { name: "Deny" }).click();
  await expect(card).toHaveAttribute("data-approval-status", "awaiting_ack");
  await expect(card.getByRole("button", { name: "Deny" })).toBeDisabled();
  await expect(card).toHaveAttribute("data-approval-status", "uncertain", { timeout: 12_000 });
  await expect(card).toContainText("No acknowledgement or terminal event arrived within 10 seconds");
  await expect(card.getByRole("button", { name: "Deny" })).toBeEnabled();
  await expect.poll(() => sentResponses(page, "action-uncertain")).toHaveLength(1);

  await emitCurrentSnapshot(page, []);
  await expect(card).toHaveAttribute("data-approval-status", "unknown");
  await expect(card).toContainText("snapshot omitted it without a terminal outcome");
  await expect(card.getByRole("button", { name: "Dismiss" })).toBeVisible();
});

test("switching selections while an external-action PIN is open restores safe focus without sending", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const firstSession = await createE2eSession(request, "e2e PIN focus switch source");
  const secondSession = await createE2eSession(request, "e2e PIN focus switch destination");
  await openSessionInUi(page, firstSession);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await emitCurrentRequest(page, "switch-open-pin", "Switch while PIN remains local");
  const sourceCard = cardFor(page, "Switch while PIN remains local");
  await sourceCard.getByRole("button", { name: "Approve", exact: true }).click();
  const prompt = page.getByTestId("identity-pin-prompt");
  await prompt.getByPlaceholder("8-digit PIN").fill("24681357");

  await page.getByText(secondSession.title, { exact: true }).click();
  await expect(prompt).toHaveCount(0);
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await expect(page.getByTestId("chat-input")).toBeFocused();
  await expect.poll(() => sentResponses(page, "switch-open-pin")).toHaveLength(0);
  await expect(page.locator("body")).not.toBeFocused();
});

test("reconnect, selection changes, and two tabs preserve exact terminal meaning", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const firstSession = await createE2eSession(request, "e2e external action first");
  const secondSession = await createE2eSession(request, "e2e external action second");
  await openSessionInUi(page, firstSession);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await emitCurrentRequest(page, "action-reconnect", "Reconnect unknown marker");
  const reconnectCard = cardFor(page, "Reconnect unknown marker");
  await reconnectCard.getByRole("button", { name: "Deny" }).click();
  await page.evaluate(() => {
    (window as unknown as { __externalActionSocketTest: { closeLatest: () => void } }).__externalActionSocketTest.closeLatest();
  });
  await expect(reconnectCard).toHaveAttribute("data-approval-status", "uncertain");
  await expect(reconnectCard).toHaveAttribute("data-approval-status", "unknown", { timeout: 10_000 });
  await expect.poll(() => sentResponses(page, "action-reconnect")).toHaveLength(1);

  await page.getByText(secondSession.title, { exact: true }).click();
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await expect(page.getByTestId("external-action-approval")).toHaveCount(0);

  // A same-session request from a superseded selection must not collect a PIN.
  await page.evaluate(() => {
    const state = (window as unknown as {
      __externalActionSocketTest: {
        current: () => { sessionId: string; selectionId: string | null };
        emit: (payload: Record<string, unknown>) => void;
      };
    }).__externalActionSocketTest;
    const current = state.current();
    state.emit({
      type: "command_guard_pin_request",
      requestId: "delayed-stale-selection-pin",
      sessionId: current.sessionId,
      selection_id: `${current.selectionId}-stale`,
      prompt: "Must not render for a stale same-session selection",
    });
  });
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);

  // A delayed PIN request from the previous session must not collect a PIN in
  // the new selection.
  await page.evaluate((oldSessionId) => {
    const state = (window as unknown as {
      __externalActionSocketTest: { emit: (payload: Record<string, unknown>) => void };
    }).__externalActionSocketTest;
    state.emit({
      type: "command_guard_pin_request",
      requestId: "delayed-old-session-pin",
      sessionId: oldSessionId,
      selection_id: "old-session-selection",
      prompt: "Must not render in the new session",
    });
  }, firstSession.id);
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);

  const secondPage = await context.newPage();
  await openSessionInUi(page, firstSession);
  await openSessionInUi(secondPage, firstSession);
  await expect(page.getByTestId("chat-input")).toBeEnabled();
  await expect(secondPage.getByTestId("chat-input")).toBeEnabled();
  await page.evaluate(() => {
    (window as unknown as {
      __externalActionSocketTest: { setAutoResolveResponses: (enabled: boolean) => void };
    }).__externalActionSocketTest.setAutoResolveResponses(true);
  });

  await emitBroadcastRequest(page, "action-two-tabs", "Visible in both tabs");
  const firstCard = cardFor(page, "Visible in both tabs");
  const secondCard = cardFor(secondPage, "Visible in both tabs");
  await firstCard.getByRole("button", { name: "Approve", exact: true }).click();
  const prompt = page.getByTestId("identity-pin-prompt");
  await prompt.getByPlaceholder("8-digit PIN").fill("87654321");
  await prompt.getByRole("button", { name: "Approve with PIN" }).click();
  await expect.poll(() => sentResponses(page, "action-two-tabs")).toHaveLength(1);
  await expect(firstCard).toHaveAttribute("data-approval-status", "approved");
  await expect(secondCard).toHaveAttribute("data-approval-status", "approved");
  await expect.poll(() => sentResponses(secondPage, "action-two-tabs")).toHaveLength(0);
});

test("settled external-action cards have a bounded visible retention policy", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e bounded external action outcomes");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  const evictedCollisionCreatedAt = Date.now() - 60_000;
  await emitCurrentRequest(page, "bounded-poisoned", "Evicted collision replay", {
    createdAt: evictedCollisionCreatedAt,
    argumentsHash: "f".repeat(64),
  });
  await emitCurrentRequest(page, "bounded-poisoned", "Evicted collision replay", {
    createdAt: evictedCollisionCreatedAt,
    argumentsHash: "0".repeat(64),
  });
  await expect(cardFor(page, "Evicted collision replay")).toHaveAttribute("data-approval-status", "stale");
  await page.waitForTimeout(20);

  for (let index = 0; index < 25; index += 1) {
    const requestId = `bounded-action-${index}`;
    await emitCurrentRequest(page, requestId, `Bounded outcome ${index}`);
    await emitTerminal(page, requestId, "denied");
  }

  await expect(page.getByTestId("external-action-approval")).toHaveCount(20);
  await expect(cardFor(page, "Evicted collision replay")).toHaveCount(0);
  await emitCurrentRequest(page, "bounded-poisoned", "Evicted collision replay", {
    createdAt: evictedCollisionCreatedAt,
    argumentsHash: "f".repeat(64),
  });
  const replayedCollision = cardFor(page, "Evicted collision replay");
  await expect(replayedCollision).toHaveAttribute("data-approval-status", "stale");
  await expect(replayedCollision.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect(replayedCollision.getByRole("button", { name: "Deny" })).toBeDisabled();
  await expect(page.getByTestId("external-action-approval")).toHaveCount(20);
  await expect(page.getByTestId("external-action-approvals")).toContainText(
    "older settled action card",
  );
  await expect(page.getByTestId("external-action-approvals")).toContainText(
    "Disappearance is not evidence of approval",
  );

  // If the focused action becomes terminal and is immediately evicted by the
  // bounded retention policy, focus falls back to the composer rather than a
  // detached approval button/card.
  await emitCurrentRequest(page, "bounded-old-focused", "Evicted focused outcome", {
    createdAt: Date.now() - 60_000,
    timeoutMs: 120_000,
  });
  const evicted = cardFor(page, "Evicted focused outcome");
  await evicted.getByRole("button", { name: "Approve", exact: true }).click();
  await expect(page.getByTestId("identity-pin-prompt")).toBeVisible();
  await emitTerminal(page, "bounded-old-focused", "denied");
  await expect(page.getByTestId("identity-pin-prompt")).toHaveCount(0);
  await expect(evicted).toHaveCount(0);
  await expect(page.getByTestId("chat-input")).toBeFocused();
});

test("deselecting the active session closes its approval WebSocket without reconnecting", async ({ context, page, request }) => {
  await installExternalActionSocketMock(context);
  const session = await createE2eSession(request, "e2e external action deselect");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  const sessionRow = page.getByText(session.title, { exact: true }).locator("xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' group ')][1]");
  await sessionRow.hover();
  page.once("dialog", (dialog) => dialog.accept());
  await sessionRow.getByRole("button", { name: "Archive session" }).click();
  await expect(page.getByText("Select a session or create a new one", { exact: true })).toBeVisible();

  await expect.poll(() => page.evaluate(() => (
    (window as unknown as {
      __externalActionSocketTest: { stats: () => { closeCount: number; socketCount: number; openCount: number } };
    }).__externalActionSocketTest.stats()
  ))).toEqual({ closeCount: 1, socketCount: 1, openCount: 0 });
});
