import express from "express";
import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import { getConfig, type Config } from "./config.js";
import { AuthService } from "./auth/service.js";
import { createAuthRouter } from "./auth/routes.js";
import { init } from "./db.js";
import { router as sessionsRouter } from "./routes/sessions.js";
import { router as fsRouter } from "./routes/fs.js";
import { router as capabilitiesRouter } from "./routes/capabilities.js";
import { router as appsRouter } from "./routes/apps.js";
import { router as scheduledAgentJobsRouter } from "./routes/scheduled-agent-jobs.js";
import { router as searchRouter } from "./routes/search.js";
import { router as ttsRouter } from "./routes/tts.js";
import { router as browserRouter } from "./routes/browser.js";
import { cleanupCache } from "./tts-cache.js";
import { attachWs } from "./routes/ws.js";
import { attachBrowserWs } from "./browser/ws.js";
import { stopAllApps } from "./apps/process-manager.js";
import { stopAllBrowsers } from "./browser/manager.js";
import { schedulerManager } from "./scheduler/manager.js";
import { startWatcher, stopWatcher } from "./search/index.js";
import { drainSubmittedInterviews } from "./interview-delivery.js";
import { startSessionCatalog, stopSessionCatalog } from "./sessions.js";
import { getLatencyMetricsSnapshot, startLatencyMetrics, stopLatencyMetrics } from "./latency-metrics.js";

export interface CreateAppOptions {
  config?: Partial<Config>;
  authService?: AuthService;
}

export function createApp(options: CreateAppOptions = {}) {
  const config = getConfig(options.config);
  const auth = options.authService ?? new AuthService(config.auth);
  const app = express();

  // Health and the frontend shell remain public. Authentication is mounted
  // before the general JSON parser so rejected requests cannot submit large
  // bodies, while login has its own 4 KiB parser.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", createAuthRouter(auth));
  app.use("/api", auth.requireAuthentication, auth.requireValidOrigin);
  app.use(express.json({ limit: "10mb" }));

  // API info
  app.get("/api/me", (_req, res) => {
    res.json({
      username: process.env.USER || "unknown",
      provider: "pi",
      version: "0.1.0",
    });
  });

  // Aggregate-only diagnostics: fixed metric names and numbers, never session
  // ids, cwd, titles, transcript text, or environment values.
  app.get("/api/latency/metrics", (_req, res) => {
    res.json(getLatencyMetricsSnapshot());
  });

  // Routes. The search router is mounted before sessionsRouter so that
  // `/api/sessions/search` is matched before sessionsRouter's catch-all
  // `/sessions/:id` handler treats "search" as a session id.
  app.use("/api", searchRouter);
  app.use("/api", sessionsRouter);
  app.use("/api", fsRouter);
  app.use("/api", capabilitiesRouter);
  app.use("/api", appsRouter);
  app.use("/api", scheduledAgentJobsRouter);
  app.use("/api", ttsRouter);
  app.use("/api", browserRouter);

  // Unknown API routes should return JSON 404, not the frontend SPA shell.
  // Returning index.html for /api/* makes clients parse successful HTML as
  // data and can crash panels when the running backend is stale.
  app.use("/api", (_req, res) => {
    res.status(404).json({ error: "API endpoint not found" });
  });

  // Serve frontend in production
  const frontendDist = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../../frontend/dist",
  );

  if (fs.existsSync(frontendDist)) {
    app.use(express.static(frontendDist));
    app.get("*", (_req, res) => {
      res.sendFile(path.join(frontendDist, "index.html"));
    });
  }

  // Create HTTP server
  const server = http.createServer(app);

  // All WebSocket transports use the same authentication/origin decision.
  attachWs(server, auth);
  attachBrowserWs(server, auth);

  return { app, server, auth };
}

function isLoopbackHost(host: string): boolean {
  const normalized = host.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "::1" || normalized.startsWith("127.");
}

export function start() {
  const config = getConfig();

  // Initialize store
  init();
  console.log(`[db] Store at ${config.dbPath}`);
  // Durable submissions survive a backend restart. Delivery failures stay in
  // the store and are retried again when their session's WebSocket attaches.
  void drainSubmittedInterviews();
  schedulerManager.start();
  startWatcher();
  startLatencyMetrics();
  startSessionCatalog();

  if (!config.auth.enabled && !isLoopbackHost(config.host)) {
    console.warn("[wayang] WARNING: built-in authentication is disabled on a non-loopback bind; protect every HTTP and WebSocket path with a trusted network or authenticated reverse proxy.");
  }

  const { server } = createApp({ config });

  server.listen(config.port, config.host, () => {
    console.log(
      `[wayang] listening on http://${config.host}:${config.port}`,
    );
    console.log(
      `[wayang] WebSocket at ws://${config.host}:${config.port}/ws/chat`,
    );
  });

  // Periodic TTS cache cleanup (every hour)
  const ttsCleanupInterval = setInterval(() => {
    cleanupCache().catch((err) =>
      console.error("[tts-cache] cleanup error:", err),
    );
  }, 60 * 60 * 1000);

  // Run initial cleanup
  cleanupCache()
    .then((result) => {
      if (result.deleted > 0) {
        console.log(
          `[tts-cache] cleaned up ${result.deleted} files (${(result.freedBytes / 1024 / 1024).toFixed(1)} MB)`,
        );
      }
    })
    .catch((err) => console.error("[tts-cache] initial cleanup error:", err));

  const shutdownServices = () => {
    clearInterval(ttsCleanupInterval);
    schedulerManager.stop();
    stopWatcher();
    stopLatencyMetrics();
    void stopSessionCatalog().catch((err) => console.error("[session-catalog] Failed to stop:", err));
    stopAllApps().catch((err) => console.error("[apps] Failed to stop apps:", err));
    stopAllBrowsers().catch((err) => console.error("[browser] Failed to stop browsers:", err));
  };
  server.on("close", shutdownServices);
  process.once("SIGINT", shutdownServices);
  process.once("SIGTERM", shutdownServices);

  return server;
}