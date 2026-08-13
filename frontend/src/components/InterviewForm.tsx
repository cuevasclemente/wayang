import { useState, useCallback, useEffect } from "react";
import { orderInterviewAnswers } from "./InterviewForm.helpers";

// ---------------------------------------------------------------------------
// Types (mirror the backend bridge types)
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export type InterviewSubmissionState = "submitting" | "retry" | "rejected";

interface InterviewFormProps {
  questions: InterviewQuestion[];
  onSubmit: (answers: InterviewAnswer[]) => void;
  onCancel: () => void;
  /**
   * A final response stays immutable and visible until the server sends an
   * interview_response_ack for this request. The parent owns retrying that
   * response because it also retains the request id and session ownership.
   */
  submissionState?: InterviewSubmissionState;
  submissionMessage?: string;
  onRetry?: () => void;
  /** Cancellation is pending until the exact interview_cancel_ack arrives. */
  cancellationState?: "cancelling" | "retry" | "rejected";
  cancellationMessage?: string;
  /**
   * Optional per-request key used to keep in-progress answers through mobile
   * orientation changes or websocket/UI remounts. Stored only in this tab's
   * sessionStorage and cleared by the parent only after the exact durable
   * submission or cancellation acknowledgement.
   */
  storageKey?: string;
}

interface StoredInterviewDraft {
  currentTab?: unknown;
  answers?: unknown;
  customInput?: unknown;
  customQuestionId?: unknown;
  questionIds?: unknown;
  savedAt?: unknown;
}

const MAX_DRAFT_AGE_MS = 12 * 60 * 60 * 1000;

