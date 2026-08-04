import type { IncomingMessage } from "node:http";
import type { Request, RequestHandler, Response, Router } from "express";
import express from "express";
import { WebSocket } from "ws";
import {
  assertProtectedBrowserBinding,
  exactProtectedBrowserBindingEqual,
  type CapabilityBoundProtectedBrowser,
  type ProtectedBrowserViewerHandle,
} from "../browser/protected-browser.js";
import {
  classifyGenericBrowserSourceSession,
  classifyGenericBrowserTarget,
  getBrowserAgentSourceSessionId,
  isBrowserAgentRequest,
} from "../browser/request-auth.js";
import {
  PROTECTED_BROWSER_CAPABILITY_ID,
  type BrowserSessionLookup,
  type ProtectedBrowserBinding,
  type ProtectedBrowserOperation,
} from "../browser/types.js";

export interface ProtectedBrowserSelectionInput {
  sourceSessionId?: string;
  targetSessionId?: string;
  projectCwd?: string;
  /** Caller-supplied generic selectors. Protected persistence is backend-issued only. */
  requestedPersistence?: string;
  requestedScope?: string;
  transport: "http" | "vnc" | "cdp";
}

/**
 * Produced only from current durable session/project/profile/capability state.
 * Selection runs before generic bearer, credential broker, or browser registry lookup.
 */
export interface ProtectedBrowserRouteSelection {
  binding: ProtectedBrowserBinding;
}

export interface ProtectedBrowserPublicState {
  sessionId: string;
  projectCwd: string;
  status: "stopped" | "starting" | "running" | "errored";
  controlMode: "agent" | "user" | "paused";
  secretTainted: boolean;
  localOnlyRecommended: boolean;
  needsUser: boolean;
  needsUserReason?: string;
  lastResumeAt?: number;
  activeUrl?: string;
  activeTitle?: string;
  cdpReady: boolean;
  viewerTransport: "cdp-screencast";
  cdpScreencastWsPath: string;
  vncReady: false;
  profile: { persistence: "protected" };
  startedAt?: number;
  updatedAt: number;
  lastError?: string;
  credentialInspection?: "blocked" | "text-allowed";
  credentialBroker: { supported: boolean; guarded: true };
  /** Latest ordinary browser download state; files live directly in the project. */
  download?: {
    status: "downloading" | "completed" | "canceled";
    suggestedFilename: string;
    relativePath?: string;
    bytes?: number;
    updatedAt: number;
  };
}

export interface ProtectedBrowserCredentialControls {
  status(): Promise<{ available: boolean; unlocked: boolean; unlockExpiresAt?: number; origin: string | null }>;
  matches(): Promise<{ origin: string; choices: Array<{ choiceToken: string; label: string; maskedIdentifier: string; hasTotp: boolean; warning?: string }> }>;
  fill(choiceToken: string, operation: "login" | "totp"): Promise<{ filled: Array<"username" | "password" | "totp"> }>;
  allowAgentInspection(): Promise<ProtectedBrowserPublicState>;
  lock(): Promise<void>;
}

/** Authenticated UI-only controls. Text passed here is never an agent operation. */
export interface ProtectedBrowserOwnerControls {
  state(): ProtectedBrowserPublicState;
  start(): Promise<ProtectedBrowserPublicState>;
  stop(): Promise<ProtectedBrowserPublicState>;
  pasteText(text: string): Promise<ProtectedBrowserPublicState>;
  resetProfile(): Promise<ProtectedBrowserPublicState>;
}

export interface ProtectedBrowserHttpRuntime {
  browser: CapabilityBoundProtectedBrowser;
  ownerControls?: ProtectedBrowserOwnerControls;
  credentialControls?: ProtectedBrowserCredentialControls;
}

export interface ProtectedBrowserViewerTransport {
  dispatch(message: Buffer, isBinary: boolean): void | Promise<void>;
  close(): void | Promise<void>;
  onMessage(listener: (message: Buffer, isBinary: boolean) => void): () => void;
}

