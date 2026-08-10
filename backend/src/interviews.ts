import { randomUUID } from "node:crypto";
import { commitStoreMutation, getStore, type InterviewRecord as StoredInterviewRecord, type StoreData } from "./db.js";
import {
  isWayangWebSocketSubmissionContext,
  WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL,
  WAYANG_WEBSOCKET_SUBMISSION_CHANNEL,
  type InterviewSubmissionContext,
} from "./interview-provenance.js";
import {
  isBoundedHumanAttentionId,
  MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION,
} from "./human-attention.js";
import { notifySessionSummaryProjectionChanged } from "./sessions.js";

export type InterviewStatus = "open" | "submitted" | "cancelled" | "delivered";
export type InterviewToolName = "interview" | "questionnaire";

export interface QuestionOption {
  value: string;
  label: string;
  description?: string;
}

export interface InterviewQuestion {
  id: string;
  label: string;
  prompt: string;
  options: QuestionOption[];
  allowOther: boolean;
}

export interface InterviewAnswer {
  id: string;
  value: string;
  label: string;
  wasCustom: boolean;
  index?: number;
}

export interface InterviewRecord extends Omit<StoredInterviewRecord, "questions" | "answers" | "status"> {
  questions: InterviewQuestion[];
  answers?: InterviewAnswer[];
  status: InterviewStatus;
}

export interface CreateOpenInterviewInput {
  requestId?: string;
  sessionId: string;
  piSessionId?: string | null;
  piSessionFile?: string | null;
  toolName: InterviewToolName;
  toolCallId?: string | null;
  questions: unknown;
}

export type SubmitInterviewResult =
  | { ok: true; kind: "accepted" | "duplicate"; record: InterviewRecord }
  | { ok: false; code: "unauthorized_submission" | "not_found" | "wrong_session" | "cancelled" | "conflict" | "invalid_answers"; message: string };

type InterviewMutationCommit = <T>(mutate: (draft: StoreData) => T) => T;
const interviewMutationCommit: InterviewMutationCommit = commitStoreMutation;

