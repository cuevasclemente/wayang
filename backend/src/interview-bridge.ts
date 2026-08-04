/**
 * In-memory accelerator for durable web interview requests.
 *
 * Request/submission state lives in interviews.ts. This bridge only keeps an
 * active tool call waiting long enough to return the original tool result.
 */

import {
  createOpenInterview,
  getInterviewForSession,
  listOpenInterviews,
  type CreateOpenInterviewInput,
  type InterviewAnswer,
  type InterviewQuestion,
  type InterviewRecord,
} from "./interviews.js";
import {
  WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL,
  WAYANG_WEBSOCKET_SUBMISSION_CHANNEL,
} from "./interview-provenance.js";

export type { InterviewAnswer, InterviewQuestion } from "./interviews.js";

export interface InterviewRequest {
  requestId: string;
  sessionId: string;
  questions: InterviewQuestion[];
  createdAt: number;
}

export type InterviewWaitOutcome =
  | {
    status: "submitted";
    request: InterviewRequest;
    submission: { submissionId: string };
    answers: InterviewAnswer[];
  }
  | { status: "pending"; request: InterviewRequest }
  | { status: "cancelled"; request: InterviewRequest };

export interface CreateInterviewRequestOptions {
  toolName?: "interview" | "questionnaire";
  toolCallId?: string | null;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  timeoutMs?: number;
}

interface PendingInterview {
  request: InterviewRequest;
  resolve: (outcome: InterviewWaitOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

type RequestCallback = (req: InterviewRequest) => void;

interface InterviewBridgeStore {
  getInterviewForSession: typeof getInterviewForSession;
}

const DEFAULT_INTERVIEW_BRIDGE_STORE: InterviewBridgeStore = {
  getInterviewForSession,
};

function requestFrom(record: InterviewRecord): InterviewRequest {
  return {
    requestId: record.request_id,
    sessionId: record.session_id,
    questions: record.questions,
    createdAt: record.created_at,
  };
}

export class PiInterviewBridge {
  private pending = new Map<string, PendingInterview>();
  private listeners = new Set<RequestCallback>();
  private toolResultHandoffs = new Map<string, string>();

  constructor(private readonly store: InterviewBridgeStore = DEFAULT_INTERVIEW_BRIDGE_STORE) {}

  /**
   * Durable request API for updated extensions. On grace expiry the request
   * remains open on disk and the tool receives `pending`, never `cancelled`.
   */
  createRequestWithOutcome(
    sessionId: string,
    questions: InterviewQuestion[],
    options: CreateInterviewRequestOptions = {},
  ): Promise<InterviewWaitOutcome> {
    const record = createOpenInterview({
      sessionId,
      questions,
      toolName: options.toolName ?? "interview",
      toolCallId: options.toolCallId,
      piSessionId: options.piSessionId,
      piSessionFile: options.piSessionFile,
    } satisfies CreateOpenInterviewInput);
    const request = requestFrom(record);
    const timeoutMs = options.timeoutMs ?? 120_000;

    return new Promise<InterviewWaitOutcome>((resolve) => {
      const timer = setTimeout(() => {
        const pending = this.pending.get(request.requestId);
        if (!pending) return;
        this.pending.delete(request.requestId);
        resolve({ status: "pending", request });
      }, timeoutMs);
      this.pending.set(request.requestId, { request, resolve, timer });
      for (const listener of this.listeners) {
        try { listener(request); } catch { /* listener isolation */ }
      }
    });
  }

  /**
   * Legacy extension compatibility. New extensions must use
   * createRequestWithOutcome so a timeout can be reported as pending. The
   * request is nevertheless durable in both cases, allowing a late submit to
   * be delivered as a custom message.
   */
  async createRequest(sessionId: string, questions: InterviewQuestion[], timeoutMs = 120_000): Promise<InterviewAnswer[]> {
    const outcome = await this.createRequestWithOutcome(sessionId, questions, { timeoutMs });
    return outcome.status === "submitted" ? outcome.answers : [];
  }

  /** Resolve exactly the live waiter for a durably accepted submission. */
  resolveSubmitted(record: InterviewRecord): boolean {
    const pending = this.pending.get(record.request_id);
    if (!pending || pending.request.sessionId !== record.session_id || !record.submission_id) return false;

    const authoritative = this.store.getInterviewForSession(pending.request.sessionId, pending.request.requestId);
    if (
      !authoritative
      || authoritative.status !== "submitted"
      || authoritative.submission_id !== record.submission_id
      || authoritative.submission_channel !== WAYANG_WEBSOCKET_SUBMISSION_CHANNEL
      || authoritative.authenticated_principal !== WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL
      || !authoritative.answers
    ) return false;

    // Keep the record submitted until the exact matching Pi tool-result entry
    // is visible in the persisted branch. A crash before then remains
    // recoverable through delayed custom-message delivery.
    this.toolResultHandoffs.set(authoritative.request_id, authoritative.session_id);
    clearTimeout(pending.timer);
    this.pending.delete(authoritative.request_id);
    pending.resolve({
      status: "submitted",
      request: pending.request,
      submission: { submissionId: authoritative.submission_id },
      answers: authoritative.answers,
    });
    return true;
  }

  hasToolResultHandoff(sessionId: string, requestId: string): boolean {
    return this.toolResultHandoffs.get(requestId) === sessionId;
  }

  completeToolResultHandoff(sessionId: string, requestId: string): void {
    if (this.toolResultHandoffs.get(requestId) === sessionId) this.toolResultHandoffs.delete(requestId);
  }

  /** Explicit cancellation is terminal only while the original waiter is live. */
  cancel(requestId: string): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    clearTimeout(pending.timer);
    this.pending.delete(requestId);
    pending.resolve({ status: "cancelled", request: pending.request });
    return true;
  }

  /** Session teardown never erases durable records or submitted answers. */
  cancelSession(sessionId: string): void {
    for (const [id, pending] of this.pending) {
      if (pending.request.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      pending.resolve({ status: "cancelled", request: pending.request });
    }
    for (const [requestId, ownerSessionId] of this.toolResultHandoffs) {
      if (ownerSessionId === sessionId) this.toolResultHandoffs.delete(requestId);
    }
  }

  onRequest(callback: RequestCallback): () => void {
    this.listeners.add(callback);
    return () => this.listeners.delete(callback);
  }

  /** Durable replay source for WebSocket reconnects, ordered by creation. */
  getPendingRequests(sessionId: string): InterviewRequest[] {
    return listOpenInterviews(sessionId).map(requestFrom);
  }

  getRequest(sessionId: string, requestId: string): InterviewRequest | undefined {
    const record = this.store.getInterviewForSession(sessionId, requestId);
    return record ? requestFrom(record) : undefined;
  }
}

/** Get or create the singleton bridge shared with web-mode extensions. */
export function getInterviewBridge(): PiInterviewBridge {
  if (!(globalThis as any).__pi_interview_bridge) {
    (globalThis as any).__pi_interview_bridge = new PiInterviewBridge();
  }
  return (globalThis as any).__pi_interview_bridge;
}
