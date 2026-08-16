import type { IncomingMessage } from "node:http";
import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";
import type { WebSocket } from "ws";
import {
  openStandardCdpViewer,
  StandardViewerInputError,
  type StandardViewerFailureReason,
  type StandardViewerObservation,
} from "../browser/standard-viewer.js";
import { classifyGenericBrowserTarget } from "../browser/request-auth.js";
import { openLoopbackVncTransport } from "../browser/vnc-transport.js";
import type { StandardBrowserRuntimeWorkspace, StandardBrowserProfileHostService } from "../browser/standard-service.js";
import type { ProtectedBrowserOperation } from "../browser/types.js";
import type { ProtectedBrowserViewerTransport } from "./protected-browser.js";

export interface StandardBrowserRouteSelection {
  sourceSessionId: string;
  projectId: string;
  projectCwd: string;
  agentProfileId: string;
  associationRevision: number;
  profileId: string;
  workspaceGeneration: string;
  fullBrowserTakeover?: boolean;
}

export interface StandardBrowserHttpRuntime {
  workspace: StandardBrowserRuntimeWorkspace;
  credentialsSupported: boolean;
}

export interface StandardBrowserIntegration {
  select(input: {
    sourceSessionId?: string;
    targetSessionId?: string;
    projectCwd?: string;
    requestedPersistence?: string;
    requestedScope?: string;
    transport: "http" | "vnc" | "cdp";
    fullBrowserTakeover?: boolean;
  }): StandardBrowserRouteSelection | null;
  resolve(selection: Readonly<StandardBrowserRouteSelection>): StandardBrowserHttpRuntime | null;
  openViewer(selection: Readonly<StandardBrowserRouteSelection>, kind: "vnc" | "cdp"): Promise<ProtectedBrowserViewerTransport | null>;
  credentialStatus(selection: Readonly<StandardBrowserRouteSelection>): Promise<unknown>;
  credentialMatches(selection: Readonly<StandardBrowserRouteSelection>): Promise<unknown>;
  credentialFill(selection: Readonly<StandardBrowserRouteSelection>, choiceToken: string, operation: "login" | "totp"): Promise<unknown>;
  allowCredentialInspection(selection: Readonly<StandardBrowserRouteSelection>): Promise<unknown>;
  lockCredentials(selection: Readonly<StandardBrowserRouteSelection>): Promise<void>;
}

