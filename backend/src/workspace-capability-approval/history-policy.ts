export const MAX_WORKSPACE_CAPABILITY_ACTIVATION_HISTORY = 4_096;
export const DEFAULT_WORKSPACE_CAPABILITY_HISTORY_LIMIT = 100;
export const MAX_WORKSPACE_CAPABILITY_HISTORY_PAGE = 200;

export type ActivationHistoryAppendDecision =
  | { allowed: true }
  | { allowed: false; reason: "history_full" };

/** No rollover or implicit evidence deletion is permitted. */
export function mayAppendActivationHistory(currentRows: number): ActivationHistoryAppendDecision {
  if (!Number.isSafeInteger(currentRows) || currentRows < 0) return { allowed: false, reason: "history_full" };
  return currentRows < MAX_WORKSPACE_CAPABILITY_ACTIVATION_HISTORY
    ? { allowed: true }
    : { allowed: false, reason: "history_full" };
}

export function boundedHistoryLimit(value: unknown): number {
  if (value === undefined) return DEFAULT_WORKSPACE_CAPABILITY_HISTORY_LIMIT;
  const parsed = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_WORKSPACE_CAPABILITY_HISTORY_PAGE) {
    throw new Error(`history limit must be an integer from 1 to ${MAX_WORKSPACE_CAPABILITY_HISTORY_PAGE}`);
  }
  return parsed;
}
