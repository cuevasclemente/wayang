/** Serialized, retryable delivery of durable out-of-tool interview submissions. */

import { listSubmittedUndeliveredInterviews, markDelivered, type InterviewRecord } from "./interviews.js";
import { getInterviewBridge } from "./interview-bridge.js";
import { deliverInterviewSubmission, findInterviewToolResultEntry } from "./pi-bridge.js";

export interface InterviewDeliveryDependencies {
  getBridge: () => {
    hasToolResultHandoff(sessionId: string, requestId: string): boolean;
    completeToolResultHandoff(sessionId: string, requestId: string): void;
  };
  findToolResultEntry: typeof findInterviewToolResultEntry;
  markDelivered: typeof markDelivered;
  deliverSubmission: typeof deliverInterviewSubmission;
  sleep: (milliseconds: number) => Promise<void>;
}

const DEFAULT_DELIVERY_DEPENDENCIES: InterviewDeliveryDependencies = {
  getBridge: getInterviewBridge,
  findToolResultEntry: findInterviewToolResultEntry,
  markDelivered,
  deliverSubmission: deliverInterviewSubmission,
  sleep: (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
};

const sessionQueues = new Map<string, Promise<void>>();

function enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  sessionQueues.set(sessionId, result.then(() => undefined, () => undefined));
  return result;
}

export async function confirmInterviewToolResultDelivery(
  record: InterviewRecord,
  options: { timeoutMs?: number; pollMs?: number } = {},
  dependencies: InterviewDeliveryDependencies = DEFAULT_DELIVERY_DEPENDENCIES,
): Promise<boolean> {
  return enqueue(record.session_id, async () => {
    const deadline = Date.now() + (options.timeoutMs ?? 30_000);
    const pollMs = options.pollMs ?? 25;
    try {
      while (Date.now() <= deadline) {
        if (!dependencies.getBridge().hasToolResultHandoff(record.session_id, record.request_id)) return false;
        const entryId = await dependencies.findToolResultEntry(record.session_id, record);
        if (entryId) {
          const delivered = dependencies.markDelivered(record.request_id, "tool_result", entryId);
          return delivered?.status === "delivered" && delivered.delivery_mode === "tool_result";
        }
        await dependencies.sleep(pollMs);
      }
      return false;
    } finally {
      dependencies.getBridge().completeToolResultHandoff(record.session_id, record.request_id);
    }
  });
}

export async function deliverSubmittedInterview(
  record: InterviewRecord,
  dependencies: InterviewDeliveryDependencies = DEFAULT_DELIVERY_DEPENDENCIES,
): Promise<void> {
  await enqueue(record.session_id, async () => {
    if (dependencies.getBridge().hasToolResultHandoff(record.session_id, record.request_id)) return;
    const toolResultEntryId = await dependencies.findToolResultEntry(record.session_id, record);
    if (toolResultEntryId) {
      dependencies.markDelivered(record.request_id, "tool_result", toolResultEntryId);
      return;
    }
    const delivery = await dependencies.deliverSubmission(record.session_id, record);
    dependencies.markDelivered(record.request_id, "custom_message", delivery.entryId);
  });
}

export async function retrySubmittedInterviewDelivery(
  record: InterviewRecord,
  options: { attempts?: number; initialDelayMs?: number } = {},
  dependencies: InterviewDeliveryDependencies = DEFAULT_DELIVERY_DEPENDENCIES,
): Promise<void> {
  const attempts = Math.max(1, Math.min(options.attempts ?? 3, 5));
  const initialDelayMs = Math.max(1, options.initialDelayMs ?? 100);
  let lastError: unknown;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      await deliverSubmittedInterview(record, dependencies);
      return;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < attempts) {
        await dependencies.sleep(initialDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError ?? "Interview delivery failed"));
}

/**
 * Recovery drain. Failures are deliberately retained as submitted records and
 * reported to stderr; a later websocket setup/startup drain retries them.
 */
export async function drainSubmittedInterviews(sessionId?: string): Promise<void> {
  for (const record of listSubmittedUndeliveredInterviews(sessionId)) {
    try {
      await retrySubmittedInterviewDelivery(record);
    } catch (error) {
      console.warn(
        `[interviews] delivery retained for request ${record.request_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