export function createStandardBrowserIntegration(service: StandardBrowserProfileHostService): StandardBrowserIntegration {
  const exactOwner = (selection: Readonly<StandardBrowserRouteSelection>) => {
    const resolved = service.resolveOwnerWorkspace(selection.sourceSessionId, selection.projectCwd);
    if (!resolved || resolved.authority.projectId !== selection.projectId
      || resolved.authority.agentProfileId !== selection.agentProfileId
      || resolved.authority.associationRevision !== selection.associationRevision
      || resolved.workspace.profile.id !== selection.profileId
      || resolved.workspace.workspaceGeneration !== selection.workspaceGeneration) return null;
    return resolved;
  };
  return {
    select(input) {
      if (!input.targetSessionId || input.requestedPersistence !== undefined || input.requestedScope !== undefined) return null;
      if (input.sourceSessionId && input.sourceSessionId !== input.targetSessionId) return null;
      const resolved = service.resolveOwnerWorkspace(input.targetSessionId, input.projectCwd);
      if (!resolved) return null;
      return {
        ...resolved.authority,
        profileId: resolved.workspace.profile.id,
        workspaceGeneration: resolved.workspace.workspaceGeneration,
        ...(input.fullBrowserTakeover === true ? { fullBrowserTakeover: true } : {}),
      };
    },
    resolve(selection) {
      const resolved = exactOwner(selection);
      return resolved ? { workspace: resolved.workspace, credentialsSupported: service.credentialBrokerSupported } : null;
    },
    async openViewer(selection, kind) {
      const resolved = exactOwner(selection);
      if (!resolved) return null;
      const { workspace } = resolved;
      const authorize = async () => {
        if (!exactOwner(selection)) throw new Error("Standard browser viewer authority is unavailable");
        if (!workspace.host.viewerControlAvailable(selection.sourceSessionId, selection.workspaceGeneration)) {
          throw new Error("Standard browser viewer control is unavailable");
        }
      };
      if (kind === "vnc") {
        let controllerGeneration = 0;
        const transport = await openLoopbackVncTransport(workspace.host.vncPort(), async () => {
          if (!exactOwner(selection) || !workspace.host.hasWorkspace(selection.sourceSessionId, selection.workspaceGeneration)) {
            throw new Error("Standard Full browser authority is unavailable");
          }
          if (controllerGeneration && !workspace.host.vncControllerCurrent(controllerGeneration)) {
            throw new Error("Standard Full browser controller is stale");
          }
        });
        try {
          const lease = await workspace.host.acquireVncController(
            selection.sourceSessionId,
            selection.workspaceGeneration,
            selection.fullBrowserTakeover === true,
            async () => { await transport.close(); },
          );
          controllerGeneration = lease.generation;
          return {
            dispatch: (message, binary) => transport.dispatch(message, binary),
            close: async () => { lease.release(); await transport.close(); },
            onMessage: (listener) => transport.onMessage(listener),
            onClose: (listener) => transport.onClose?.(listener) ?? (() => undefined),
          };
        } catch (error) {
          await transport.close();
          throw error;
        }
      }
      const attachment = await workspace.host.ownerAttachActiveViewer(selection.sourceSessionId, selection.workspaceGeneration, authorize);
      const viewer = await openStandardCdpViewer({
        attachment,
        authorize: attachment.authorize,
        revoke: () => workspace.host.closeWorkspace(selection.sourceSessionId, "viewer_policy"),
        redact: (value) => workspace.host.redactCredentialMetadata(value),
        observe: (event) => logStandardViewerObservation(event),
      });
      let unregister: () => void = () => undefined;
      try {
        unregister = workspace.host.registerViewer(selection.sourceSessionId, selection.workspaceGeneration, async () => {
          unregister();
          await viewer.close();
        });
      } catch (error) {
        await viewer.close();
        throw error;
      }
      return {
        dispatch: (message, binary) => viewer.dispatch(message, binary),
        close: async () => { unregister(); await viewer.close(); },
        onMessage: (listener) => viewer.onMessage(listener),
        onClose: (listener) => viewer.onClose?.(listener) ?? (() => undefined),
      };
    },
    async credentialStatus(selection) {
      if (!exactOwner(selection)) throw new Error("Standard browser credential authority is unavailable");
      return service.credentialStatus(selection.sourceSessionId, selection.projectCwd);
    },
    async credentialMatches(selection) {
      if (!exactOwner(selection)) throw new Error("Standard browser credential authority is unavailable");
      return service.credentialMatches(selection.sourceSessionId, selection.projectCwd);
    },
    async credentialFill(selection, choiceToken, operation) {
      if (!exactOwner(selection)) throw new Error("Standard browser credential authority is unavailable");
      return service.credentialFill(selection.sourceSessionId, selection.projectCwd, choiceToken, operation);
    },
    async allowCredentialInspection(selection) {
      if (!exactOwner(selection)) throw new Error("Standard browser credential authority is unavailable");
      return service.allowCredentialInspection(selection.sourceSessionId, selection.projectCwd);
    },
    async lockCredentials(selection) {
      if (!exactOwner(selection)) throw new Error("Standard browser credential authority is unavailable");
      await service.lockCredentials(selection.sourceSessionId, selection.projectCwd);
    },
  };
}

const selections = new WeakMap<IncomingMessage, StandardBrowserRouteSelection>();

function selectionInput(request: IncomingMessage, transport: "http" | "vnc" | "cdp") {
  const url = new URL(request.url || "", "http://localhost");
  const source = request.headers["x-wayang-source-session-id"];
  return {
    sourceSessionId: typeof source === "string" ? source : undefined,
    targetSessionId: url.searchParams.get("session_id") ?? undefined,
    projectCwd: url.searchParams.get("project_cwd") ?? undefined,
    requestedPersistence: url.searchParams.has("persistence") ? url.searchParams.get("persistence") ?? "" : undefined,
    requestedScope: url.searchParams.has("scope") ? url.searchParams.get("scope") ?? "" : undefined,
    transport,
    fullBrowserTakeover: url.searchParams.get("takeover") === "1",
  };
}

function error(message: string, statusCode = 403): Error {
  return Object.assign(new Error(message), { statusCode });
}

function sendError(res: Response, value: unknown): void {
  const statusCode = value && typeof value === "object" && "statusCode" in value
    ? Number((value as { statusCode?: unknown }).statusCode) : 500;
  const status = Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599 ? statusCode : 500;
  res.setHeader("Cache-Control", "no-store");
  res.status(status).json({ error: status >= 500 ? "Standard browser operation failed" : value instanceof Error ? value.message : "Standard browser operation denied" });
}

