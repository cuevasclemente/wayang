/**
 * Stable authority provenance for durable browser questionnaire submissions.
 *
 * These literals describe Wayang's documented single trusted-user boundary;
 * they do not identify multiple users or claim OS-level identity isolation.
 */
export const WAYANG_WEBSOCKET_SUBMISSION_CHANNEL = "WAYANG_WEBSOCKET" as const;
export const WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL = "WAYANG_SINGLE_USER" as const;

export type InterviewSubmissionChannel = typeof WAYANG_WEBSOCKET_SUBMISSION_CHANNEL;
export type InterviewAuthenticatedPrincipal = typeof WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL;

const submissionContextBrand: unique symbol = Symbol("wayang-websocket-submission-context");

/**
 * An in-process capability created by the server, never deserialized from a
 * browser message. Object identity is checked at the repository boundary so a
 * structurally similar caller object cannot authorize a first submission.
 */
export interface InterviewSubmissionContext {
  readonly submission_channel: InterviewSubmissionChannel;
  readonly authenticated_principal: InterviewAuthenticatedPrincipal;
  readonly [submissionContextBrand]: true;
}

export const WAYANG_WEBSOCKET_SUBMISSION_CONTEXT: InterviewSubmissionContext = Object.freeze({
  submission_channel: WAYANG_WEBSOCKET_SUBMISSION_CHANNEL,
  authenticated_principal: WAYANG_SINGLE_USER_AUTHENTICATED_PRINCIPAL,
  [submissionContextBrand]: true as const,
});

export function isWayangWebSocketSubmissionContext(value: unknown): value is InterviewSubmissionContext {
  return value === WAYANG_WEBSOCKET_SUBMISSION_CONTEXT;
}
