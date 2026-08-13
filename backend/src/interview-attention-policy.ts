import type { InterviewRecord } from "./db.js";

export const MAX_HUMAN_ATTENTION_ID_BYTES = 512;
export const MAX_HUMAN_ATTENTION_SUMMARIES_PER_SESSION = 100;

/** Keep backend identifier admission aligned with the frontend projection adapter. */
export function isBoundedHumanAttentionId(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value === value.trim()
    && value === value.normalize("NFC")
    && !/[\p{Cc}\p{Cf}]/u.test(value)
    && Buffer.byteLength(value, "utf8") <= MAX_HUMAN_ATTENTION_ID_BYTES;
}

/** Only exact, authoritative interview tools may create projected open gates. */
export function isProjectableOpenInterview(
  record: InterviewRecord,
  sessionId: string,
): boolean {
  return record.status === "open"
    && record.session_id === sessionId
    && (record.origin_tool_name === "interview" || record.origin_tool_name === "questionnaire")
    && isBoundedHumanAttentionId(record.request_id)
    && Number.isSafeInteger(record.created_at)
    && record.created_at >= 0;
}