export function createStandardBrowserSelectionMiddleware(integration?: StandardBrowserIntegration): RequestHandler {
  return (req, res, next) => {
    if (!integration) { next(); return; }
    const input = selectionInput(req, "http");
    let selection: StandardBrowserRouteSelection | null;
    try { selection = integration.select(input); }
    catch { sendError(res, error("Standard browser selection is unavailable")); return; }
    if (!selection) {
      const classification = classifyGenericBrowserTarget({ sessionId: input.targetSessionId ?? null, projectCwd: input.projectCwd ?? null });
      if (classification === "standard") {
        sendError(res, error("This session has no active named Browser Profile workspace; assign a profile in Settings or with browser_switch_profile", 409));
        return;
      }
      next();
      return;
    }
    if (input.sourceSessionId) { sendError(res, error("Standard browser agent access requires exact capability-bound tools")); return; }
    selections.set(req, selection);
    res.setHeader("Cache-Control", "no-store");
    next();
  };
}

export function selectStandardBrowserWebSocket(
  request: IncomingMessage,
  transport: "vnc" | "cdp",
  integration?: StandardBrowserIntegration,
): StandardBrowserRouteSelection | null {
  if (!integration) return null;
  const input = selectionInput(request, transport);
  const selection = integration.select(input);
  if (!selection) {
    const classification = classifyGenericBrowserTarget({ sessionId: input.targetSessionId ?? null, projectCwd: input.projectCwd ?? null });
    if (classification === "standard") throw error("This session has no active named Browser Profile workspace", 409);
    return null;
  }
  if (input.sourceSessionId) throw error("Standard browser agent access requires exact capability-bound tools");
  return selection;
}

function exactRuntime(req: Request, integration: StandardBrowserIntegration): StandardBrowserHttpRuntime {
  const selection = selections.get(req);
  if (!selection) throw error("Standard browser selection is unavailable");
  const runtime = integration.resolve(selection);
  if (!runtime) throw error("Standard browser runtime is unavailable", 409);
  return runtime;
}

function publicState(selection: StandardBrowserRouteSelection, runtime: StandardBrowserHttpRuntime) {
  const state = runtime.workspace.host.ownerPublicState(selection.sourceSessionId, selection.workspaceGeneration);
  const params = new URLSearchParams({ session_id: selection.sourceSessionId });
  return {
    sessionId: selection.sourceSessionId,
    projectCwd: selection.projectCwd,
    status: state.running ? "running" : "stopped",
    controlMode: state.controlMode,
    secretTainted: false,
    localOnlyRecommended: true,
    needsUser: state.controlMode !== "agent",
    ...(state.controlMode === "agent" ? {} : { needsUserReason: "Human control is active for this session workspace" }),
    cdpReady: state.running,
    viewerTransport: state.fullBrowser.available ? "vnc" : "cdp-screencast",
    cdpScreencastWsPath: `/ws/browser?${params.toString()}`,
    viewerWsPath: `/ws/browser?${params.toString()}`,
    vncReady: state.fullBrowser.available,
    fullBrowser: state.fullBrowser,
    profile: { persistence: "named", id: state.profileId, name: runtime.workspace.profile.name },
    tabs: state.tabs,
    activeTab: state.activeTab,
    updatedAt: state.updatedAt,
    ...(state.credentialInspection ? { credentialInspection: state.credentialInspection } : {}),
    credentialBroker: { supported: runtime.credentialsSupported, guarded: true },
  };
}

function exactBody(req: Request, keys: readonly string[]): Record<string, unknown> {
  const body = req.body === undefined ? {} : req.body;
  if (!body || typeof body !== "object" || Array.isArray(body)
    || Object.keys(body).some((key) => !keys.includes(key))) throw error("Invalid Standard browser request", 400);
  return body as Record<string, unknown>;
}

function exactCredentialBody(
  req: Request,
  selection: StandardBrowserRouteSelection,
  keys: readonly string[] = [],
): Record<string, unknown> {
  const body = exactBody(req, ["sessionId", "projectCwd", ...keys]);
  if ((body.sessionId !== undefined && body.sessionId !== selection.sourceSessionId)
    || (body.projectCwd !== undefined && body.projectCwd !== selection.projectCwd)) {
    throw error("Standard browser credential target changed", 409);
  }
  return body;
}

