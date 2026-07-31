import * as crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import { authorizeProjectAction } from "../policy.js";
import { getProjectByCwd } from "../projects.js";
import { getSessionById, isLegacyPrivateSessionQuarantined } from "../sessions.js";
import { WorkspaceStoreError } from "../workspace-types.js";
import { resolveBrowserSessionLookup } from "./lookup.js";
import type { BrowserSessionLookup } from "./types.js";

export const BROWSER_AGENT_TOKEN_HEADER = "x-wayang-browser-agent-token";
export const BROWSER_AGENT_SOURCE_SESSION_HEADER = "x-wayang-source-session-id";

const browserAgentSecret = crypto.randomBytes(32);
const agentSourceSessions = new WeakMap<Request, string>();

interface BrowserAgentCapability {
  sourceSessionId: string;
  token: string;
}

interface BrowserAgentCapabilityBridge {
  forPiSession(piSessionId: string): BrowserAgentCapability | undefined;
}

declare global {
  // Trusted in-process Pi extensions use this bridge. It is deliberately not
  // exported through process.env, HTTP, logs, app children, or bash children.
  // eslint-disable-next-line no-var
  var __wayang_browser_agent_capabilities: BrowserAgentCapabilityBridge | undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function tokenForSourceSession(sourceSessionId: string): string {
  return crypto.createHmac("sha256", browserAgentSecret).update(sourceSessionId, "utf8").digest("base64url");
}

function constantTimeTokenEqual(candidate: string, sourceSessionId: string): boolean {
  const expected = Buffer.from(tokenForSourceSession(sourceSessionId), "utf8");
  const actual = Buffer.from(candidate, "utf8");
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

function webSessionIdForPiSession(piSessionId: string): string | undefined {
  const registry = (globalThis as typeof globalThis & {
    __pi_interview_pi_sessions?: Map<string, string>;
  }).__pi_interview_pi_sessions;
  return registry instanceof Map ? registry.get(piSessionId) : undefined;
}

/** Test/internal helper; returns no capability for missing or quarantined durable sessions. */
export function browserAgentAuthorizationForSourceSession(sourceSessionId: string): BrowserAgentCapability | undefined {
  const session = getSessionById(sourceSessionId);
  if (!session || isLegacyPrivateSessionQuarantined(session)) return undefined;
  return { sourceSessionId, token: tokenForSourceSession(sourceSessionId) };
}

export function installBrowserAgentToken(): void {
  // Delete the legacy process-wide bearer if an older runtime left it behind.
  // The replacement is session-attributed and available only in-process.
  delete process.env.WAYANG_BROWSER_AGENT_TOKEN;
  globalThis.__wayang_browser_agent_capabilities = {
    forPiSession(piSessionId: string) {
      const sourceSessionId = webSessionIdForPiSession(piSessionId);
      return sourceSessionId ? browserAgentAuthorizationForSourceSession(sourceSessionId) : undefined;
    },
  };
}

export function clearBrowserAgentToken(): void {
  delete process.env.WAYANG_BROWSER_AGENT_TOKEN;
  delete globalThis.__wayang_browser_agent_capabilities;
}

export function isBrowserAgentRequest(req: Request): boolean {
  return agentSourceSessions.has(req);
}

export function getBrowserAgentSourceSessionId(req: Request): string | undefined {
  return agentSourceSessions.get(req);
}

export type GenericBrowserWorkspaceClass = "standard" | "protected" | "quarantined" | "missing";

export interface DurableBrowserTargetStore {
  getSessionById(id: string): ReturnType<typeof getSessionById>;
  getProjectByCwd(cwd: string): ReturnType<typeof getProjectByCwd>;
  /** Accepted only for compatibility with old injected test stores; never consulted. */
  getAgentProfile?(id: string): unknown;
}

const durableBrowserTargetStore: DurableBrowserTargetStore = {
  getSessionById,
  getProjectByCwd,
};

function sessionIsQuarantined(session: ReturnType<typeof getSessionById>): boolean {
  // This legacy durable bit is only a generic permanent runtime quarantine
  // marker. It never carries provider, project, profile, or naming semantics.
  return Boolean(session && isLegacyPrivateSessionQuarantined(session));
}

function classifyDurableProject(cwd: string, store: DurableBrowserTargetStore): GenericBrowserWorkspaceClass {
  let project: ReturnType<typeof getProjectByCwd>;
  try {
    project = store.getProjectByCwd(cwd);
  } catch {
    return "quarantined";
  }
  if (!project) return "missing";
  return project.access_policy.privacy_mode === "protected" ? "protected" : "standard";
}

/** Store-only generic privacy/quarantine classifier; names and credentials are never inputs. */
export function classifyGenericBrowserTarget(
  lookup: BrowserSessionLookup,
  store: DurableBrowserTargetStore = durableBrowserTargetStore,
): GenericBrowserWorkspaceClass {
  let sessionClass: GenericBrowserWorkspaceClass = "missing";
  const sessionId = typeof lookup.sessionId === "string" ? lookup.sessionId.trim() : "";
  if (sessionId) {
    const session = store.getSessionById(sessionId);
    if (sessionIsQuarantined(session)) sessionClass = "quarantined";
    else if (session) sessionClass = classifyDurableProject(session.cwd, store);
  }
  // Classify both dimensions independently so a mismatched pair cannot hide a
  // Protected or quarantined cwd before durable lookup cross-checking.
  const cwd = typeof lookup.projectCwd === "string" ? lookup.projectCwd.trim() : "";
  const cwdClass = cwd ? classifyDurableProject(cwd, store) : "missing";
  if (sessionClass === "quarantined" || cwdClass === "quarantined") return "quarantined";
  if (sessionClass === "protected" || cwdClass === "protected") return "protected";
  if (sessionClass === "standard" || cwdClass === "standard") return "standard";
  return "missing";
}

export function classifyGenericBrowserSourceSession(
  sourceSessionId: unknown,
  store: DurableBrowserTargetStore = durableBrowserTargetStore,
): GenericBrowserWorkspaceClass {
  if (typeof sourceSessionId !== "string" || !sourceSessionId.trim()) return "missing";
  const session = store.getSessionById(sourceSessionId.trim());
  if (!session) return "missing";
  if (sessionIsQuarantined(session)) return "quarantined";
  return classifyDurableProject(session.cwd, store);
}

/** Generic browser routes remain Standard-only until protected route/runtime integration is mounted. */
export function assertGenericBrowserTargetAllowed(lookup: BrowserSessionLookup): void {
  const classification = classifyGenericBrowserTarget(lookup);
  if (classification === "protected" || classification === "quarantined") {
    throw new WorkspaceStoreError("Protected targets require capability-bound browser authority", 403);
  }
}

/** Pre-capability guard for the source header and query-addressable target. */
export const rejectProtectedGenericBrowserRequest: RequestHandler = (req, res, next) => {
  const source = req.headers[BROWSER_AGENT_SOURCE_SESSION_HEADER];
  const sourceSessionId = Array.isArray(source) ? "" : source;
  const lookup: BrowserSessionLookup = {
    sessionId: typeof req.query.session_id === "string" ? req.query.session_id : undefined,
    projectCwd: typeof req.query.project_cwd === "string" ? req.query.project_cwd : undefined,
  };
  const sourceClass = classifyGenericBrowserSourceSession(sourceSessionId);
  const targetClass = classifyGenericBrowserTarget(lookup);
  if (sourceClass === "protected" || sourceClass === "quarantined" || targetClass === "protected" || targetClass === "quarantined") {
    res.setHeader("Cache-Control", "no-store");
    res.status(403).json({ error: "Protected targets require capability-bound browser authority" });
    return;
  }
  next();
};

/**
 * Recognize only a session-attributed, process-private capability arriving on
 * loopback. Mount this middleware at /api/browser, never at the API root.
 */
export const recognizeBrowserAgent: RequestHandler = (req, res, next) => {
  const rawToken = req.headers[BROWSER_AGENT_TOKEN_HEADER];
  const rawSource = req.headers[BROWSER_AGENT_SOURCE_SESSION_HEADER];
  if (rawToken === undefined && rawSource === undefined) {
    next();
    return;
  }
  const token = Array.isArray(rawToken) ? "" : rawToken ?? "";
  const sourceSessionId = Array.isArray(rawSource) ? "" : rawSource ?? "";
  if (
    !sourceSessionId
    || !isLoopbackAddress(req.socket.remoteAddress)
    || !getSessionById(sourceSessionId)
    || !constantTimeTokenEqual(token, sourceSessionId)
  ) {
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "Invalid internal browser authorization" });
    return;
  }
  agentSourceSessions.set(req, sourceSessionId);
  next();
};

