export type CapabilityApprovalErrorCode =
  | "invalid_request"
  | "unauthenticated"
  | "invalid_origin"
  | "owner_mismatch"
  | "request_not_found"
  | "request_expired"
  | "request_consumed"
  | "realm_busy"
  | "cooldown"
  | "pin_unavailable"
  | "wrong_pin"
  | "state_conflict"
  | "history_full"
  | "denied";

export class CapabilityApprovalError extends Error {
  constructor(
    readonly code: CapabilityApprovalErrorCode,
    message: string,
    readonly statusCode: number,
    readonly retryAt?: number,
  ) {
    super(message);
    this.name = "CapabilityApprovalError";
  }
}