export interface ProtectedBrowserIntegration {
  /** Must resolve solely from exact current durable Protected/capability state. */
  select(input: Readonly<ProtectedBrowserSelectionInput>): ProtectedBrowserRouteSelection | null | Promise<ProtectedBrowserRouteSelection | null>;
  /** Registry/runtime lookup. Called only after exact Protected selection and HTTP/WS authentication. */
  resolve(selection: Readonly<ProtectedBrowserRouteSelection>): ProtectedBrowserHttpRuntime | null | Promise<ProtectedBrowserHttpRuntime | null>;
  /** Upgraded viewer transport; Chromium/network startup remains runtime-owned. */
  openViewer?(
    selection: Readonly<ProtectedBrowserRouteSelection>,
    kind: "vnc" | "cdp",
  ): ProtectedBrowserViewerTransport | null | Promise<ProtectedBrowserViewerTransport | null>;
  /** Exact authenticated web-session owner; never an IP, username, or caller header. */
  resolveOwner?(request: Request): string | null | Promise<string | null>;
}

const protectedSelections = new WeakMap<IncomingMessage, ProtectedBrowserRouteSelection>();

function headerText(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? undefined : value;
}

function lookupFromQuery(request: IncomingMessage): BrowserSessionLookup {
  const url = new URL(request.url || "", "http://localhost");
  return {
    sessionId: url.searchParams.get("session_id"),
    projectCwd: url.searchParams.get("project_cwd"),
  };
}

export function protectedBrowserSelectionInput(
  request: IncomingMessage,
  transport: ProtectedBrowserSelectionInput["transport"],
): ProtectedBrowserSelectionInput {
  const lookup = lookupFromQuery(request);
  const url = new URL(request.url || "", "http://localhost");
  return {
    sourceSessionId: headerText(request.headers["x-wayang-source-session-id"]),
    targetSessionId: typeof lookup.sessionId === "string" ? lookup.sessionId : undefined,
    projectCwd: typeof lookup.projectCwd === "string" ? lookup.projectCwd : undefined,
    requestedPersistence: url.searchParams.has("persistence") ? (url.searchParams.get("persistence") ?? "") : undefined,
    requestedScope: url.searchParams.has("scope") ? (url.searchParams.get("scope") ?? "") : undefined,
    transport,
  };
}

function protectedError(message: string, statusCode = 403): Error {
  return Object.assign(new Error(message), { statusCode });
}

function assertBackendIssuedProtectedBrowserPersistence(input: Readonly<ProtectedBrowserSelectionInput>): void {
  if (input.requestedPersistence !== undefined || input.requestedScope !== undefined) {
    throw protectedError("Protected browser persistence is backend-issued only");
  }
}

export function validateProtectedBrowserSelection(
  selection: ProtectedBrowserRouteSelection,
  input: ProtectedBrowserSelectionInput,
): ProtectedBrowserRouteSelection {
  const binding = selection?.binding;
  if (!binding || binding.capabilityId !== PROTECTED_BROWSER_CAPABILITY_ID) {
    throw protectedError("Exact protected browser capability authority is unavailable");
  }
  try { assertProtectedBrowserBinding(binding); }
  catch { throw protectedError("Exact protected browser capability authority is invalid"); }
  if (!input.targetSessionId || binding.sourceSessionId !== input.targetSessionId) {
    throw protectedError("Protected browser requires its exact bound session");
  }
  if (input.sourceSessionId && binding.sourceSessionId !== input.sourceSessionId) {
    throw protectedError("Protected browser source binding does not match");
  }
  if (input.projectCwd && binding.projectCwd !== input.projectCwd) {
    throw protectedError("Protected browser project binding does not match");
  }
  assertBackendIssuedProtectedBrowserPersistence(input);
  if (input.transport === "vnc") {
    throw protectedError("Protected browser VNC transport is unavailable", 404);
  }
  return { binding: { ...binding } };
}

function selectedDurableClass(input: ProtectedBrowserSelectionInput): "standard" | "protected" | "quarantined" | "missing" {
  const source = classifyGenericBrowserSourceSession(input.sourceSessionId);
  const target = classifyGenericBrowserTarget({ sessionId: input.targetSessionId, projectCwd: input.projectCwd });
  if (source === "quarantined" || target === "quarantined") return "quarantined";
  if (source === "protected" || target === "protected") return "protected";
  if (source === "standard" || target === "standard") return "standard";
  return "missing";
}

