import * as crypto from "node:crypto";
import type { Request, RequestHandler } from "express";
import { authorizeProjectAction } from "../policy.js";
import { listProjects } from "../projects.js";
import { getSessionById } from "../sessions.js";
import { WorkspaceStoreError } from "../workspace-types.js";

export const APPS_AGENT_TOKEN_HEADER = "x-wayang-apps-agent-token";
export const APPS_AGENT_SOURCE_SESSION_HEADER = "x-wayang-source-session-id";
export const APPS_AGENT_ACTOR_HEADER = "x-wayang-apps-actor";

const appsAgentSecret = crypto.randomBytes(32);
const agentSourceSessions = new WeakMap<Request, string>();

interface AppsAgentCapability {
  sourceSessionId: string;
  token: string;
}

interface AppsAgentCapabilityBridge {
  forPiSession(piSessionId: string): AppsAgentCapability | undefined;
}

declare global {
  // Trusted in-process Pi extensions use this bridge. It is deliberately not
  // exported through process.env, HTTP responses, logs, or child processes.
  // eslint-disable-next-line no-var
  var __wayang_apps_agent_capabilities: AppsAgentCapabilityBridge | undefined;
}

function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const normalized = address.toLowerCase().split("%", 1)[0];
  return normalized === "127.0.0.1" || normalized === "::1" || normalized === "::ffff:127.0.0.1" ||
    normalized.startsWith("127.") || normalized.startsWith("::ffff:127.");
}

function tokenForSourceSession(sourceSessionId: string): string {
  return crypto.createHmac("sha256", appsAgentSecret).update(sourceSessionId, "utf8").digest("base64url");
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

/** Test/internal helper; returns no capability for nonexistent durable sessions. */
export function appsAgentAuthorizationForSourceSession(sourceSessionId: string): AppsAgentCapability | undefined {
  if (!getSessionById(sourceSessionId)) return undefined;
  return { sourceSessionId, token: tokenForSourceSession(sourceSessionId) };
}

export function installAppsAgentToken(): void {
  // Delete legacy/process-wide bearer names if an older runtime set one.
  delete process.env.WAYANG_APPS_AGENT_TOKEN;
  globalThis.__wayang_apps_agent_capabilities = {
    forPiSession(piSessionId: string) {
      const sourceSessionId = webSessionIdForPiSession(piSessionId);
      return sourceSessionId ? appsAgentAuthorizationForSourceSession(sourceSessionId) : undefined;
    },
  };
}

export function clearAppsAgentToken(): void {
  delete process.env.WAYANG_APPS_AGENT_TOKEN;
  delete globalThis.__wayang_apps_agent_capabilities;
}

export function isAppsAgentRequest(req: Request): boolean {
  return agentSourceSessions.has(req);
}

export function getAppsAgentSourceSessionId(req: Request): string | undefined {
  return agentSourceSessions.get(req);
}

/** Recognize only a session-attributed, process-private capability on loopback. */
export const recognizeAppsAgent: RequestHandler = (req, res, next) => {
  const rawToken = req.headers[APPS_AGENT_TOKEN_HEADER];
  const rawSource = req.headers[APPS_AGENT_SOURCE_SESSION_HEADER];
  const rawActor = req.headers[APPS_AGENT_ACTOR_HEADER];
  if (rawToken === undefined && rawSource === undefined && rawActor === undefined) {
    next();
    return;
  }
  const token = Array.isArray(rawToken) ? "" : rawToken ?? "";
  const sourceSessionId = Array.isArray(rawSource) ? "" : rawSource ?? "";
  const actor = Array.isArray(rawActor) ? "" : rawActor ?? "";
  if (
    actor !== "agent"
    || !sourceSessionId
    || !isLoopbackAddress(req.socket.remoteAddress)
    || !getSessionById(sourceSessionId)
    || !constantTimeTokenEqual(token, sourceSessionId)
  ) {
    res.setHeader("Cache-Control", "no-store");
    res.status(401).json({ error: "Invalid internal Apps authorization; reload the Wayang session and retry" });
    return;
  }
  agentSourceSessions.set(req, sourceSessionId);
  next();
};

/** Reauthorize both source identity and requested target on every operation. */
export function authorizeAppsAgentTarget(req: Request, targetCwd: string | undefined): void {
  const sourceSessionId = getAppsAgentSourceSessionId(req);
  if (!sourceSessionId) return;
  const source = getSessionById(sourceSessionId);
  if (!source?.agent_profile_id) throw new WorkspaceStoreError("Apps source session is unavailable; reload the Wayang session and retry", 403);

  const sourceDecision = authorizeProjectAction({
    cwd: source.cwd,
    actor: "interactive",
    agentProfileId: source.agent_profile_id,
  });
  if (!sourceDecision.allowed) throw new WorkspaceStoreError(sourceDecision.reason ?? "Apps source session is unauthorized", 403);

  if (!targetCwd) throw new WorkspaceStoreError("Agent Apps requests require a target project or session", 400);
  const targetDecision = authorizeProjectAction({
    cwd: targetCwd,
    actor: "interactive",
    agentProfileId: source.agent_profile_id,
  });
  if (!targetDecision.allowed) {
    throw new WorkspaceStoreError(targetDecision.reason ?? "Source agent is not authorized for the target project", 403);
  }
}

/**
 * App manifest commands are unsandboxed. Until a deterministic long-lived app
 * sandbox exists, any protected project makes all agent launch/relaunch fail
 * closed. Manual authenticated UI launch remains available after human review.
 */
export function assertAgentAppLaunchSandboxAvailable(agentInitiated: boolean): void {
  if (!agentInitiated) return;
  if (listProjects().some((project) => project.access_policy.privacy_mode === "protected")) {
    throw new WorkspaceStoreError(
      "Agent start/restart is disabled while a protected project is registered because app manifest commands run unsandboxed. Review the app, then start or restart it manually from the authenticated Apps pane.",
      403,
    );
  }
}

export function assertAppsAgentLaunchAllowed(req: Request): void {
  assertAgentAppLaunchSandboxAvailable(isAppsAgentRequest(req));
}
