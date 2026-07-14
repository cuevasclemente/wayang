import { Router, type Request, type Response } from "express";
import { schedulerManager } from "../scheduler/manager.js";
import {
  createScheduledJob,
  deleteScheduledJob,
  getScheduledJob,
  listScheduledJobs,
  listScheduledRuns,
  updateScheduledJob,
} from "../scheduler/store.js";

export const router = Router();

router.get("/scheduled-agent-jobs", (_req: Request, res: Response) => {
  try {
    res.json({ jobs: listScheduledJobs() });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.post("/scheduled-agent-jobs", (req: Request, res: Response) => {
  try {
    const job = createScheduledJob(req.body ?? {});
    schedulerManager.reloadJob(job.id);
    res.status(201).json(job);
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

router.get("/scheduled-agent-jobs/:id", (req: Request, res: Response) => {
  try {
    const job = getScheduledJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Scheduled job not found" });
      return;
    }
    res.json({ job, runs: listScheduledRuns(job.id) });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.put("/scheduled-agent-jobs/:id", (req: Request, res: Response) => {
  try {
    const job = updateScheduledJob(req.params.id, req.body ?? {});
    if (!job) {
      res.status(404).json({ error: "Scheduled job not found" });
      return;
    }
    schedulerManager.reloadJob(job.id);
    res.json(job);
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

router.delete("/scheduled-agent-jobs/:id", (req: Request, res: Response) => {
  try {
    const deleted = deleteScheduledJob(req.params.id);
    schedulerManager.reloadJob(req.params.id);
    if (!deleted) {
      res.status(404).json({ error: "Scheduled job not found" });
      return;
    }
    res.status(204).end();
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.get("/scheduled-agent-jobs/:id/runs", (req: Request, res: Response) => {
  try {
    const job = getScheduledJob(req.params.id);
    if (!job) {
      res.status(404).json({ error: "Scheduled job not found" });
      return;
    }
    const limit = Number(req.query.limit ?? 100);
    res.json({ runs: listScheduledRuns(job.id, Number.isFinite(limit) ? limit : 100) });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

router.post("/scheduled-agent-jobs/:id/run", (req: Request, res: Response) => {
  try {
    const run = schedulerManager.triggerRun(req.params.id);
    res.status(202).json(run);
  } catch (err) {
    const message = errorMessage(err);
    res.status(message.includes("not found") ? 404 : 400).json({ error: message });
  }
});

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