/** Pre-parser route selection: body-only targeting can never enter Protected. */
export function createProtectedBrowserSelectionMiddleware(integration?: ProtectedBrowserIntegration): RequestHandler {
  return (req, res, next) => {
    const input = protectedBrowserSelectionInput(req, "http");
    let classification: ReturnType<typeof selectedDurableClass>;
    try { classification = selectedDurableClass(input); }
    catch {
      res.setHeader("Cache-Control", "no-store");
      res.status(403).json({ error: "Browser target classification is unavailable" });
      return;
    }
    if (classification !== "protected") {
      if (classification === "quarantined") {
        res.setHeader("Cache-Control", "no-store");
        res.status(403).json({ error: "Browser target is quarantined" });
        return;
      }
      next();
      return;
    }
    res.setHeader("Cache-Control", "no-store");
    try { assertBackendIssuedProtectedBrowserPersistence(input); }
    catch (error) { sendError(res, error); return; }
    if (!integration) {
      res.status(403).json({ error: "Protected browser runtime integration is unavailable" });
      return;
    }
    void Promise.resolve().then(() => integration.select(input)).then((selection) => {
      if (!selection) throw protectedError("Exact protected browser capability authority is unavailable");
      protectedSelections.set(req, validateProtectedBrowserSelection(selection, input));
      next();
    }).catch(() => sendError(res, protectedError("Exact protected browser capability authority is unavailable")));
  };
}

export function protectedBrowserSelectionFor(request: IncomingMessage): ProtectedBrowserRouteSelection | undefined {
  return protectedSelections.get(request);
}

export async function selectProtectedBrowserWebSocket(
  request: IncomingMessage,
  transport: "vnc" | "cdp",
  integration?: ProtectedBrowserIntegration,
): Promise<ProtectedBrowserRouteSelection | null> {
  const input = protectedBrowserSelectionInput(request, transport);
  const classification = selectedDurableClass(input);
  if (classification === "quarantined") throw protectedError("Browser target is quarantined");
  if (classification !== "protected") return null;
  assertBackendIssuedProtectedBrowserPersistence(input);
  if (!integration) throw protectedError("Protected browser runtime integration is unavailable");
  let selection: ProtectedBrowserRouteSelection | null;
  try { selection = await integration.select(input); }
  catch { throw protectedError("Exact protected browser capability authority is unavailable"); }
  if (!selection) throw protectedError("Exact protected browser capability authority is unavailable");
  return validateProtectedBrowserSelection(selection, input);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : "Protected browser operation failed";
}

function sendError(res: Response, error: unknown): void {
  res.setHeader("Cache-Control", "no-store");
  const explicit = error && typeof error === "object" && "statusCode" in error
    ? Number((error as { statusCode?: unknown }).statusCode) : NaN;
  const status = Number.isInteger(explicit) && explicit >= 400 && explicit <= 599 ? explicit : 500;
  res.status(status).json({ error: status >= 500 ? "Protected browser operation failed" : message(error) });
}

function exactBodyKeys(body: unknown, allowed: readonly string[]): Record<string, unknown> {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw protectedError("Invalid protected browser request", 400);
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((key) => !allowed.includes(key))) throw protectedError("Unsupported protected browser request field", 400);
  return record;
}

const TARGET_BODY_KEYS = ["sessionId", "session_id", "projectCwd", "project_cwd", "persistence", "scope"] as const;

export function validateProtectedBrowserBodySelection(
  body: Readonly<Record<string, unknown>>,
  selection: Readonly<ProtectedBrowserRouteSelection>,
): void {
  for (const key of ["sessionId", "session_id"] as const) {
    if (Object.hasOwn(body, key) && body[key] !== selection.binding.sourceSessionId) {
      throw protectedError("Protected browser session body does not match", 403);
    }
  }
  for (const key of ["projectCwd", "project_cwd"] as const) {
    if (Object.hasOwn(body, key) && body[key] !== selection.binding.projectCwd) {
      throw protectedError("Protected browser project body does not match", 403);
    }
  }
  if (Object.hasOwn(body, "persistence") || Object.hasOwn(body, "scope")) {
    throw protectedError("Protected browser persistence is backend-issued only", 403);
  }
}

function operationBody(req: Request, operationKeys: readonly string[]): Record<string, unknown> {
  const body = exactBodyKeys(req.body ?? {}, [...TARGET_BODY_KEYS, ...operationKeys]);
  const selection = protectedBrowserSelectionFor(req);
  if (!selection) throw protectedError("Protected browser selection is unavailable");
  validateProtectedBrowserBodySelection(body, selection);
  return body;
}

