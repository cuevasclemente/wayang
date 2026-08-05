import express from "express";
import * as http from "node:http";
import * as path from "node:path";
import * as fs from "node:fs";
import { getConfig, type Config } from "./config.js";
import { AuthService } from "./auth/service.js";
import { createAuthRouter } from "./auth/routes.js";
import { init } from "./db.js";
import { isLoopbackHost } from "./loopback.js";
import { router as sessionsRouter } from "./routes/sessions.js";
import { router as projectsRouter } from "./routes/projects.js";
import { router as agentProfilesRouter } from "./routes/agent-profiles.js";
import { router as fsRouter } from "./routes/fs.js";
import { router as capabilitiesRouter } from "./routes/capabilities.js";
import { router as appsRouter } from "./routes/apps.js";
import { router as scheduledAgentJobsRouter } from "./routes/scheduled-agent-jobs.js";
import { router as searchRouter } from "./routes/search.js";
import { router as ttsRouter } from "./routes/tts.js";
import { router as browserRouter } from "./routes/browser.js";
import { createBrowserCredentialsRouter } from "./routes/browser-credentials.js";
import {
  attachProtectedAutomationWs,
  createProtectedAutomationsRouter,
} from "./routes/protected-automations.js";
import {
  createProtectedBrowserRouter,
  createProtectedBrowserSelectionMiddleware,
  type ProtectedBrowserIntegration,
} from "./routes/protected-browser.js";
import {
  createWorkspaceCapabilitiesRouter,
  type WorkspaceCapabilitiesRouterOptions,
} from "./routes/workspace-capabilities.js";
import { cleanupCache } from "./tts-cache.js";
import { attachWs } from "./routes/ws.js";
import { installActionApprovalPinAttempts } from "./action-approval-bridge.js";
import { attachBrowserWs } from "./browser/ws.js";
import { stopAllApps } from "./apps/process-manager.js";
import { registerBrowserStopHook, stopAllBrowsers } from "./browser/manager.js";
import {
  clearBrowserAgentToken,
  installBrowserAgentToken,
  isBrowserAgentRequest,
  recognizeBrowserAgent,
} from "./browser/request-auth.js";
import { clearAppsAgentToken, installAppsAgentToken, isAppsAgentRequest, recognizeAppsAgent } from "./apps/request-auth.js";
import { CredentialBroker } from "./browser/credentials.js";
import { schedulerManager } from "./scheduler/manager.js";
import { startWatcher, stopWatcher } from "./search/index.js";
import { drainSubmittedInterviews } from "./interview-delivery.js";
import { startSessionCatalog, stopSessionCatalog } from "./sessions.js";
import { getLatencyMetricsSnapshot, startLatencyMetrics, stopLatencyMetrics } from "./latency-metrics.js";
import {
  createProductionWorkspaceCapabilityBootstrap,
  type ProductionWorkspaceCapabilityBootstrap,
} from "./workspace-capability-bootstrap.js";
import {
  bootstrapProtectedBrowserProduction,
  type ProtectedBrowserOwnerPort,
  type ProtectedBrowserProductionBootstrap,
} from "./browser/protected-production.js";
import {
  bootstrapProtectedAutomationProduction,
  type ProtectedAutomationProductionBootstrap,
  type ProtectedAutomationProductionIntegration,
} from "./protected-automation/production.js";
import {
  bootstrapFileAudioExperimentProduction,
  type FileAudioExperimentProductionBootstrap,
} from "./audio-experiment/production.js";

const serverCredentialBrokers = new WeakMap<http.Server, CredentialBroker>();
const serverProtectedAutomationWsClosers = new WeakMap<http.Server, () => void>();
const serverProductionBootstraps = new WeakMap<http.Server, readonly {
  close(): Promise<void>;
}[]>();
const serverProductionCleanup = new WeakMap<http.Server, Promise<void>>();

function bindProductionBootstraps(
  server: http.Server,
  workspaceCapabilities: ProductionWorkspaceCapabilityBootstrap,
  protectedBrowser: ProtectedBrowserProductionBootstrap,
  protectedAutomation: ProtectedAutomationProductionBootstrap,
  fileAudioExperiment: FileAudioExperimentProductionBootstrap,
): void {
  serverProductionBootstraps.set(server, [workspaceCapabilities, protectedBrowser, protectedAutomation, fileAudioExperiment]);
  server.once("close", () => { void closeProductionBootstraps(server); });
}

