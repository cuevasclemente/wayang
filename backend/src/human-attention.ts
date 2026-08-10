import { getStore } from "./db.js";
import {
  isBoundedHumanAttentionId,
  isProjectableOpenInterview,
  MAX_HUMAN_ATTENTION_ID_BYTES,
  MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION,
} from "./interview-attention-policy.js";

export {
  isBoundedHumanAttentionId,
  MAX_HUMAN_ATTENTION_ID_BYTES,
  MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION,
};

export type HumanAttentionKind = "question";
export type HumanAttentionStatus = "pending";

export interface HumanAttentionSummary {
  sessionId: string;
  kind: HumanAttentionKind;
  sourceId: string;
  createdAt: number;
  status: HumanAttentionStatus;
  requiresWayang: true;
}

type HumanAttentionSource = (sessionId: string) => HumanAttentionSummary[];

const pendingInterviewAttention: HumanAttentionSource = (sessionId) => getStore().interviews
  .filter((record) => isProjectableOpenInterview(record, sessionId))
  .map((record) => ({
    sessionId,
    kind: "question",
    sourceId: record.request_id,
    createdAt: record.created_at,
    status: "pending",
    requiresWayang: true,
  }));

// Additional authoritative durable gate sources can join this projection
// without changing interview response or approval authority.
const HUMAN_ATTENTION_SOURCES: readonly HumanAttentionSource[] = [pendingInterviewAttention];

/**
 * Read-only projection of authoritative durable gate state.
 *
 * The projection deliberately excludes question text, options, answers,
 * provenance, tool-call metadata, paths, and every delivery detail.
 */
export function listHumanAttentionForSession(sessionId: string): HumanAttentionSummary[] {
  if (!isBoundedHumanAttentionId(sessionId)) return [];
  return HUMAN_ATTENTION_SOURCES
    .flatMap((source) => source(sessionId))
    .sort((left, right) => left.createdAt - right.createdAt
      || (left.sourceId < right.sourceId ? -1 : left.sourceId > right.sourceId ? 1 : 0))
    .slice(0, MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION);
}