function operation(req: Request): ProtectedBrowserOperation {
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body as Record<string, unknown> : {};
  switch (req.params.operation) {
    case "status": return { kind: "status" };
    case "start": return { kind: "start" };
    case "stop": return { kind: "stop" };
    case "navigate": return { kind: "navigate", url: String(body.url ?? "") };
    case "snapshot": return { kind: "snapshot", ...(body.mode ? { mode: body.mode as "text" | "screenshot" } : {}) };
    case "dom-snapshot": return { kind: "dom_snapshot", includeText: Boolean(body.includeText), ...(body.limit === undefined ? {} : { limit: Number(body.limit) }) };
    case "links": return { kind: "links", ...(body.limit === undefined ? {} : { limit: Number(body.limit) }) };
    case "accessibility": return { kind: "accessibility", ...(body.limit === undefined ? {} : { limit: Number(body.limit) }) };
    case "query-selector": return { kind: "query_selector", selector: String(body.selector ?? ""), ...(body.limit === undefined ? {} : { limit: Number(body.limit) }) };
    case "click": return { kind: "click", x: Number(body.x), y: Number(body.y) };
    case "click-selector": return { kind: "click_selector", selector: String(body.selector ?? ""), ...(body.index === undefined ? {} : { index: Number(body.index) }) };
    case "fill-selector": return { kind: "fill_selector", selector: String(body.selector ?? ""), text: String(body.text ?? ""), ...(body.index === undefined ? {} : { index: Number(body.index) }) };
    case "type-public": return { kind: "type_public", text: String(body.text ?? "") };
    default: throw error("Standard browser operation is unavailable", 404);
  }
}

export function createStandardBrowserRouter(integration?: StandardBrowserIntegration): Router {
  const router = express.Router();
  router.use("/browser", (req, _res, next) => selections.has(req) ? next() : next("router"));
  router.get("/browser/status", asyncHandler((req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    res.json(publicState(selection, runtime));
  }));
  router.post("/browser/control-mode", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    const mode = req.body?.mode;
    if (mode !== "agent" && mode !== "user" && mode !== "paused") throw error("Invalid Standard browser control mode", 400);
    if (mode === "agent") await runtime.workspace.host.ownerResumeAgent(selection.sourceSessionId, selection.workspaceGeneration, async () => {
      if (!integration!.resolve(selection)) throw error("Standard browser owner authority changed");
    });
    else await runtime.workspace.host.ownerSetControlMode(selection.sourceSessionId, selection.workspaceGeneration, mode);
    res.json(publicState(selection, runtime));
  }));
  router.post("/browser/credentials/status", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    exactCredentialBody(req, selection);
    res.json(await integration!.credentialStatus(selection));
  }));
  router.post("/browser/credentials/matches", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    exactCredentialBody(req, selection);
    res.json(await integration!.credentialMatches(selection));
  }));
  const fillCredential = (kind: "login" | "totp") => asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    const body = exactCredentialBody(req, selection, ["choiceToken"]);
    const choiceToken = typeof body.choiceToken === "string" ? body.choiceToken : "";
    if (!choiceToken) throw error("choiceToken is required", 400);
    res.json(await integration!.credentialFill(selection, choiceToken, kind));
  });
  router.post("/browser/credentials/fill", fillCredential("login"));
  router.post("/browser/credentials/fill-totp", fillCredential("totp"));
  router.post("/browser/credentials/allow-agent-inspection", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    exactCredentialBody(req, selection);
    await integration!.allowCredentialInspection(selection);
    const runtime = exactRuntime(req, integration!);
    res.json({
      allowedInspection: "text-only",
      screenshotsAllowed: false,
      mutationsAllowed: false,
      state: publicState(selection, runtime),
    });
  }));
  router.post("/browser/credentials/lock", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    exactCredentialBody(req, selection);
    await integration!.lockCredentials(selection);
    res.json({ locked: true });
  }));
  router.post("/browser/paste", (_req, res) => {
    res.status(409).json({ error: "Use the authenticated Browser viewer for Standard profile input" });
  });
  router.post("/browser/reset-profile", (_req, res) => {
    res.status(409).json({ error: "Shared named profiles cannot be reset from a session workspace" });
  });
  router.get("/browser/tabs", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    const authorize = async () => { if (!integration!.resolve(selection)) throw error("Standard browser owner authority changed"); };
    await runtime.workspace.host.ownerListTabs(selection.sourceSessionId, selection.workspaceGeneration, authorize);
    res.json(publicState(selection, runtime));
  }));
  router.post("/browser/tabs", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    const authorize = async () => { if (!integration!.resolve(selection)) throw error("Standard browser owner authority changed"); };
    await runtime.workspace.host.ownerOpenTab(selection.sourceSessionId, selection.workspaceGeneration, String(req.body?.url ?? "about:blank"), authorize);
    res.status(201).json(publicState(selection, runtime));
  }));
  router.post("/browser/tabs/select", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    await runtime.workspace.host.ownerSelectTab(selection.sourceSessionId, selection.workspaceGeneration, String(req.body?.tab ?? ""));
    res.json(publicState(selection, runtime));
  }));
  router.delete("/browser/tabs/:tab", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    await runtime.workspace.host.ownerCloseTab(selection.sourceSessionId, selection.workspaceGeneration, req.params.tab);
    res.json(publicState(selection, runtime));
  }));
  router.post("/browser/:operation", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    const value = operation(req);
    const authorize = async () => {
      if (!integration!.resolve(selection)) throw error("Standard browser owner authority changed");
    };
    await runtime.workspace.host.ownerExecute(selection.sourceSessionId, selection.workspaceGeneration, value, authorize);
    if (value.kind === "stop") { res.json({ closed: true }); return; }
    res.json(publicState(selection, runtime));
  }));
  return router;
}

