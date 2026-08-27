import { expect, test } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

const firstRequestId = "e2e-interview-first";
const secondRequestId = "e2e-interview-second";

async function installInterviewSocketMock(
  page: import("@playwright/test").Page,
  replayOnSync: { requestId: string; prompt: string } | null = null,
): Promise<void> {
  await page.addInitScript(({ replay }) => {
    type SocketEventHandler = ((event: Event) => void) | null;
    type SocketMessageHandler = ((event: MessageEvent) => void) | null;

    const state = {
      sockets: [] as MockWebSocket[],
      sent: [] as Array<Record<string, unknown>>,
      replay,
      replayRequestId: replay?.requestId ?? null,
      terminalReplayStatus: null as "cancelled" | null,
      terminalInterviewStatuses: new Map<string, "submitted" | "delivered" | "cancelled">(),
      openInterviewRequests: new Map<string, Record<string, unknown>>(),
    };

    class MockWebSocket {
      static readonly CONNECTING = 0;
      static readonly OPEN = 1;
      static readonly CLOSING = 2;
      static readonly CLOSED = 3;
      readonly url: string;
      readonly sessionId: string;
      readonly selectionId: string | null;
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
          this.emit({ type: "session_loading", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "session_ready", session_id: this.sessionId, selection_id: this.selectionId });
          this.emit({ type: "history", session_id: this.sessionId, selection_id: this.selectionId, messages: [] });
        }, 0);
      }

      send(data: string): void {
        try {
          const message = JSON.parse(data) as Record<string, unknown>;
          state.sent.push(message);
          if (message.type === "interactive_state_sync_request") {
            const knownIds = Array.isArray(message.known_interview_request_ids)
              ? message.known_interview_request_ids.filter((id): id is string => typeof id === "string")
              : [];
            this.emit({
              type: "interview_snapshot",
              session_id: this.sessionId,
              selection_id: this.selectionId,
              sessionId: this.sessionId,
              requests: [
                ...(state.replay ? [{
                  requestId: state.replay.requestId,
                  sessionId: this.sessionId,
                  createdAt: 5,
                  questions: [{
                    id: "replayed",
                    label: "Replayed",
                    prompt: state.replay.prompt,
                    options: [{ value: "ok", label: "OK" }],
                    allowOther: true,
                  }],
                }] : []),
                ...state.openInterviewRequests.values(),
              ],
              outcomes: knownIds.map((requestId) => ({
                requestId,
                status: state.replay?.requestId === requestId || state.openInterviewRequests.has(requestId)
                  ? "open"
                  : state.terminalInterviewStatuses.get(requestId)
                    ?? (state.replayRequestId === requestId && state.terminalReplayStatus
                      ? state.terminalReplayStatus
                      : "missing"),
              })),
              syncComplete: true,
            });
            this.emit({
              type: "sudo_snapshot",
              session_id: this.sessionId,
              selection_id: this.selectionId,
              sessionId: this.sessionId,
              requests: [],
              syncComplete: true,
            });
          }
        } catch {
          // The production client only sends JSON over this socket.
        }
      }

      close(): void {
        if (this.readyState === MockWebSocket.CLOSED) return;
        this.readyState = MockWebSocket.CLOSED;
        this.onclose?.(new Event("close"));
      }

      emit(payload: Record<string, unknown>): void {
        this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(payload) }));
      }
    }

    (window as unknown as { WebSocket: typeof MockWebSocket }).WebSocket = MockWebSocket;
    (window as unknown as { __interviewSocketTest: typeof state & {
      emit: (payload: Record<string, unknown>) => void;
      closeLatest: () => void;
      clearReplay: () => void;
      markSubmitted: (requestId: string) => void;
    } }).__interviewSocketTest = Object.assign(state, {
      emit(payload: Record<string, unknown>) {
        const currentSocket = state.sockets.at(-1);
        if (
          (payload.type === "interview_response_ack" || payload.type === "interview_cancel_ack")
          && currentSocket
        ) {
          payload = {
            session_id: currentSocket.sessionId,
            selection_id: currentSocket.selectionId,
            ...payload,
          };
        }
        if (
          payload.type === "interview_request"
          && typeof payload.requestId === "string"
          && (payload.session_id === undefined || payload.session_id === currentSocket?.sessionId)
        ) {
          state.openInterviewRequests.set(payload.requestId, {
            requestId: payload.requestId,
            sessionId: payload.sessionId,
            questions: payload.questions,
            createdAt: payload.createdAt,
          });
        }
        if (
          ((payload.type === "interview_response_ack" && payload.status !== "rejected")
            || (payload.type === "interview_cancel_ack" && payload.status === "cancelled"))
          && typeof payload.requestId === "string"
        ) {
          state.openInterviewRequests.delete(payload.requestId);
          state.terminalInterviewStatuses.set(
            payload.requestId,
            payload.type === "interview_response_ack"
              ? payload.status === "delivered" ? "delivered" : "submitted"
              : "cancelled",
          );
        }
        state.sockets.at(-1)?.emit(payload);
      },
      closeLatest() {
        state.sockets.at(-1)?.close();
      },
      clearReplay() {
        state.replay = null;
        state.terminalReplayStatus = "cancelled";
      },
      markSubmitted(requestId: string) {
        state.openInterviewRequests.delete(requestId);
        state.terminalInterviewStatuses.set(requestId, "submitted");
      },
    });
  }, { replay: replayOnSync });
}

