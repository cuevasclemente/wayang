import { expect, test } from "@playwright/test";
import { createE2eSession, openSessionInUi } from "./helpers/sessions";

const firstRequestId = "e2e-interview-first";
const secondRequestId = "e2e-interview-second";

async function installInterviewSocketMock(page: import("@playwright/test").Page): Promise<void> {
  await page.addInitScript(() => {
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
          state.sent.push(JSON.parse(data) as Record<string, unknown>);
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
    } }).__interviewSocketTest = Object.assign(state, {
      emit(payload: Record<string, unknown>) {
        state.sockets.at(-1)?.emit(payload);
      },
      closeLatest() {
        state.sockets.at(-1)?.close();
      },
    });
  });
}

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
