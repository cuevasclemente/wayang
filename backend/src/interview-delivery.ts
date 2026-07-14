/** Serialized, retryable delivery of durable out-of-tool interview submissions. */

import { listSubmittedUndeliveredInterviews, markDelivered, type InterviewRecord } from "./interviews.js";
import { deliverInterviewSubmission } from "./pi-bridge.js";

const sessionQueues = new Map<string, Promise<void>>();

function enqueue<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
  const previous = sessionQueues.get(sessionId) ?? Promise.resolve();
  const result = previous.catch(() => {}).then(operation);
  sessionQueues.set(sessionId, result.then(() => undefined, () => undefined));
  return result;
}

export async function deliverSubmittedInterview(record: InterviewRecord): Promise<void> {
  await enqueue(record.session_id, async () => {
    const delivery = await deliverInterviewSubmission(record.session_id, record);
    markDelivered(record.request_id, "custom_message", delivery.entryId);
  });
}

/**
 * Recovery drain. Failures are deliberately retained as submitted records and
 * reported to stderr; a later websocket setup/startup drain retries them.
 */
export async function drainSubmittedInterviews(sessionId?: string): Promise<void> {
  for (const record of listSubmittedUndeliveredInterviews(sessionId)) {
    try {
      await deliverSubmittedInterview(record);
    } catch (error) {
      console.warn(
        `[interviews] delivery retained for request ${record.request_id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
