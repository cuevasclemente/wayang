import { Router, type Request, type Response } from "express";
import { discoverProjects } from "../fs.js";

export const router = Router();

// Project discovery remains available after retirement of the global host
// filesystem tree/read/write surface. Session artifacts use opaque IDs and
// current session policy instead of browser-supplied host paths.
router.get("/fs/discover-projects", (_req: Request, res: Response) => {
  try {
    res.json(discoverProjects());
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});
