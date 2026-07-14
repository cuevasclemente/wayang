import { randomUUID } from "node:crypto";
import { flush, getStore, type InterviewRecord as StoredInterviewRecord } from "./db.js";

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
  | { ok: false; code: "not_found" | "wrong_session" | "cancelled" | "conflict" | "invalid_answers"; message: string };

function clone<T>(value: T): T {
  return structuredClone(value);
}

function invalid(message: string): never {
  throw new Error(`Invalid interview request: ${message}`);
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
      // Stored interviews may predate universal free-text support and retain
      // allowOther: false, so this intentionally does not consult that flag.
      return { id: question.id, value, label: value, wasCustom: true };
    }

    const optionIndex = question.options.findIndex((option) => option.value === value);
    if (optionIndex < 0) throw new Error(`Answer for ${question.id} is not an allowed option`);
    const option = question.options[optionIndex]!;
    return { id: question.id, value: option.value, label: option.label, wasCustom: false, index: optionIndex };
  });
}

function records(): InterviewRecord[] {
  return getStore().interviews as InterviewRecord[];
}

export function createOpenInterview(input: CreateOpenInterviewInput): InterviewRecord {
  const sessionId = input.sessionId.trim();
  if (!sessionId) throw new Error("Interview session ID is required");
  const requestId = input.requestId?.trim() || randomUUID();
  if (records().some((record) => record.request_id === requestId)) throw new Error("Interview request ID already exists");
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
  records().push(record);
  flush();
  return clone(record);
}

export function getInterviewForSession(sessionId: string, requestId: string): InterviewRecord | undefined {
  const record = records().find((candidate) => candidate.request_id === requestId && candidate.session_id === sessionId);
  return record ? clone(record) : undefined;
}

export function getInterview(requestId: string): InterviewRecord | undefined {
  const record = records().find((candidate) => candidate.request_id === requestId);
  return record ? clone(record) : undefined;
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

export function submitInterview(sessionId: string, requestId: string, rawAnswers: unknown): SubmitInterviewResult {
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

  record.answers = answers;
  record.submission_id = randomUUID();
  record.submitted_at = Date.now();
  record.status = "submitted";
  flush();
  return { ok: true, kind: "accepted", record: clone(record) };
}

export function cancelInterview(sessionId: string, requestId: string): InterviewRecord | undefined {
  const record = records().find((candidate) => candidate.request_id === requestId && candidate.session_id === sessionId);
  if (!record || record.status !== "open") return undefined;
  record.status = "cancelled";
  record.cancelled_at = Date.now();
  flush();
  return clone(record);
}

export function markDelivered(requestId: string, mode: "tool_result" | "custom_message", entryId?: string): InterviewRecord | undefined {
  const record = records().find((candidate) => candidate.request_id === requestId);
  if (!record || record.status === "cancelled") return undefined;
  if (record.status === "delivered") return clone(record);
  if (record.status !== "submitted") return undefined;
  record.status = "delivered";
  record.delivered_at = Date.now();
  record.delivery_mode = mode;
  if (entryId) record.delivery_entry_id = entryId;
  flush();
  return clone(record);
}

export function removeInterviewsForSession(sessionId: string, options: { flush?: boolean } = {}): number {
  const store = getStore();
  const before = store.interviews.length;
  store.interviews = store.interviews.filter((record) => record.session_id !== sessionId);
  const removed = before - store.interviews.length;
  if (removed && options.flush !== false) flush();
  return removed;
}