function clone<T>(value: T): T {
  return structuredClone(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid interview request: ${message}`);
}

function boundedAttentionId(value: string, label: string): string {
  const normalized = value.trim();
  if (!isBoundedHumanAttentionId(normalized)) invalid(`${label} is invalid or too long`);
  return normalized;
}

export function normalizeQuestions(raw: unknown): InterviewQuestion[] {
  if (!Array.isArray(raw) || raw.length === 0) invalid("questions must be a non-empty array");
  const ids = new Set<string>();
  return raw.map((item, questionIndex) => {
    if (!item || typeof item !== "object") invalid(`question ${questionIndex + 1} must be an object`);
    const value = item as Record<string, unknown>;
    const id = typeof value.id === "string" ? value.id.trim() : "";
    const label = typeof value.label === "string" ? value.label.trim() : "";
    const prompt = typeof value.prompt === "string" ? value.prompt.trim() : "";
    if (!id || ids.has(id)) invalid(`question ${questionIndex + 1} has an invalid or duplicate id`);
    if (!label || !prompt) invalid(`question ${id} requires a label and prompt`);
    // Free-text answers are always available, regardless of a caller's legacy
    // allowOther value. This also permits free-text-only questions.
    const allowOther = true;
    if (!Array.isArray(value.options)) invalid(`question ${id} requires options`);
    const optionValues = new Set<string>();
    const options = value.options.map((rawOption, optionIndex) => {
      if (!rawOption || typeof rawOption !== "object") invalid(`option ${optionIndex + 1} for ${id} must be an object`);
      const option = rawOption as Record<string, unknown>;
      const optionValue = typeof option.value === "string" ? option.value : "";
      const optionLabel = typeof option.label === "string" ? option.label : "";
      if (!optionValue || optionValues.has(optionValue) || !optionLabel) invalid(`option ${optionIndex + 1} for ${id} is invalid`);
      optionValues.add(optionValue);
      return {
        value: optionValue,
        label: optionLabel,
        ...(typeof option.description === "string" && option.description ? { description: option.description } : {}),
      };
    });
    ids.add(id);
    return { id, label, prompt, options, allowOther };
  });
}

export function normalizeAnswers(questions: InterviewQuestion[], raw: unknown): InterviewAnswer[] {
  if (!Array.isArray(raw) || raw.length !== questions.length) {
    throw new Error("Answers must contain exactly one answer for every question");
  }

  const questionsById = new Map(questions.map((question) => [question.id, question]));
  const answersById = new Map<string, Record<string, unknown>>();
  raw.forEach((rawAnswer, index) => {
    if (!rawAnswer || typeof rawAnswer !== "object") throw new Error(`Answer ${index + 1} must be an object`);
    const answer = rawAnswer as Record<string, unknown>;
    const id = typeof answer.id === "string" ? answer.id : "";
    if (!questionsById.has(id)) throw new Error(`Answer references an unknown question: ${id || "(missing id)"}`);
    if (answersById.has(id)) throw new Error(`Answer for ${id} was provided more than once`);
    answersById.set(id, answer);
  });

  // Iterate over questions—not the submitted array—to persist and return the
  // original question order even when clients submit answers in any order.
  return questions.map((question) => {
    const answer = answersById.get(question.id);
    if (!answer) throw new Error(`Answer for ${question.id} is required`);
    const value = typeof answer.value === "string" ? answer.value.trim() : "";
    if (!value) throw new Error(`Answer for ${question.id} is required`);

    if (answer.wasCustom === true) {
      return { id: question.id, value, label: value, wasCustom: true };
    }

    const optionIndex = question.options.findIndex((option) => option.value === value);
    if (optionIndex < 0) throw new Error(`Answer for ${question.id} is not an allowed option`);
    const option = question.options[optionIndex]!;
    return { id: question.id, value: option.value, label: option.label, wasCustom: false, index: optionIndex };
  });
}

function records(store = getStore()): InterviewRecord[] {
  return store.interviews as InterviewRecord[];
}

export function createOpenInterview(input: CreateOpenInterviewInput): InterviewRecord {
  const sessionId = boundedAttentionId(input.sessionId, "session ID");
  const requestId = boundedAttentionId(input.requestId?.trim() || randomUUID(), "request ID");
  const record: InterviewRecord = {
    request_id: requestId,
    session_id: sessionId,
    pi_session_id: input.piSessionId ?? null,
    pi_session_file: input.piSessionFile ?? null,
    origin_tool_name: input.toolName,
    origin_tool_call_id: input.toolCallId ?? null,
    questions: normalizeQuestions(input.questions),
    status: "open",
    created_at: Date.now(),
  };
  const created = interviewMutationCommit((draft) => {
    if (records(draft).some((candidate) => candidate.request_id === requestId)) throw new Error("Interview request ID already exists");
    const pendingForSession = records(draft).filter((candidate) => candidate.session_id === sessionId && candidate.status === "open").length;
    if (pendingForSession >= MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION) {
      throw new Error("Too many pending interview requests for this session");
    }
    records(draft).push(clone(record));
    return clone(record);
  });
  notifySessionSummaryProjectionChanged();
  return created;
}

export function getInterviewForSession(sessionId: string, requestId: string): InterviewRecord | undefined {
  const record = records().find((candidate) => candidate.request_id === requestId && candidate.session_id === sessionId);
  return record ? clone(record) : undefined;
}

export function getInterview(requestId: string): InterviewRecord | undefined {
  const record = records().find((candidate) => candidate.request_id === requestId);
  return record ? clone(record) : undefined;
}

export interface VerifiedInterviewSubmissionEvidence {
  source: "tool_result" | "custom_message";
  requestId: string;
  submissionId: string;
  submittedAt: number;
  toolName: InterviewToolName;
  questions: InterviewQuestion[];
  answers: InterviewAnswer[];
}

function evidenceFromRecord(record: InterviewRecord, source: VerifiedInterviewSubmissionEvidence["source"]): VerifiedInterviewSubmissionEvidence | undefined {
  if (!record.submission_id || !record.submitted_at || !record.answers) return undefined;
  return {
    source,
    requestId: record.request_id,
    submissionId: record.submission_id,
    submittedAt: record.submitted_at,
    toolName: record.origin_tool_name,
    questions: clone(record.questions),
    answers: clone(record.answers),
  };
}

/** Resolve a Pi form-delivery entry to canonical durable WebSocket-authenticated evidence. */
export function resolveInterviewSubmissionEvidence(sessionId: string, entry: unknown): VerifiedInterviewSubmissionEvidence | undefined {
  try {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) return undefined;
    const candidate = entry as Record<string, unknown>;
    if (candidate.type === "custom_message" && candidate.customType === "wayang-interview-submission") {
      const details = candidate.details;
      if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
      const value = details as Record<string, unknown>;
      if (value.session_id !== sessionId || typeof value.request_id !== "string") return undefined;
      const record = getInterviewForSession(sessionId, value.request_id);
      if (!record || (record.status !== "submitted" && record.status !== "delivered")) return undefined;
      if (record.submission_channel !== WAYANG_WEBSOCKET_SUBMISSION_CHANNEL || record.authenticated_principal !== WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL) return undefined;
      if (value.submission_id !== record.submission_id || value.origin_tool_name !== record.origin_tool_name) return undefined;
      if ((value.origin_tool_call_id ?? null) !== (record.origin_tool_call_id ?? null)) return undefined;
      if (value.created_at !== record.created_at || value.submitted_at !== record.submitted_at) return undefined;
      if (JSON.stringify(value.questions) !== JSON.stringify(record.questions)) return undefined;
      if (JSON.stringify(value.answers) !== JSON.stringify(record.answers ?? [])) return undefined;
      if (record.status === "delivered") {
        if (record.delivery_mode !== "custom_message" || typeof candidate.id !== "string") return undefined;
        if (record.delivery_entry_id !== candidate.id) return undefined;
      }
      return evidenceFromRecord(record, "custom_message");
    }

    if (candidate.type !== "message") return undefined;
    const message = candidate.message;
    if (!message || typeof message !== "object" || Array.isArray(message)) return undefined;
    const value = message as Record<string, unknown>;
    if (value.role !== "toolResult" || (value.toolName !== "interview" && value.toolName !== "questionnaire")) return undefined;
    const details = value.details;
    if (!details || typeof details !== "object" || Array.isArray(details)) return undefined;
    const result = details as Record<string, unknown>;
    if (result.status !== "submitted" || typeof result.requestId !== "string" || typeof result.submissionId !== "string") return undefined;
    const record = getInterviewForSession(sessionId, result.requestId);
    if (!record || (record.status !== "submitted" && !(record.status === "delivered" && record.delivery_mode === "tool_result"))) return undefined;
    if (record.submission_channel !== WAYANG_WEBSOCKET_SUBMISSION_CHANNEL || record.authenticated_principal !== WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL) return undefined;
    if (result.submissionId !== record.submission_id || value.toolName !== record.origin_tool_name) return undefined;
    if (record.origin_tool_call_id) {
      if (value.toolCallId !== record.origin_tool_call_id) return undefined;
    } else if (typeof value.toolCallId !== "string" || !value.toolCallId) {
      return undefined;
    }
    if (JSON.stringify(normalizeQuestions(result.questions)) !== JSON.stringify(record.questions)) return undefined;
    if (JSON.stringify(result.answers) !== JSON.stringify(record.answers ?? [])) return undefined;
    if (record.status === "delivered") {
      if (typeof candidate.id !== "string" || record.delivery_entry_id !== candidate.id) return undefined;
    }
    return evidenceFromRecord(record, "tool_result");
  } catch {
    return undefined;
  }
}

export function verifyInterviewSubmissionEntry(sessionId: string, entry: unknown): boolean {
  return Boolean(resolveInterviewSubmissionEvidence(sessionId, entry));
}

export function listOpenInterviews(sessionId: string): InterviewRecord[] {
  return records()
    .filter((record) => record.session_id === sessionId && record.status === "open")
    .sort((a, b) => a.created_at - b.created_at)
    .map(clone);
}

export function listSubmittedUndeliveredInterviews(sessionId?: string): InterviewRecord[] {
  return records()
    .filter((record) => record.status === "submitted" && (!sessionId || record.session_id === sessionId))
    .sort((a, b) => a.submitted_at! - b.submitted_at!)
    .map(clone);
}

function sameAnswers(a: InterviewAnswer[] | undefined, b: InterviewAnswer[]): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b);
}

export function submitInterview(
  sessionId: string,
  requestId: string,
  rawAnswers: unknown,
  context: InterviewSubmissionContext,
): SubmitInterviewResult {
  if (!isWayangWebSocketSubmissionContext(context)) {
    return { ok: false, code: "unauthorized_submission", message: "Interview submission requires the authorized Wayang WebSocket boundary" };
  }

  const record = records().find((candidate) => candidate.request_id === requestId);
  if (!record) return { ok: false, code: "not_found", message: "Interview request was not found" };
  if (record.session_id !== sessionId) return { ok: false, code: "wrong_session", message: "Interview request belongs to another session" };
  if (record.status === "cancelled") return { ok: false, code: "cancelled", message: "Interview request was cancelled" };

  let answers: InterviewAnswer[];
  try {
    answers = normalizeAnswers(record.questions, rawAnswers);
  } catch (error) {
    return { ok: false, code: "invalid_answers", message: error instanceof Error ? error.message : "Invalid answers" };
  }

  if (record.status === "submitted" || record.status === "delivered") {
    if (!sameAnswers(record.answers, answers)) {
      return { ok: false, code: "conflict", message: "Interview was already submitted with different answers" };
    }
    return { ok: true, kind: "duplicate", record: clone(record) };
  }

  const submissionId = randomUUID();
  const submittedAt = Date.now();
  const committed = interviewMutationCommit((draft) => {
    const target = records(draft).find((candidate) => candidate.request_id === requestId);
    if (!target || target.session_id !== sessionId || target.status !== "open") {
      throw new Error("Interview state changed before submission could be persisted");
    }
    target.answers = clone(answers);
    target.submission_id = submissionId;
    target.submission_channel = context.submission_channel;
    target.authenticated_principal = context.authenticated_principal;
    target.submitted_at = submittedAt;
    target.status = "submitted";
    return clone(target);
  });
  notifySessionSummaryProjectionChanged();
  return { ok: true, kind: "accepted", record: committed };
}

export function cancelInterview(sessionId: string, requestId: string): InterviewRecord | undefined {
  const record = records().find((candidate) => candidate.request_id === requestId && candidate.session_id === sessionId);
  if (!record || record.status !== "open") return undefined;
  const cancelled = interviewMutationCommit((draft) => {
    const target = records(draft).find((candidate) => candidate.request_id === requestId && candidate.session_id === sessionId);
    if (!target || target.status !== "open") return undefined;
    target.status = "cancelled";
    target.cancelled_at = Date.now();
    return clone(target);
  });
  if (cancelled) notifySessionSummaryProjectionChanged();
  return cancelled;
}

export function markDelivered(requestId: string, mode: "tool_result" | "custom_message", entryId?: string): InterviewRecord | undefined {
  const record = records().find((candidate) => candidate.request_id === requestId);
  if (!record || record.status === "cancelled") return undefined;
  if (record.status === "delivered") return clone(record);
  if (record.status !== "submitted") return undefined;
  return interviewMutationCommit((draft) => {
    const target = records(draft).find((candidate) => candidate.request_id === requestId);
    if (!target || target.status !== "submitted") return target?.status === "delivered" ? clone(target) : undefined;
    target.status = "delivered";
    target.delivered_at = Date.now();
    target.delivery_mode = mode;
    if (entryId) target.delivery_entry_id = entryId;
    return clone(target);
  });
}

export function removeInterviewsForSession(sessionId: string, _options: { flush?: boolean } = {}): number {
  const count = records().filter((record) => record.session_id === sessionId).length;
  if (count === 0) return 0;
  const removed = interviewMutationCommit((draft) => {
    const before = draft.interviews.length;
    draft.interviews = draft.interviews.filter((record) => record.session_id !== sessionId);
    return before - draft.interviews.length;
  });
  notifySessionSummaryProjectionChanged();
  return removed;
}
