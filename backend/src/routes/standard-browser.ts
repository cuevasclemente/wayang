import type { IncomingMessage } from "node:http";
import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";
import type { WebSocket } from "ws";
import { openStandardCdpViewer } from "../browser/standard-viewer.js";
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
}

export interface StandardBrowserHttpRuntime {
  workspace: StandardBrowserRuntimeWorkspace;
}

export interface StandardBrowserIntegration {
  select(input: {
    sourceSessionId?: string;
    targetSessionId?: string;
    projectCwd?: string;
    requestedPersistence?: string;
    requestedScope?: string;
    transport: "http" | "vnc" | "cdp";
  }): StandardBrowserRouteSelection | null;
  resolve(selection: Readonly<StandardBrowserRouteSelection>): StandardBrowserHttpRuntime | null;
  openViewer(selection: Readonly<StandardBrowserRouteSelection>, kind: "vnc" | "cdp"): Promise<ProtectedBrowserViewerTransport | null>;
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
      };
    },
    resolve(selection) {
      const resolved = exactOwner(selection);
      return resolved ? { workspace: resolved.workspace } : null;
    },
    async openViewer(selection, kind) {
      if (kind !== "cdp") return null;
      const resolved = exactOwner(selection);
      if (!resolved) return null;
      const { workspace } = resolved;
      workspace.host.ownerSetControlMode(selection.sourceSessionId, selection.workspaceGeneration, "user");
      const authorize = async () => {
        if (!exactOwner(selection)) throw new Error("Standard browser viewer authority is unavailable");
        if (!workspace.host.hasBlockingControl(selection.sourceSessionId)) {
          throw new Error("Standard browser viewer control is unavailable");
        }
      };
      const attachment = await workspace.host.ownerAttachActiveViewer(selection.sourceSessionId, selection.workspaceGeneration, authorize);
      return openStandardCdpViewer({
        attachment,
        authorize,
        revoke: () => workspace.host.closeWorkspace(selection.sourceSessionId, "viewer_policy"),
      });
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
    if (!selection) { next(); return; }
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
  if (!selection) return null;
  if (input.sourceSessionId) throw error("Standard browser agent access requires exact capability-bound tools");
  if (transport === "vnc") throw error("Standard browser VNC transport is not available in this build", 404);
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
    viewerTransport: "cdp-screencast",
    cdpScreencastWsPath: `/ws/browser?${params.toString()}`,
    viewerWsPath: `/ws/browser?${params.toString()}`,
    vncReady: false,
    profile: { persistence: "named", id: state.profileId, name: runtime.workspace.profile.name },
    tabs: state.tabs,
    activeTab: state.activeTab,
    updatedAt: state.updatedAt,
    credentialBroker: { supported: false, guarded: true },
  };
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
  router.post("/browser/control-mode", asyncHandler(async (req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    const mode = req.body?.mode;
    if (mode !== "agent" && mode !== "user" && mode !== "paused") throw error("Invalid Standard browser control mode", 400);
    if (mode === "agent") await runtime.workspace.host.ownerResumeAgent(selection.sourceSessionId, selection.workspaceGeneration);
    else runtime.workspace.host.ownerSetControlMode(selection.sourceSessionId, selection.workspaceGeneration, mode);
    res.json(publicState(selection, runtime));
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
  router.post("/browser/tabs/select", asyncHandler((req, res) => {
    const selection = selections.get(req)!;
    const runtime = exactRuntime(req, integration!);
    runtime.workspace.host.ownerSelectTab(selection.sourceSessionId, selection.workspaceGeneration, String(req.body?.tab ?? ""));
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

export function attachSelectedStandardViewer(
  ws: WebSocket,
  selection: StandardBrowserRouteSelection,
  kind: "vnc" | "cdp",
  integration: StandardBrowserIntegration,
): void {
  void integration.openViewer(selection, kind).then((viewer) => {
    if (!viewer) throw error("Standard browser viewer is unavailable", 409);
    ws.on("message", (raw, isBinary) => {
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as any);
      void Promise.resolve(viewer.dispatch(bytes, isBinary)).catch(() => viewer.close());
    });
    ws.on("close", () => { void viewer.close(); });
    ws.on("error", () => { void viewer.close(); });
    const unsubscribe = viewer.onMessage((message, isBinary) => {
      if (ws.readyState === ws.OPEN) ws.send(message, { binary: isBinary });
    });
    ws.once("close", unsubscribe);
  }).catch(() => ws.close(1008, "Standard browser transport denied"));
}

function asyncHandler(handler: (req: Request, res: Response) => Promise<void> | void): RequestHandler {
  return (req, res) => { void Promise.resolve().then(() => handler(req, res)).catch((value: unknown) => sendError(res, value)); };
}