/** Reauthorize both source identity and requested target on every operation. */
export function authorizeBrowserAgentTarget(req: Request, lookup: BrowserSessionLookup): void {
  const sourceSessionId = getBrowserAgentSourceSessionId(req);
  if (!sourceSessionId) return;
  const sourceClass = classifyGenericBrowserSourceSession(sourceSessionId);
  const targetClass = classifyGenericBrowserTarget(lookup);
  if (sourceClass === "protected" || sourceClass === "quarantined" || targetClass === "protected" || targetClass === "quarantined") {
    throw new WorkspaceStoreError("Protected browser requests require exact injected capability authority", 403);
  }
  // Resolve and cross-check a supplied session/project pair before evaluating
  // either source or target project authorization.
  const target = resolveBrowserSessionLookup(lookup);
  const source = getSessionById(sourceSessionId);
  if (!source?.agent_profile_id) throw new WorkspaceStoreError("Browser source session is unavailable", 403);

  const sourceDecision = authorizeProjectAction({
    cwd: source.cwd,
    actor: "interactive",
    agentProfileId: source.agent_profile_id,
  });
  if (!sourceDecision.allowed) throw new WorkspaceStoreError(sourceDecision.reason ?? "Browser source session is unauthorized", 403);

  const targetDecision = authorizeProjectAction({
    cwd: target.projectCwd,
    actor: "interactive",
    agentProfileId: source.agent_profile_id,
  });
  if (!targetDecision.allowed) {
    throw new WorkspaceStoreError(targetDecision.reason ?? "Source agent is not authorized for the target project", 403);
  }
}