test("authoritative interview sync replays a missed open questionnaire idempotently", async ({ page, request }) => {
  const session = await createE2eSession(request, "e2e interview sync replay");
  await installInterviewSocketMock(page, {
    requestId: "e2e-interview-replayed",
    prompt: "Replayed durable questionnaire",
  });
  await openSessionInUi(page, session);

  await expect(page.getByTestId("interview-form")).toContainText("Replayed durable questionnaire");
  await page.evaluate((sessionId) => {
    const state = (window as unknown as { __interviewSocketTest: {
      sockets: Array<{ selectionId: string | null }>;
      emit: (payload: Record<string, unknown>) => void;
    } }).__interviewSocketTest;
    state.emit({
      type: "interview_request",
      session_id: "stale-other-session",
      selection_id: state.sockets.at(-1)?.selectionId,
      requestId: "stale-replayed-interview",
      sessionId,
      createdAt: 6,
      questions: [{
        id: "stale",
        label: "Stale",
        prompt: "Stale questionnaire must not appear",
        options: [],
        allowOther: true,
      }],
    });
  }, session.id);
  await expect(page.getByText("Stale questionnaire must not appear", { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate((sessionId) => {
    const state = (window as unknown as { __interviewSocketTest: { sent: Array<{ type?: string; session_id?: string; selection_id?: string }> } }).__interviewSocketTest;
    return state.sent.filter((message) => (
      message.type === "interactive_state_sync_request"
      && message.session_id === sessionId
      && typeof message.selection_id === "string"
    )).length;
  }, session.id)).toBeGreaterThanOrEqual(1);
  await page.evaluate(() => {
    const state = (window as unknown as { __interviewSocketTest: {
      sockets: Array<{ sessionId: string; selectionId: string | null }>;
      emit: (payload: Record<string, unknown>) => void;
    } }).__interviewSocketTest;
    const socket = state.sockets.at(-1)!;
    state.emit({
      type: "session_ready",
      session_id: socket.sessionId,
      selection_id: socket.selectionId,
    });
  });
  await expect(page.getByTestId("interview-form")).toHaveCount(1);
  await expect(page.getByTestId("interview-queue")).not.toContainText("Questionnaire 1 of 2");

  await page.evaluate(() => {
    const state = (window as unknown as { __interviewSocketTest: {
      sockets: Array<{ sessionId: string; selectionId: string | null }>;
      emit: (payload: Record<string, unknown>) => void;
      clearReplay: () => void;
    } }).__interviewSocketTest;
    state.clearReplay();
    const socket = state.sockets.at(-1)!;
    state.emit({ type: "session_ready", session_id: socket.sessionId, selection_id: socket.selectionId });
  });
  await expect(page.getByTestId("interview-form")).toHaveCount(0);

  await page.evaluate(() => {
    const state = (window as unknown as { __interviewSocketTest: {
      sockets: Array<{ sessionId: string; selectionId: string | null }>;
      emit: (payload: Record<string, unknown>) => void;
    } }).__interviewSocketTest;
    const socket = state.sockets.at(-1)!;
    state.emit({
      type: "sudo_snapshot",
      session_id: socket.sessionId,
      selection_id: socket.selectionId,
      sessionId: socket.sessionId,
      requests: [{
        type: "sudo_request",
        session_id: socket.sessionId,
        selection_id: socket.selectionId,
        requestId: "replayed-sudo-request",
        sessionId: socket.sessionId,
        prompt: "Replayed pending sudo request",
        kind: "approval",
      }],
      syncComplete: true,
    });
  });
  await expect(page.getByText("Replayed pending sudo request", { exact: true })).toBeVisible();
  await page.evaluate(() => {
    const state = (window as unknown as { __interviewSocketTest: {
      sockets: Array<{ sessionId: string; selectionId: string | null }>;
      emit: (payload: Record<string, unknown>) => void;
    } }).__interviewSocketTest;
    const socket = state.sockets.at(-1)!;
    state.emit({
      type: "sudo_snapshot",
      session_id: socket.sessionId,
      selection_id: socket.selectionId,
      sessionId: socket.sessionId,
      requests: [],
      syncComplete: true,
    });
  });
  await expect(page.getByText("Replayed pending sudo request", { exact: true })).toHaveCount(0);
});

test("a dropped response ack converges through an immediate authoritative status check", async ({ page, request }) => {
  await installInterviewSocketMock(page);
  const session = await createE2eSession(request, "e2e immediate durable interview convergence");
  await openSessionInUi(page, session);

  await page.evaluate(({ sessionId, requestId }) => {
    const state = (window as unknown as { __interviewSocketTest: {
      emit: (payload: Record<string, unknown>) => void;
    } }).__interviewSocketTest;
    state.emit({
      type: "interview_request",
      requestId,
      sessionId,
      createdAt: 10,
      questions: [{
        id: "durable",
        label: "Durable",
        prompt: "Dropped acknowledgement question",
        options: [{ value: "yes", label: "Yes" }],
        allowOther: false,
      }],
    });
  }, { sessionId: session.id, requestId: firstRequestId });

  await expect(page.getByTestId("interview-form")).toContainText("Dropped acknowledgement question");
  await page.getByRole("button", { name: /Yes/ }).click();
  await expect.poll(() => page.evaluate((requestId) => {
    const state = (window as unknown as { __interviewSocketTest: {
      sent: Array<Record<string, unknown>>;
    } }).__interviewSocketTest;
    return state.sent.filter((message) => (
      message.type === "interview_response" && message.requestId === requestId
    )).length;
  }, firstRequestId)).toBe(1);

  await page.evaluate((requestId) => {
    (window as unknown as { __interviewSocketTest: {
      markSubmitted: (id: string) => void;
    } }).__interviewSocketTest.markSubmitted(requestId);
  }, firstRequestId);

  await expect.poll(() => page.evaluate((requestId) => {
    const state = (window as unknown as { __interviewSocketTest: {
      sent: Array<Record<string, unknown>>;
    } }).__interviewSocketTest;
    return state.sent.filter((message) => (
      message.type === "interactive_state_sync_request"
      && Array.isArray(message.known_interview_request_ids)
      && message.known_interview_request_ids.includes(requestId)
    )).length;
  }, firstRequestId), { timeout: 4_000 }).toBeGreaterThanOrEqual(1);
  await expect(page.getByTestId("interview-form")).toHaveCount(0, { timeout: 4_000 });
  await expect.poll(() => page.evaluate((requestId) => {
    const state = (window as unknown as { __interviewSocketTest: {
      sent: Array<Record<string, unknown>>;
    } }).__interviewSocketTest;
    return state.sent.filter((message) => (
      message.type === "interview_response" && message.requestId === requestId
    )).length;
  }, firstRequestId)).toBe(1);
});

test("retains an immutable interview response through reconnect and advances the session queue only after its ack", async ({ page, request }) => {
  await installInterviewSocketMock(page);
  const session = await createE2eSession(request, "e2e durable interview");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await page.evaluate(({ sessionId, firstRequestId, secondRequestId }) => {
    const socket = (window as unknown as { __interviewSocketTest: { emit: (payload: Record<string, unknown>) => void } }).__interviewSocketTest;
    socket.emit({
      type: "interview_request",
      requestId: firstRequestId,
      sessionId,
      createdAt: 10,
      questions: [{
        id: "first",
        label: "First",
        prompt: "First durable question",
        options: [{ value: "yes", label: "Yes" }],
        allowOther: false,
      }],
    });
    socket.emit({
      type: "interview_request",
      requestId: secondRequestId,
      sessionId,
      createdAt: 20,
      questions: [{
        id: "second",
        label: "Second",
        prompt: "Second queued question",
        options: [{ value: "no", label: "No" }],
        allowOther: false,
      }],
    });
  }, { sessionId: session.id, firstRequestId, secondRequestId });

  await expect(page.getByTestId("interview-queue")).toContainText("Questionnaire 1 of 2");
  await expect(page.getByTestId("interview-form")).toContainText("First durable question");
  await page.getByRole("button", { name: /Yes/ }).click();
  await expect(page.getByTestId("interview-submission-status")).toContainText("waiting for durable acknowledgement");

  await expect.poll(async () => page.evaluate(() => {
    const state = (window as unknown as { __interviewSocketTest: { sent: Array<Record<string, unknown>> } }).__interviewSocketTest;
    return state.sent.filter((message) => message.type === "interview_response" && message.requestId === "e2e-interview-first").length;
  })).toBe(1);

  await page.evaluate(() => {
    (window as unknown as { __interviewSocketTest: { closeLatest: () => void } }).__interviewSocketTest.closeLatest();
  });
  await expect(page.getByTestId("interview-submission-status")).toContainText("Connection closed before acknowledgement");

  await expect.poll(async () => page.evaluate(() => {
    const state = (window as unknown as { __interviewSocketTest: { sent: Array<Record<string, unknown>> } }).__interviewSocketTest;
    return state.sent.filter((message) => message.type === "interview_response" && message.requestId === "e2e-interview-first").length;
  }), { timeout: 10_000 }).toBe(2);

  await page.evaluate(({ sessionId, firstRequestId }) => {
    const socket = (window as unknown as { __interviewSocketTest: { emit: (payload: Record<string, unknown>) => void } }).__interviewSocketTest;
    socket.emit({
      type: "interview_response_ack",
      requestId: firstRequestId,
      sessionId,
      status: "submitted",
    });
  }, { sessionId: session.id, firstRequestId });

  await expect(page.getByTestId("interview-form")).toContainText("Second queued question");
  await expect(page.getByTestId("interview-queue")).not.toContainText("Questionnaire 1 of 2");
  await expect.poll(async () => page.evaluate(({ sessionId, requestId }) => (
    window.sessionStorage.getItem(`wayang:interview-submission:${sessionId}`)?.includes(requestId) ?? false
  ), { sessionId: session.id, requestId: firstRequestId })).toBe(false);

});

test("drops a stale interview response when the request was already answered differently", async ({ page, request }) => {
  await installInterviewSocketMock(page);
  const session = await createE2eSession(request, "e2e conflicting interview");
  await openSessionInUi(page, session);
  await expect(page.getByTestId("chat-input")).toBeEnabled();

  await page.evaluate(({ sessionId, firstRequestId, secondRequestId }) => {
    const socket = (window as unknown as { __interviewSocketTest: { emit: (payload: Record<string, unknown>) => void } }).__interviewSocketTest;
    socket.emit({
      type: "interview_request",
      requestId: firstRequestId,
      sessionId,
      createdAt: 10,
      questions: [{
        id: "first",
        label: "First",
        prompt: "First durable question",
        options: [{ value: "yes", label: "Yes" }],
        allowOther: false,
      }],
    });
    socket.emit({
      type: "interview_request",
      requestId: secondRequestId,
      sessionId,
      createdAt: 20,
      questions: [{
        id: "second",
        label: "Second",
        prompt: "Second queued question",
        options: [{ value: "no", label: "No" }],
        allowOther: false,
      }],
    });
  }, { sessionId: session.id, firstRequestId, secondRequestId });

  await expect(page.getByTestId("interview-queue")).toContainText("Questionnaire 1 of 2");
  await expect(page.getByTestId("interview-form")).toContainText("First durable question");
  await page.getByRole("button", { name: /Yes/ }).click();
  await expect(page.getByTestId("interview-submission-status")).toContainText("waiting for durable acknowledgement");
  await expect.poll(async () => page.evaluate((requestId) => (
    window.sessionStorage.getItem(`wayang-interview-draft:${requestId}`) !== null
  ), firstRequestId)).toBe(true);

  const unrelatedRequestId = "e2e-interview-unrelated";
  await page.evaluate(({ sessionId, unrelatedRequestId }) => {
    const storageKey = `wayang:interview-submission:${sessionId}`;
    const stored = JSON.parse(window.sessionStorage.getItem(storageKey) ?? "[]") as unknown[];
    stored.push({
      requestId: unrelatedRequestId,
      sessionId,
      questions: [{
        id: "unrelated",
        label: "Unrelated",
        prompt: "Unrelated cached question",
        options: [{ value: "yes", label: "Yes" }],
        allowOther: true,
      }],
      answers: [{ id: "unrelated", value: "yes", label: "Yes", wasCustom: false, index: 1 }],
      submittedAt: Date.now(),
    });
    window.sessionStorage.setItem(storageKey, JSON.stringify(stored));
  }, { sessionId: session.id, unrelatedRequestId });

  await page.evaluate(({ sessionId, firstRequestId }) => {
    const socket = (window as unknown as { __interviewSocketTest: { emit: (payload: Record<string, unknown>) => void } }).__interviewSocketTest;
    socket.emit({
      type: "interview_response_ack",
      requestId: firstRequestId,
      sessionId,
      status: "rejected",
      errorCode: "invalid_answers",
      error: "Synthetic retryable rejection",
    });
  }, { sessionId: session.id, firstRequestId });

  await expect(page.getByTestId("interview-form")).toContainText("First durable question");
  await expect(page.getByTestId("interview-retry-button")).toBeVisible();

  await page.evaluate(({ sessionId, firstRequestId }) => {
    const socket = (window as unknown as { __interviewSocketTest: { emit: (payload: Record<string, unknown>) => void } }).__interviewSocketTest;
    socket.emit({
      type: "interview_response_ack",
      requestId: firstRequestId,
      sessionId,
      status: "rejected",
      errorCode: "conflict",
      error: "Interview was already submitted with different answers",
    });
  }, { sessionId: session.id, firstRequestId });

  await expect(page.getByTestId("interview-form")).toContainText("Second queued question");
  await expect(page.getByTestId("interview-queue")).not.toContainText("Questionnaire 1 of 2");
  await expect.poll(async () => page.evaluate(({ sessionId, requestId }) => (
    window.sessionStorage.getItem(`wayang:interview-submission:${sessionId}`)?.includes(requestId) ?? false
  ), { sessionId: session.id, requestId: firstRequestId })).toBe(false);
  await expect.poll(async () => page.evaluate(({ sessionId, requestId }) => (
    window.sessionStorage.getItem(`wayang:interview-submission:${sessionId}`)?.includes(requestId) ?? false
  ), { sessionId: session.id, requestId: unrelatedRequestId })).toBe(true);
  await expect.poll(async () => page.evaluate((requestId) => (
    window.sessionStorage.getItem(`wayang-interview-draft:${requestId}`)
  ), firstRequestId)).toBeNull();
});
