import { Router, type Request, type Response } from "express";
import { tree, read, write, discoverProjects } from "../fs.js";

export const router = Router();

// ---------------------------------------------------------------------------
// Directory listing
// ---------------------------------------------------------------------------

router.get("/fs/tree", (req: Request, res: Response) => {
  try {
    const relativePath =
      typeof req.query.path === "string" ? req.query.path : ".";
    const showHidden = req.query.show_hidden === "1";

    let result = tree(relativePath);

    // Filter hidden files if not requested
    if (!showHidden) {
      result = {
        ...result,
        entries: result.entries.filter((e) => !e.name.startsWith(".")),
      };
    }

    res.json(result);
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Read file
// ---------------------------------------------------------------------------

router.get("/fs/read", (req: Request, res: Response) => {
  try {
    const relativePath = req.query.path;
    if (typeof relativePath !== "string") {
      res.status(400).json({ error: "path query parameter is required" });
      return;
    }

    const result = read(relativePath);
    res.json(result);
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Discover projects
// ---------------------------------------------------------------------------

router.get("/fs/discover-projects", (_req: Request, res: Response) => {
  try {
    const projects = discoverProjects();
    res.json(projects);
  } catch (err: any) {
    res.status(500).json({ error: err.message || String(err) });
  }
});

// ---------------------------------------------------------------------------
// Write file
// ---------------------------------------------------------------------------

router.put("/fs/write", (req: Request, res: Response) => {
  try {
    const { path: relativePath, content, expected_sha256 } = req.body;

    if (typeof relativePath !== "string" || typeof content !== "string") {
      res.status(400).json({ error: "path and content are required" });
      return;
    }

    const result = write(relativePath, content, expected_sha256);
    res.json(result);
  } catch (err: any) {
    const status = err.statusCode || 500;
    res.status(status).json({ error: err.message || String(err) });
  }
});
