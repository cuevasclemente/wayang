import { Router, type Request, type Response } from "express";
import {
  MAX_TRANSCRIPT_EVENTS_PER_PAGE,
  TranscriptMutationError,
  TranscriptMutationService,
  type TranscriptMutationKind,
} from "../transcript-mutations.js";

export interface TranscriptMutationRouteService {
  listEvents(sessionId: string, options?: {
    offset?: number;
    limit?: number;
    branchOffset?: number;
    branchLimit?: number;
    includePayload?: boolean;
  }): unknown;
  getEvent(sessionId: string, eventId: string): unknown;
  mutateEvent(
    sessionId: string,
    eventId: string,
    kind: TranscriptMutationKind,
    input: { pin: unknown; expectedEntry: unknown; replacementEntry?: unknown },
  ): Promise<unknown>;
}

function strictQueryInteger(value: unknown, fallback: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "string" || !/^\d+$/u.test(value)) {
    throw new TranscriptMutationError(`${label} must be a non-negative integer`, 400, "invalid_bounds");
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) {
    throw new TranscriptMutationError(`${label} is outside the permitted bounds`, 400, "invalid_bounds");
  }
  return parsed;
}

function strictIncludePayload(value: unknown): boolean {
  if (value === undefined || value === "1") return true;
  if (value === "0") return false;
  throw new TranscriptMutationError("include_payload must be exactly 0 or 1", 400, "invalid_include_payload");
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof TranscriptMutationError) {
    if (error.retryAt !== undefined) {
      res.setHeader("Retry-After", Math.max(1, Math.ceil((error.retryAt - Date.now()) / 1_000)));
    }
    res.status(error.statusCode).json({
      error: error.message,
      code: error.code,
      ...(error.code.startsWith("pin_") ? {
        pinRequired: true,
        pinConfigured: error.pin?.pinConfigured ?? false,
      } : {}),
    });
    return;
  }
  res.status(500).json({ error: "Transcript mutation failed", code: "internal_error" });
}

export function createTranscriptMutationRouter(
  service: TranscriptMutationRouteService = new TranscriptMutationService(),
): Router {
  const router = Router();

  router.get("/sessions/:id/events", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const offset = strictQueryInteger(req.query.offset, 0, "offset");
      const limit = strictQueryInteger(req.query.limit, 100, "limit");
      const branchOffset = strictQueryInteger(req.query.branch_offset, 0, "branch_offset");
      const branchLimit = strictQueryInteger(req.query.branch_limit, 100, "branch_limit");
      const includePayload = strictIncludePayload(req.query.include_payload);
      if (limit < 1 || limit > MAX_TRANSCRIPT_EVENTS_PER_PAGE
        || branchLimit < 1 || branchLimit > MAX_TRANSCRIPT_EVENTS_PER_PAGE) {
        throw new TranscriptMutationError(
          `limit and branch_limit must be between 1 and ${MAX_TRANSCRIPT_EVENTS_PER_PAGE}`,
          400,
          "invalid_bounds",
        );
      }
      res.json(service.listEvents(req.params.id, {
        offset,
        limit,
        branchOffset,
        branchLimit,
        includePayload,
      }));
    } catch (error) {
      sendError(res, error);
    }
  });

  router.get("/sessions/:id/events/:eventId", (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      res.json(service.getEvent(req.params.id, req.params.eventId));
    } catch (error) {
      sendError(res, error);
    }
  });

  const mutate = (kind: TranscriptMutationKind) => async (req: Request, res: Response) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await service.mutateEvent(req.params.id, req.params.eventId, kind, {
        pin: req.body?.pin,
        expectedEntry: req.body?.expected_entry,
        ...(kind === "edit" ? { replacementEntry: req.body?.replacement_entry } : {}),
      });
      res.json(result);
    } catch (error) {
      sendError(res, error);
    }
  };

  router.post("/sessions/:id/events/:eventId/edit", mutate("edit"));
  router.post("/sessions/:id/events/:eventId/delete", mutate("delete"));
  return router;
}

export const router = createTranscriptMutationRouter();