function closeProductionBootstraps(server: http.Server): Promise<void> {
  const existing = serverProductionCleanup.get(server);
  if (existing) return existing;
  const bootstraps = serverProductionBootstraps.get(server);
  if (!bootstraps) return Promise.resolve();
  // Start every closer independently: a synchronous throw or rejection from
  // either bootstrap must not skip the other, and all callers share one run.
  const cleanup = Promise.allSettled(bootstraps.map((bootstrap) =>
    Promise.resolve().then(() => bootstrap.close())))
    .then(() => undefined);
  serverProductionCleanup.set(server, cleanup);
  return cleanup;
}

function createProductionProtectedBrowserOwner(auth: AuthService): ProtectedBrowserOwnerPort {
  return {
    resolve(request) {
      const resolution = auth.resolveSettingsOwner(request);
      return resolution.status === "authenticated" ? resolution.owner.sessionId : null;
    },
  };
}

export interface CreateAppOptions {
  config?: Partial<Config>;
  authService?: AuthService;
  credentialBroker?: CredentialBroker;
  /** Exact capability/runtime bridge supplied by runtime integration. Missing means Protected browser fails closed. */
  protectedBrowser?: ProtectedBrowserIntegration;
  /** Exact authenticated Settings owner plus workspace/PIN service. Missing means the Settings capability API fails closed. */
  workspaceCapabilities?: WorkspaceCapabilitiesRouterOptions;
  /** App-owned deterministic automation metadata/preparation/purge integration. Missing means these routes fail closed. */
  protectedAutomation?: ProtectedAutomationProductionIntegration;
}

export function createApp(options: CreateAppOptions = {}) {
  const config = getConfig(options.config);
  const auth = options.authService ?? new AuthService(config.auth);
  const credentialBroker = options.credentialBroker ?? new CredentialBroker(config.browser.credentials);
  const unregisterCredentialStopHook = registerBrowserStopHook(() => credentialBroker.lock());
  installBrowserAgentToken();
  installAppsAgentToken();
  const app = express();

  // Health and the frontend shell remain public. Authentication is mounted
  // before the general JSON parser so rejected requests cannot submit large
  // bodies, while login has its own 4 KiB parser.
  app.get("/healthz", (_req, res) => {
    res.json({ status: "ok" });
  });

  app.use("/api/auth", createAuthRouter(auth));

  // Settings capability approval owns exact authenticated web-session+Origin
  // resolution and a bounded parser. Mount it before broad auth/JSON so a PIN
  // body is never parsed before that owner check. Missing runtime ports deny.
  if (options.workspaceCapabilities) {
    app.use("/api", createWorkspaceCapabilitiesRouter(options.workspaceCapabilities));
  } else {
    const unavailableSettingsCapabilities: express.RequestHandler = (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.setHeader("Pragma", "no-cache");
      res.status(503).json({ error: "Workspace capability Settings integration is unavailable" });
    };
    app.use("/api/workspace-capabilities", unavailableSettingsCapabilities);
    app.use("/api/workspace-capability-associations", unavailableSettingsCapabilities);
  }

  if (options.protectedAutomation) {
    app.use("/api", createProtectedAutomationsRouter(auth, options.protectedAutomation));
  } else {
    app.use("/api/protected-automations", (_req, res) => {
      res.setHeader("Cache-Control", "no-store");
      res.status(503).json({ error: "Protected automation production integration is unavailable" });
    });
  }

  // Durable Protected/capability selection runs before generic agent-token,
  // credential, or browser-registry lookup. Standard browser requests pass
  // through unchanged; unavailable Protected integration fails closed.
  app.use("/api/browser", createProtectedBrowserSelectionMiddleware(options.protectedBrowser));
  app.use("/api/browser", recognizeBrowserAgent);
  app.use("/api/apps", recognizeAppsAgent);
  const isInternalAgentRequest = (req: express.Request) => isBrowserAgentRequest(req) || isAppsAgentRequest(req);
  app.use("/api", (req, res, next) => isInternalAgentRequest(req) ? next() : auth.requireAuthentication(req, res, next));
  app.use("/api", (req, res, next) => isInternalAgentRequest(req) ? next() : auth.requireValidOrigin(req, res, next));
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
  app.use("/api", projectsRouter);
  app.use("/api", agentProfilesRouter);
  app.use("/api", fsRouter);
  app.use("/api", capabilitiesRouter);
  app.use("/api", appsRouter);
  app.use("/api", scheduledAgentJobsRouter);
  app.use("/api", ttsRouter);
  app.use("/api", createProtectedBrowserRouter(options.protectedBrowser));
  app.use("/api", createBrowserCredentialsRouter(auth, credentialBroker));
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
  attachBrowserWs(server, auth, options.protectedBrowser);
  if (options.protectedAutomation) {
    serverProtectedAutomationWsClosers.set(
      server,
      attachProtectedAutomationWs(server, auth, options.protectedAutomation),
    );
  }

  serverCredentialBrokers.set(server, credentialBroker);
  server.on("close", () => {
    serverProtectedAutomationWsClosers.get(server)?.();
    unregisterCredentialStopHook();
    void credentialBroker.shutdown().catch(() => undefined);
  });

  return { app, server, auth, credentialBroker };
}

