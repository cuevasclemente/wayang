export const PROTECTED_AUTOMATION_ATTENTION_REASONS = [
  "login_required",
  "mfa_required",
  "captcha_required",
  "payment_confirmation_required",
  "human_review_required",
] as const;

export type ProtectedAutomationAttentionReason = typeof PROTECTED_AUTOMATION_ATTENTION_REASONS[number];

export function protectedAutomationAttentionMetadata(run: {
  status: string;
  outcome_code: string | null;
}): { required: true; reason: ProtectedAutomationAttentionReason } | null {
  if (run.status !== "needs_user" || typeof run.outcome_code !== "string") return null;
  const reason = run.outcome_code.startsWith("needs_user:")
    ? run.outcome_code.slice("needs_user:".length) : "human_review_required";
  return (PROTECTED_AUTOMATION_ATTENTION_REASONS as readonly string[]).includes(reason)
    ? { required: true, reason: reason as ProtectedAutomationAttentionReason }
    : { required: true, reason: "human_review_required" };
}

/**
 * Backend browser adapters may throw this metadata-only signal. The runner
 * terminates rather than waiting for a person; a later manual run starts from
 * a fresh authority/snapshot claim.
 */
export class ProtectedAutomationNeedsUserError extends Error {
  constructor(readonly reason: ProtectedAutomationAttentionReason) {
    super("Protected automation requires noninteractive human attention");
    this.name = "ProtectedAutomationNeedsUserError";
  }
}