function operationFromRequest(req: Request): ProtectedBrowserOperation {
  switch (req.params.operation) {
    case "status": operationBody(req, []); return { kind: "status" };
    case "start": operationBody(req, []); return { kind: "start" };
    case "stop": operationBody(req, []); return { kind: "stop" };
    case "navigate": return { kind: "navigate", url: String(operationBody(req, ["url"]).url ?? "") };
    case "snapshot": {
      const value = operationBody(req, ["mode"]).mode;
      return { kind: "snapshot", ...(value === undefined ? {} : { mode: value as "text" | "screenshot" }) };
    }
    case "dom-snapshot": {
      const value = operationBody(req, ["includeText", "limit"]);
      return { kind: "dom_snapshot", ...(value.includeText === undefined ? {} : { includeText: value.includeText as boolean }), ...(value.limit === undefined ? {} : { limit: Number(value.limit) }) };
    }
    case "links":
    case "accessibility": {
      const value = operationBody(req, ["limit"]);
      return { kind: req.params.operation, ...(value.limit === undefined ? {} : { limit: Number(value.limit) }) } as ProtectedBrowserOperation;
    }
    case "query-selector": {
      const value = operationBody(req, ["selector", "limit"]);
      return { kind: "query_selector", selector: String(value.selector ?? ""), ...(value.limit === undefined ? {} : { limit: Number(value.limit) }) };
    }
    case "click": {
      const value = operationBody(req, ["x", "y"]);
      return { kind: "click", x: Number(value.x), y: Number(value.y) };
    }
    case "click-selector": {
      const value = operationBody(req, ["selector", "index"]);
      return { kind: "click_selector", selector: String(value.selector ?? ""), ...(value.index === undefined ? {} : { index: Number(value.index) }) };
    }
    case "fill-selector": {
      const value = operationBody(req, ["selector", "text", "index"]);
      return { kind: "fill_selector", selector: String(value.selector ?? ""), text: typeof value.text === "string" ? value.text : "", ...(value.index === undefined ? {} : { index: Number(value.index) }) };
    }
    case "type-public": {
      const value = operationBody(req, ["text"]);
      return { kind: "type_public", text: typeof value.text === "string" ? value.text : "" };
    }
    default: throw protectedError("Protected browser operation is unavailable", 404);
  }
}

async function exactRuntime(req: Request, integration: ProtectedBrowserIntegration): Promise<ProtectedBrowserHttpRuntime> {
  const selection = protectedBrowserSelectionFor(req);
  if (!selection) throw protectedError("Protected browser selection is unavailable");
  const sourceSessionId = getBrowserAgentSourceSessionId(req);
  if (isBrowserAgentRequest(req) && sourceSessionId !== selection.binding.sourceSessionId) {
    throw protectedError("Protected browser agent source does not match its exact binding");
  }
  let runtime: ProtectedBrowserHttpRuntime | null;
  try { runtime = await integration.resolve(selection); }
  catch { throw protectedError("Exact protected browser runtime is unavailable"); }
  if (!runtime || runtime.browser.isRevoked || !exactProtectedBrowserBindingEqual(runtime.browser.currentBinding, selection.binding)) {
    throw protectedError("Exact protected browser runtime is unavailable");
  }
  return runtime;
}

async function exactOwner(req: Request, integration: ProtectedBrowserIntegration, operation = "Protected browser control"): Promise<string> {
  const resolveOwner = integration.resolveOwner;
  if (isBrowserAgentRequest(req) || !resolveOwner) throw protectedError(`${operation} is owner-only`);
  let owner: string | null;
  try { owner = await resolveOwner(req); }
  catch { throw protectedError("Exact authenticated owner is unavailable", 401); }
  if (typeof owner !== "string" || !owner) throw protectedError("Exact authenticated owner is unavailable", 401);
  return owner;
}

function ownerControls(runtime: ProtectedBrowserHttpRuntime): ProtectedBrowserOwnerControls {
  if (!runtime.ownerControls) throw protectedError("Protected browser owner controls are unavailable", 503);
  return runtime.ownerControls;
}