export async function closeWayangServer(server: http.Server): Promise<void> {
  // Upgraded preparation sockets are not closed by http.Server.close().
  // Terminate them before waiting for the HTTP close callback.
  serverProtectedAutomationWsClosers.get(server)?.();
  const serverClose = server.listening
    ? new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
    : Promise.resolve();
  // Begin teardown after close has stopped new accepts, but do not make one
  // failing subsystem (or an upgraded viewer awaiting teardown) block others.
  const [serverCloseResult] = await Promise.allSettled([
    serverClose,
    closeProductionBootstraps(server),
    Promise.resolve().then(() => serverCredentialBrokers.get(server)?.shutdown()),
    Promise.resolve().then(() => stopSessionCatalog()),
    Promise.resolve().then(() => stopAllApps()),
    Promise.resolve().then(() => stopAllBrowsers()),
  ]);
  clearBrowserAgentToken();
  clearAppsAgentToken();
  if (serverCloseResult.status === "rejected") throw serverCloseResult.reason;
}

export function start() {
  const config = getConfig();

  // Initialize the durable store before composing production authority. These
  // bootstraps are inert: they install policy/runtime bridges but do not create
  // an interactive runtime, browser process, CDP connection, or profile.
  init();
  console.log(`[db] Store at ${config.dbPath}`);
  const authService = new AuthService(config.auth);
  const workspaceCapabilities = createProductionWorkspaceCapabilityBootstrap(authService, config);
  installActionApprovalPinAttempts(workspaceCapabilities.pinAttempts);
  const owner = createProductionProtectedBrowserOwner(authService);
  const credentialBroker = new CredentialBroker(config.browser.credentials);
  const protectedBrowser = bootstrapProtectedBrowserProduction({
    dataDir: config.dataDir,
    owner,
    credentialBroker,
  });
  const protectedAutomation = bootstrapProtectedAutomationProduction({
    dataDir: config.dataDir,
    credentialBroker,
    pinAttempts: workspaceCapabilities.pinAttempts,
  });
  // Installs closures only. Prompt/capsule/key/file/media/DSP/provider work is
  // impossible until a valid enabled same-turn experiment execute reaches it.
  const fileAudioExperiment = bootstrapFileAudioExperimentProduction(config.fileAudioExperiment);

  if (!config.auth.enabled && !isLoopbackHost(config.host)) {
    console.warn("[wayang] WARNING: built-in authentication is disabled on a non-loopback bind; protect every HTTP and WebSocket path with a trusted network or authenticated reverse proxy.");
  }

  const { server } = createApp({
    config,
    authService,
    workspaceCapabilities: workspaceCapabilities.routerOptions,
    protectedBrowser: protectedBrowser.integration,
    protectedAutomation: protectedAutomation.integration,
    credentialBroker,
  });
  bindProductionBootstraps(server, workspaceCapabilities, protectedBrowser, protectedAutomation, fileAudioExperiment);
  protectedAutomation.start();

  // Durable submissions survive a backend restart. Delivery failures stay in
  // the store and are retried again when their session's WebSocket attaches.
  void drainSubmittedInterviews();
  schedulerManager.start();
  startWatcher();
  startLatencyMetrics();
  startSessionCatalog();
  void credentialBroker.startUnlockSocket().catch(() => {
    console.error("[browser-credentials] private unlock socket could not be started");
  });

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

  let shutdownServicesStarted = false;
  const shutdownServices = () => {
    if (shutdownServicesStarted) return;
    shutdownServicesStarted = true;
    clearInterval(ttsCleanupInterval);
    schedulerManager.stop();
    stopWatcher();
    stopLatencyMetrics();
    void stopSessionCatalog().catch((err) => console.error("[session-catalog] Failed to stop:", err));
    stopAllApps().catch((err) => console.error("[apps] Failed to stop apps:", err));
    stopAllBrowsers().catch((err) => console.error("[browser] Failed to stop browsers:", err));
    clearBrowserAgentToken();
    clearAppsAgentToken();
  };
  // src/index.ts owns SIGINT/SIGTERM and awaits closeWayangServer(), which in
  // turn awaits all production bootstraps. The close event handles direct
  // server closure without installing a second, racing signal path here.
  server.once("close", shutdownServices);

  return server;
}