function logStandardViewerObservation(event: Readonly<StandardViewerObservation>): void {
  // Privacy-safe operational telemetry only. Do not add selection/session IDs,
  // URLs, titles, text/keys, profile paths, screenshots, or raw errors here.
  console.info("[standard-browser-viewer]", JSON.stringify({ transport: "cdp", ...event }));
}

function standardViewerClose(reason: unknown): { code: number; message: string } {
  const value = reason instanceof StandardViewerInputError ? reason.reason : reason;
  const mapped: Partial<Record<StandardViewerFailureReason, { code: number; message: string }>> = {
    input_invalid: { code: 1003, message: "viewer input invalid" },
    input_queue_full: { code: 1013, message: "viewer input overloaded" },
    input_authorization_failed: { code: 1008, message: "input authorization failed" },
    input_dispatch_failed: { code: 1011, message: "input dispatch failed" },
    input_attestation_failed: { code: 1011, message: "input attestation failed" },
    viewer_authorization_failed: { code: 1008, message: "viewer authorization failed" },
    viewer_closed: { code: 1000, message: "viewer closed" },
  };
  return typeof value === "string" && value in mapped
    ? mapped[value as StandardViewerFailureReason]!
    : { code: 1011, message: "input transport failed" };
}

export function attachSelectedStandardViewer(
  ws: WebSocket,
  selection: StandardBrowserRouteSelection,
  kind: "vnc" | "cdp",
  integration: StandardBrowserIntegration,
): void {
  void integration.openViewer(selection, kind).then(async (viewer) => {
    if (!viewer) throw error("Standard browser viewer is unavailable", 409);
    // The browser may disconnect while Chromium/CDP attachment is still
    // opening. Do not publish or leak a transport whose owner has gone away.
    if (ws.readyState !== ws.OPEN) {
      await viewer.close();
      return;
    }
    const closeSocket = (failure: unknown) => {
      if (ws.readyState !== ws.OPEN && ws.readyState !== ws.CONNECTING) return;
      const close = standardViewerClose(failure);
      ws.close(close.code, close.message);
    };
    let viewerClose: Promise<void> | null = null;
    const closeViewer = () => {
      viewerClose ??= Promise.resolve(viewer.close()).then(() => undefined);
      return viewerClose;
    };
    ws.on("message", (raw, isBinary) => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
      void Promise.resolve(viewer.dispatch(bytes, isBinary)).catch(async (failure) => {
        closeSocket(failure);
        await closeViewer();
      });
    });
    ws.on("close", () => { void closeViewer(); });
    ws.on("error", () => { void closeViewer(); });
    const unsubscribe = viewer.onMessage((message, isBinary) => {
      if (ws.readyState !== ws.OPEN) return;
      if (ws.bufferedAmount + message.length > 2 * 1024 * 1024) {
        ws.close(1009, "Standard browser viewer is not draining");
        void closeViewer();
        return;
      }
      ws.send(message, { binary: isBinary });
    });
    const unsubscribeClose = viewer.onClose?.((reason) => closeSocket(reason));
    ws.once("close", unsubscribe);
    if (unsubscribeClose) ws.once("close", unsubscribeClose);
  }).catch(() => ws.close(1008, "Standard browser transport denied"));
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res) => { void Promise.resolve().then(() => handler(req, res)).catch((value: unknown) => sendError(res, value)); };
}
