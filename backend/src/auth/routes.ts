import express, { Router, type ErrorRequestHandler } from "express";
import type { AuthService } from "./service.js";

export function createAuthRouter(auth: AuthService): Router {
  const router = Router();
  const parseLoginJson = express.json({ limit: "4kb", strict: true });

  router.get("/status", (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    res.json(auth.status(req));
  });

  router.post("/login", auth.requireValidOrigin, parseLoginJson, async (req, res) => {
    res.setHeader("Cache-Control", "no-store");
    try {
      const result = await auth.login(req.body?.password, req);
      if (result.status === "rate_limited") {
        res.setHeader("Retry-After", String(result.retryAfterSeconds));
        res.status(429).json({ error: "Too many login attempts" });
        return;
      }
      if (result.status === "invalid") {
        res.status(401).json({ error: "Invalid password" });
        return;
      }
      if (auth.config.enabled) {
        res.setHeader("Set-Cookie", auth.sessionCookie(req, result.token, result.expiresAt));
      }
      res.json({ enabled: auth.config.enabled, authenticated: true });
    } catch {
      res.status(500).json({ error: "Authentication unavailable" });
    }
  });

  router.post("/logout", auth.requireAuthentication, auth.requireValidOrigin, (req, res) => {
    try {
      auth.logout(req);
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Set-Cookie", auth.clearSessionCookie(req));
      res.json({ enabled: auth.config.enabled, authenticated: !auth.config.enabled });
    } catch {
      res.status(500).json({ error: "Authentication unavailable" });
    }
  });

  const jsonError: ErrorRequestHandler = (error, _req, res, next) => {
    if (error?.type === "entity.too.large") {
      res.status(413).json({ error: "Login request is too large" });
      return;
    }
    if (error instanceof SyntaxError) {
      res.status(400).json({ error: "Invalid JSON" });
      return;
    }
    next(error);
  };
  router.use(jsonError);

  return router;
}