export function createProtectedBrowserRouter(integration?: ProtectedBrowserIntegration): Router {
  const router = express.Router();
  router.use("/browser", (req, res, next) => {
    if (!protectedBrowserSelectionFor(req)) { next("router"); return; }
    res.setHeader("Cache-Control", "no-store");
    if (!integration) { res.status(403).json({ error: "Protected browser runtime integration is unavailable" }); return; }
    next();
  });

  router.post("/browser/control-mode", asyncRoute(async (req, res) => {
    await exactOwner(req, integration!, "Protected browser handoff");
    const body = operationBody(req, ["mode"]);
    const runtime = await exactRuntime(req, integration!);
    if (body.mode === "agent") await runtime.browser.resumeAgentAfterCredentialHandoff();
    // Entering normal user control is the Protected human/credential handoff:
    // capture the current top-level document before any secret-bearing input.
    else if (body.mode === "user") await runtime.browser.beginCredentialHandoff();
    else if (body.mode === "paused") {
      await runtime.browser.beginCredentialHandoff();
      await runtime.browser.handoffToUser("paused");
    }
    else throw protectedError("Invalid protected browser control mode", 400);
    res.json(ownerControls(runtime).state());
  }));

  router.post("/browser/credentials/status", asyncRoute(async (req, res) => {
    operationBody(req, []);
    await exactOwner(req, integration!, "Protected browser credentials");
    const controls = (await exactRuntime(req, integration!)).credentialControls;
    if (!controls) throw protectedError("Protected browser credential broker is unavailable", 503);
    res.json(await controls.status());
  }));

  router.post("/browser/credentials/matches", asyncRoute(async (req, res) => {
    operationBody(req, []);
    await exactOwner(req, integration!, "Protected browser credentials");
    const controls = (await exactRuntime(req, integration!)).credentialControls;
    if (!controls) throw protectedError("Protected browser credential broker is unavailable", 503);
    res.json(await controls.matches());
  }));

  const fillCredential = (operation: "login" | "totp") => asyncRoute(async (req, res) => {
    const body = operationBody(req, ["choiceToken"]);
    await exactOwner(req, integration!, "Protected browser credentials");
    const token = typeof body.choiceToken === "string" ? body.choiceToken : "";
    if (!token) throw protectedError("choiceToken is required", 400);
    const controls = (await exactRuntime(req, integration!)).credentialControls;
    if (!controls) throw protectedError("Protected browser credential broker is unavailable", 503);
    res.json(await controls.fill(token, operation));
  });
  router.post("/browser/credentials/fill", fillCredential("login"));
  router.post("/browser/credentials/fill-totp", fillCredential("totp"));

  router.post("/browser/credentials/allow-agent-inspection", asyncRoute(async (req, res) => {
    operationBody(req, []);
    await exactOwner(req, integration!, "Protected browser credential inspection");
    const controls = (await exactRuntime(req, integration!)).credentialControls;
    if (!controls) throw protectedError("Protected browser credential broker is unavailable", 503);
    res.json({
      allowedInspection: "text-only",
      screenshotsAllowed: false,
      mutationsAllowed: false,
      state: await controls.allowAgentInspection(),
    });
  }));

  router.post("/browser/credentials/lock", asyncRoute(async (req, res) => {
    operationBody(req, []);
    await exactOwner(req, integration!, "Protected browser credentials");
    const controls = (await exactRuntime(req, integration!)).credentialControls;
    if (!controls) throw protectedError("Protected browser credential broker is unavailable", 503);
    await controls.lock();
    res.json({ locked: true });
  }));

  router.post("/browser/credentials/handoff", asyncRoute(async (req, res) => {
    operationBody(req, []);
    await exactOwner(req, integration!, "Protected browser credential handoff");
    const runtime = await exactRuntime(req, integration!);
    await runtime.browser.beginCredentialHandoff();
    res.json(ownerControls(runtime).state());
  }));

  router.post("/browser/credentials/resume", asyncRoute(async (req, res) => {
    operationBody(req, []);
    await exactOwner(req, integration!, "Protected browser credential resume");
    const runtime = await exactRuntime(req, integration!);
    await runtime.browser.resumeAgentAfterCredentialHandoff();
    res.json(ownerControls(runtime).state());
  }));

  router.post("/browser/restart", asyncRoute(async (req, res) => {
    await exactOwner(req, integration!, "Protected browser restart");
    operationBody(req, []);
    const controls = ownerControls(await exactRuntime(req, integration!));
    await controls.stop();
    res.json(await controls.start());
  }));

  router.post("/browser/reset-profile", asyncRoute(async (req, res) => {
    await exactOwner(req, integration!, "Protected browser profile reset");
    const body = operationBody(req, ["confirmed"]);
    if (body.confirmed !== true) throw protectedError("Explicit protected profile reset confirmation is required", 400);
    const runtime = await exactRuntime(req, integration!);
    res.json(await ownerControls(runtime).resetProfile());
  }));

  router.post("/browser/paste-text", asyncRoute(async (req, res) => {
    // Reject agent-attributed callers before reading the owner paste field.
    await exactOwner(req, integration!, "Protected browser direct paste");
    const body = operationBody(req, ["text"]);
    if (typeof body.text !== "string" || !body.text) throw protectedError("Protected browser paste text is required", 400);
    const runtime = await exactRuntime(req, integration!);
    res.json(await ownerControls(runtime).pasteText(body.text));
  }));

  router.all("/browser/:operation", asyncRoute(async (req, res, next) => {
    if (!protectedBrowserSelectionFor(req)) { next(); return; }
    const statusRead = req.params.operation === "status" && req.method === "GET";
    if (!statusRead && req.method !== "POST") throw protectedError("Protected browser method is not allowed", 405);
    const operation = operationFromRequest(req);
    const runtime = await exactRuntime(req, integration!);
    if (!isBrowserAgentRequest(req) && operation.kind === "start") {
      await exactOwner(req, integration!, "Protected browser start");
      res.json(await ownerControls(runtime).start());
      return;
    }
    if (!isBrowserAgentRequest(req) && operation.kind === "stop") {
      await exactOwner(req, integration!, "Protected browser stop");
      res.json(await ownerControls(runtime).stop());
      return;
    }
    res.json(await runtime.browser.execute(operation));
  }));

  router.use((error: unknown, req: Request, res: Response, next: (error?: unknown) => void) => {
    if (!protectedBrowserSelectionFor(req)) { next(error); return; }
    sendError(res, error);
  });
  return router;
}