function loadStoredDraft(
  storageKey: string | undefined,
  questions: InterviewQuestion[],
): {
  currentTab: number;
  answers: Map<string, InterviewAnswer>;
  customInput: string;
  customQuestionId: string | null;
} {
  const empty = {
    currentTab: 0,
    answers: new Map<string, InterviewAnswer>(),
    customInput: "",
    customQuestionId: null,
  };

  if (!storageKey || typeof window === "undefined") return empty;

  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return empty;

    const parsed = JSON.parse(raw) as StoredInterviewDraft;
    if (
      typeof parsed.savedAt === "number" &&
      Date.now() - parsed.savedAt > MAX_DRAFT_AGE_MS
    ) {
      window.sessionStorage.removeItem(storageKey);
      return empty;
    }

    const questionIds = questions.map((q) => q.id);
    if (
      Array.isArray(parsed.questionIds) &&
      parsed.questionIds.join("\u0000") !== questionIds.join("\u0000")
    ) {
      return empty;
    }

    const validIds = new Set(questionIds);
    const answers = new Map<string, InterviewAnswer>();
    const rawAnswers = Array.isArray(parsed.answers) ? parsed.answers : [];
    for (const rawAnswer of rawAnswers) {
      if (!rawAnswer || typeof rawAnswer !== "object") continue;
      const answer = rawAnswer as Partial<InterviewAnswer>;
      if (
        typeof answer.id !== "string" ||
        !validIds.has(answer.id) ||
        typeof answer.value !== "string" ||
        typeof answer.label !== "string" ||
        typeof answer.wasCustom !== "boolean"
      ) {
        continue;
      }
      answers.set(answer.id, {
        id: answer.id,
        value: answer.value,
        label: answer.label,
        wasCustom: answer.wasCustom,
        index: typeof answer.index === "number" ? answer.index : undefined,
      });
    }

    const currentTab =
      typeof parsed.currentTab === "number"
        ? Math.max(0, Math.min(parsed.currentTab, questions.length))
        : 0;
    const customQuestionId =
      typeof parsed.customQuestionId === "string" &&
      validIds.has(parsed.customQuestionId)
        ? parsed.customQuestionId
        : null;

    return {
      currentTab,
      answers,
      customInput: typeof parsed.customInput === "string" ? parsed.customInput : "",
      customQuestionId,
    };
  } catch {
    return empty;
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function InterviewForm({
  questions,
  onSubmit,
  onCancel,
  submissionState,
  submissionMessage,
  onRetry,
  cancellationState,
  cancellationMessage,
  storageKey,
}: InterviewFormProps) {
  const [initialDraft] = useState(() => loadStoredDraft(storageKey, questions));
  const awaitingAcknowledgement = Boolean(submissionState);
  const cancellationPending = cancellationState === "cancelling";
  const [currentTab, setCurrentTab] = useState(initialDraft.currentTab);
  const [answers, setAnswers] = useState<Map<string, InterviewAnswer>>(
    initialDraft.answers,
  );
  const [customInput, setCustomInput] = useState(initialDraft.customInput);
  const [customQuestionId, setCustomQuestionId] = useState<string | null>(
    initialDraft.customQuestionId,
  );

  const isMulti = questions.length > 1;

  const currentQuestion =
    currentTab < questions.length ? questions[currentTab] : null;

  const allAnswered = questions.every((q) => answers.has(q.id));

  useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;

    try {
      window.sessionStorage.setItem(
        storageKey,
        JSON.stringify({
          currentTab,
          answers: Array.from(answers.values()),
          customInput,
          customQuestionId,
          questionIds: questions.map((q) => q.id),
          savedAt: Date.now(),
        }),
      );
    } catch {
      // Ignore quota/security errors; the form still works without drafts.
    }
  }, [answers, currentTab, customInput, customQuestionId, questions, storageKey]);

  const submitAnswers = useCallback(
    (nextAnswers: InterviewAnswer[]) => {
      // The response draft is deliberately retained until the parent receives
      // a matching durable acknowledgement. Losing a WebSocket after send()
      // must not lose the only completed answer.
      onSubmit(nextAnswers);
    },
    [onSubmit],
  );

  const cancelInterview = useCallback(() => {
    if (awaitingAcknowledgement || cancellationPending) return;
    // The parent clears the draft only after the exact terminal cancel ack.
    onCancel();
  }, [awaitingAcknowledgement, cancellationPending, onCancel]);

  // Save an answer and advance
  const saveAnswer = useCallback(
    (
      questionId: string,
      value: string,
      label: string,
      wasCustom: boolean,
      index?: number,
    ) => {
      const next = new Map(answers);
      next.set(questionId, { id: questionId, value, label, wasCustom, index });
      setAnswers(next);

      // Advance to next question or Submit tab
      if (isMulti) {
        if (currentTab < questions.length - 1) {
          setCurrentTab((t) => t + 1);
        } else {
          setCurrentTab(questions.length); // Submit tab
        }
      } else {
        // Single question: submit immediately
        next.set(questionId, { id: questionId, value, label, wasCustom, index });
        submitAnswers(orderInterviewAnswers(questions, next));
      }
    },
    [answers, currentTab, isMulti, questions, submitAnswers],
  );

  // Handle option click
  const handleOptionSelect = (opt: QuestionOption & { isOther?: boolean }) => {
    if (!currentQuestion || awaitingAcknowledgement || cancellationPending) return;

    if (opt.isOther) {
      setCustomQuestionId(currentQuestion.id);
      setCustomInput("");
      return;
    }

    const optIndex =
      currentQuestion.options.findIndex((o) => o.value === opt.value) + 1;
    saveAnswer(currentQuestion.id, opt.value, opt.label, false, optIndex);
  };

  // Handle custom text submit
  const handleCustomSubmit = () => {
    if (!customQuestionId || awaitingAcknowledgement || cancellationPending) return;
    const trimmed = customInput.trim() || "(no response)";
    saveAnswer(customQuestionId, trimmed, trimmed, true);
    setCustomInput("");
    setCustomQuestionId(null);
  };

  // Submit all
  const handleSubmitAll = () => {
    if (!awaitingAcknowledgement && !cancellationPending && allAnswered) {
      submitAnswers(orderInterviewAnswers(questions, answers));
    }
  };

  // Tab navigation
  const goToTab = (index: number) => {
    if (awaitingAcknowledgement || cancellationPending) return;
    setCustomQuestionId(null);
    setCustomInput("");
    setCurrentTab(index);
  };

  return (
    <div data-testid="interview-form" className="flex max-h-[60dvh] min-h-0 flex-col overflow-hidden rounded-lg border border-blue-900/50 bg-neutral-900 md:max-h-[36rem]">
      {awaitingAcknowledgement && (
        <div
          data-testid="interview-submission-status"
          className={`border-b px-4 py-2 text-xs ${
            submissionState === "rejected"
              ? "border-red-900/60 bg-red-950/30 text-red-200"
              : submissionState === "retry"
                ? "border-amber-900/60 bg-amber-950/30 text-amber-200"
                : "border-blue-900/60 bg-blue-950/30 text-blue-200"
          }`}
        >
          <div className="font-medium">
            {submissionState === "submitting"
              ? "Answer sent — waiting for durable acknowledgement."
              : submissionState === "retry"
                ? "Answer is retained and needs to be retried."
                : "The server did not accept this answer yet."}
          </div>
          {submissionMessage && <div className="mt-1 opacity-80">{submissionMessage}</div>}
          {onRetry && submissionState !== "submitting" && (
            <button
              type="button"
              data-testid="interview-retry-button"
              onClick={onRetry}
              className="mt-2 rounded border border-current/40 px-2 py-1 font-medium hover:bg-white/10"
            >
              Retry submission
            </button>
          )}
        </div>
      )}

      {cancellationState && (
        <div
          data-testid="interview-cancellation-status"
          className={`border-b px-4 py-2 text-xs ${
            cancellationPending
              ? "border-blue-900/60 bg-blue-950/30 text-blue-200"
              : "border-amber-900/60 bg-amber-950/30 text-amber-200"
          }`}
          role="status"
        >
          <div className="font-medium">
            {cancellationPending
              ? "Cancellation sent — waiting for acknowledgement."
              : "Cancellation was not confirmed. The questionnaire remains available."}
          </div>
          {cancellationMessage && <div className="mt-1 opacity-80">{cancellationMessage}</div>}
        </div>
      )}

      <fieldset disabled={cancellationPending} className="contents">
      {/* ---- Tab bar ---- */}
      {isMulti && (
        <div className="flex items-center gap-1 px-3 py-2 border-b border-neutral-800 overflow-x-auto">
          {questions.map((q, i) => {
            const isActive = i === currentTab;
            const isAnswered = answers.has(q.id);
            return (
              <button
                key={q.id}
                type="button"
                onClick={() => goToTab(i)}
                disabled={awaitingAcknowledgement}
                className={`px-2.5 py-1 rounded text-xs font-mono whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                  isActive
                    ? "bg-blue-800/60 text-blue-200"
                    : isAnswered
                      ? "text-green-400 hover:bg-neutral-800"
                      : "text-neutral-500 hover:bg-neutral-800"
                }`}
              >
                {isAnswered ? "■" : "□"} {q.label}
              </button>
            );
          })}

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => goToTab(questions.length)}
            disabled={awaitingAcknowledgement}
            className={`px-2.5 py-1 rounded text-xs font-mono whitespace-nowrap transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
              currentTab === questions.length
                ? "bg-blue-800/60 text-blue-200"
                : allAnswered
                  ? "text-green-400 hover:bg-neutral-800"
                  : "text-neutral-600"
            }`}
          >
            ✓ Submit
          </button>
        </div>
      )}

      {/* ---- Content ---- */}
      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto overscroll-contain p-4">
        {/* Custom text input mode */}
        {customQuestionId && currentQuestion && (
          <div className="space-y-3">
            <p className="text-sm text-neutral-200">
              {currentQuestion.prompt}
            </p>
            <div className="space-y-1">
              <label className="text-xs text-neutral-500">Your answer:</label>
              <textarea
                className="w-full bg-neutral-800 text-sm text-neutral-100 rounded px-3 py-2 resize-none border border-neutral-700 focus:outline-none focus:border-blue-500 min-h-[80px]"
                placeholder="Type your answer..."
                value={customInput}
                onChange={(e) => setCustomInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    handleCustomSubmit();
                  }
                  if (e.key === "Escape") {
                    setCustomQuestionId(null);
                    setCustomInput("");
                  }
                }}
                autoFocus
                disabled={awaitingAcknowledgement}
              />
            </div>
            <div className="flex justify-between items-center">
              <button
                type="button"
                onClick={() => {
                  if (awaitingAcknowledgement || cancellationPending) return;
                  setCustomQuestionId(null);
                  setCustomInput("");
                }}
                disabled={awaitingAcknowledgement}
                className="text-xs text-neutral-500 hover:text-neutral-300"
              >
                ← Back to options
              </button>
              <button
                type="button"
                onClick={handleCustomSubmit}
                disabled={awaitingAcknowledgement}
                className="px-3 py-1 text-xs font-medium rounded bg-blue-700 hover:bg-blue-600 text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                Submit
              </button>
            </div>
          </div>
        )}

        {/* Submit tab */}
        {!customQuestionId && currentTab === questions.length && (
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-blue-300">
              Review answers
            </h3>
            {questions.map((q) => {
              const answer = answers.get(q.id);
              return (
                <div
                  key={q.id}
                  className="text-sm flex items-start gap-2"
                >
                  <span className="text-neutral-500 font-mono text-xs mt-0.5">
                    {q.label}:
                  </span>
                  <span className="text-neutral-200">
                    {answer
                      ? answer.wasCustom
                        ? `(wrote) ${answer.label}`
                        : answer.label
                      : ""}
                  </span>
                  {!answer && (
                    <span className="text-yellow-500 text-xs">unanswered</span>
                  )}
                </div>
              );
            })}
            {allAnswered && (
              <button
                type="button"
                onClick={handleSubmitAll}
                disabled={awaitingAcknowledgement}
                className="w-full mt-2 px-3 py-2 text-sm font-semibold rounded bg-green-700 hover:bg-green-600 text-white disabled:cursor-not-allowed disabled:opacity-60"
              >
                Submit all answers
              </button>
            )}
            {!allAnswered && (
              <p className="text-xs text-yellow-500">
                Some questions are still unanswered — use the tabs to fill them
                in.
              </p>
            )}
          </div>
        )}

        {/* Question card */}
        {!customQuestionId &&
          currentTab < questions.length &&
          currentQuestion && (
            <div className="space-y-3">
              <p className="text-sm text-neutral-100 font-medium">
                {currentQuestion.prompt}
              </p>
              <ul className="space-y-1">
                {currentQuestion.options.map((opt, i) => (
                  <li key={opt.value}>
                    <button
                      type="button"
                      onClick={() => handleOptionSelect(opt)}
                      disabled={awaitingAcknowledgement}
                      className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-800 transition-colors group flex items-start gap-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="text-neutral-500 font-mono text-xs mt-0.5">
                        {i + 1}.
                      </span>
                      <div className="min-w-0">
                        <span className="text-neutral-200 group-hover:text-white">
                          {opt.label}
                        </span>
                        {opt.description && (
                          <p className="text-xs text-neutral-500 mt-0.5">
                            {opt.description}
                          </p>
                        )}
                      </div>
                    </button>
                  </li>
                ))}
                <li>
                  <button
                      type="button"
                      onClick={() =>
                        handleOptionSelect({
                          value: "__other__",
                          label: "Type something",
                          isOther: true,
                        })
                      }
                      disabled={awaitingAcknowledgement}
                      className="w-full text-left px-3 py-2 rounded text-sm hover:bg-neutral-800 transition-colors group flex items-start gap-2 disabled:cursor-not-allowed disabled:opacity-60"
                    >
                      <span className="text-neutral-500 font-mono text-xs mt-0.5">
                        {currentQuestion.options.length + 1}.
                      </span>
                      <div className="min-w-0">
                        <span className="text-neutral-400 group-hover:text-neutral-200 italic">
                          Type something…
                        </span>
                      </div>
                  </button>
                </li>
              </ul>
            </div>
          )}
      </div>

      {/* ---- Bottom actions ---- */}
      <div className="px-4 py-2 border-t border-neutral-800 flex justify-between items-center">
        <div className="text-[10px] text-neutral-600 font-mono">
          {isMulti ? "← → navigate questions" : ""}
        </div>
        <button
          type="button"
          onClick={cancelInterview}
          disabled={awaitingAcknowledgement}
          className="text-xs text-neutral-500 hover:text-red-400 transition-colors disabled:cursor-not-allowed disabled:opacity-60"
        >
          {awaitingAcknowledgement
            ? "Submission pending"
            : cancellationPending
              ? "Cancellation pending"
              : cancellationState
                ? "Retry cancellation"
                : "Cancel"}
        </button>
      </div>
      </fieldset>
    </div>
  );
}