function asyncRoute(handler: (req: Request, res: Response, next: (error?: unknown) => void) => Promise<void>) {
  return (req: Request, res: Response, next: (error?: unknown) => void): void => { void handler(req, res, next).catch(next); };
}

export interface RegisteredProtectedViewer {
  handle: ProtectedBrowserViewerHandle;
  transport: ProtectedBrowserViewerTransport;
  handleMessage(message: Buffer, isBinary: boolean): Promise<void>;
  dispose(): Promise<void>;
}

export async function attachSelectedProtectedViewer(
  ws: WebSocket,
  selection: ProtectedBrowserRouteSelection,
  kind: "vnc" | "cdp",
  integration: ProtectedBrowserIntegration,
): Promise<RegisteredProtectedViewer> {
  if (kind !== "cdp") throw protectedError("Protected browser VNC transport is unavailable", 404);
  const openViewer = integration.openViewer;
  if (!openViewer) throw protectedError("Protected browser viewer integration is unavailable", 503);
  let runtime: ProtectedBrowserHttpRuntime | null;
  try { runtime = await integration.resolve(selection); }
  catch { throw protectedError("Exact protected browser runtime is unavailable"); }
  if (!runtime || runtime.browser.isRevoked || !exactProtectedBrowserBindingEqual(runtime.browser.currentBinding, selection.binding)) {
    throw protectedError("Exact protected browser runtime is unavailable");
  }
  let disposed = false;
  let handle: ProtectedBrowserViewerHandle | undefined;
  let transport: ProtectedBrowserViewerTransport | undefined;
  let unsubscribe: (() => void) | undefined;
  const close = async () => {
    if (disposed) return;
    disposed = true;
    unsubscribe?.();
    if (handle) runtime.browser.unregisterViewer(handle);
    if (transport) await Promise.resolve(transport.close()).catch(() => undefined);
    if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) ws.close(1008, "Protected browser authority ended");
  };
  try {
    // Viewer authority is established before the runtime transport is opened.
    handle = await runtime.browser.registerViewer(kind, close);
    const opened = await openViewer(selection, kind) ?? undefined;
    if (!opened) throw protectedError("Protected browser viewer is unavailable", 503);
    if (disposed || runtime.browser.isRevoked) {
      await Promise.resolve(opened.close()).catch(() => undefined);
      throw protectedError("Protected browser viewer authority was revoked");
    }
    transport = opened;
    const openedTransport = transport;
    unsubscribe = openedTransport.onMessage((data, isBinary) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(data, { binary: isBinary });
    });
    if (disposed || runtime.browser.isRevoked) {
      unsubscribe();
      unsubscribe = undefined;
      throw protectedError("Protected browser viewer authority was revoked");
    }
    const registeredHandle = handle;
    return {
      handle: registeredHandle,
      transport: openedTransport,
      handleMessage(message, isBinary) {
        return runtime.browser.handleViewerMessage(registeredHandle, async () => {
          await openedTransport.dispatch(message, isBinary);
        });
      },
      dispose: close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
