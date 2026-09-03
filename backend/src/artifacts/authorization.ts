import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getAgentProfile } from "../agent-profiles.js";
import {
  authorizeAgentToolCall,
  resolveCurrentStandardResourcesWitness,
} from "../agent-runtime.js";
import { authorizeProjectAction, canonicalizePolicyPath, pathIsWithin } from "../policy.js";
import { getProject } from "../projects.js";
import { getSessionAttachmentRoot } from "../protected-artifacts.js";
import { getSessionById, isLegacyPrivateSessionQuarantined, type SessionRow } from "../sessions.js";
import type { AgentProfileRow, ProjectRow } from "../workspace-types.js";
import type { ArtifactCatalogRow, ArtifactLocatorKind } from "./types.js";

export type ArtifactAuthorizationPurpose = "present" | "http";

export interface ArtifactSessionAuthorization {
  session: SessionRow;
  project: ProjectRow;
  profile: AgentProfileRow;
  standardResourcesAuthorized: boolean;
}

export class ArtifactAuthorizationError extends Error {
  readonly statusCode: number;
  readonly code: string;

  constructor(message: string, statusCode = 403, code = "artifact_denied") {
    super(message);
    this.name = "ArtifactAuthorizationError";
    this.statusCode = statusCode;
    this.code = code;
  }
}

export function authorizeArtifactSession(
  sessionId: string,
  purpose: ArtifactAuthorizationPurpose,
): ArtifactSessionAuthorization {
  const session = getSessionById(sessionId);
  if (!session) throw new ArtifactAuthorizationError("Artifact session was not found", 404, "artifact_not_found");
  if (isLegacyPrivateSessionQuarantined(session)) {
    throw new ArtifactAuthorizationError("Artifact session is unavailable", 404, "artifact_not_found");
  }
  if (session.pending_agent_switch !== null) {
    throw new ArtifactAuthorizationError("Artifact access is unavailable while the session changes agent", 409, "session_switching");
  }
  if (!session.project_id || !session.agent_profile_id) {
    throw new ArtifactAuthorizationError("Artifact session identity is unavailable", 403, "artifact_denied");
  }
  if (purpose === "present") {
    if (session.archived) throw new ArtifactAuthorizationError("Archived sessions cannot present new artifacts", 409, "session_archived");
    if (session.scheduled_job_id !== null || session.scheduled_run_id !== null) {
      throw new ArtifactAuthorizationError("Scheduled sessions cannot present artifacts", 403, "artifact_denied");
    }
  }

  const project = getProject(session.project_id);
  const profile = getAgentProfile(session.agent_profile_id);
  if (!project || !profile || project.cwd !== session.cwd) {
    throw new ArtifactAuthorizationError("Artifact session identity changed", 403, "artifact_denied");
  }
  const decision = authorizeProjectAction({
    cwd: session.cwd,
    actor: "interactive",
    agentProfileId: session.agent_profile_id,
  });
  if (!decision.allowed || decision.project?.id !== project.id || decision.agentProfile?.id !== profile.id) {
    throw new ArtifactAuthorizationError("Artifact session is no longer authorized", 403, "artifact_denied");
  }
  const witness = resolveCurrentStandardResourcesWitness({
    sourceSessionId: session.id,
    project,
    agentProfile: profile,
  });
  return { session, project, profile, standardResourcesAuthorized: Boolean(witness) };
}

function canonicalHome(): string {
  try { return fs.realpathSync.native(os.homedir()); }
  catch { return path.resolve(os.homedir()); }
}

function isExplicitlySecretPath(canonicalPath: string): boolean {
  const basename = path.basename(canonicalPath).toLowerCase();
  if (basename === ".env" || basename === ".env.backup") return true;
  const home = canonicalHome();
  const relative = path.relative(home, canonicalPath).split(path.sep).join("/");
  if (relative === ".pi/agent/auth.json" || relative === ".pi/agent/settings.json" || relative === ".pi/agent/models.json") return true;
  if (relative.startsWith(".pi/agent/sessions/")) return true;
  if (relative.includes("/.pi/browser-workbench/") || relative.startsWith(".pi/browser-workbench/")) return true;
  return false;
}

export function authorizeArtifactPath(
  authorization: ArtifactSessionAuthorization,
  targetPath: string,
  locatorKind?: ArtifactLocatorKind,
): { canonicalPath: string; stat: fs.Stats } {
  let canonicalPath: string;
  try {
    const requestedPath = path.resolve(authorization.session.cwd, targetPath.trim().replace(/^@/, ""));
    const requestedStat = fs.lstatSync(requestedPath);
    if (requestedStat.isSymbolicLink()) throw new Error("symlink");
    canonicalPath = canonicalizePolicyPath(targetPath, { cwd: authorization.session.cwd });
  } catch {
    throw new ArtifactAuthorizationError("Artifact file is unavailable", 404, "artifact_not_found");
  }
  const decision = authorizeAgentToolCall({
    cwd: authorization.session.cwd,
    project: authorization.project,
    agentProfile: authorization.profile,
    toolName: "read",
    params: { path: canonicalPath },
    sourceSessionId: authorization.session.id,
    standardResourcesAuthorized: authorization.standardResourcesAuthorized,
  });
  if (!decision.allowed || decision.canonicalPath !== canonicalPath) {
    throw new ArtifactAuthorizationError("Artifact file is unavailable", 404, "artifact_not_found");
  }

  const home = canonicalHome();
  const attachmentRootPath = getSessionAttachmentRoot(authorization.session.id);
  let attachmentRoot: string;
  try { attachmentRoot = fs.realpathSync.native(attachmentRootPath); }
  catch { attachmentRoot = path.resolve(attachmentRootPath); }
  const inHome = pathIsWithin(canonicalPath, home);
  const exactAttachmentChild = path.dirname(canonicalPath) === attachmentRoot;
  if (!inHome && !exactAttachmentChild) {
    throw new ArtifactAuthorizationError("Artifact file is outside the supported owner scope", 404, "artifact_not_found");
  }
  if (locatorKind === "session_attachment" && !exactAttachmentChild) {
    throw new ArtifactAuthorizationError("Artifact upload locator changed", 404, "artifact_not_found");
  }
  if (locatorKind === "home_file" && !inHome) {
    throw new ArtifactAuthorizationError("Artifact locator changed", 404, "artifact_not_found");
  }
  if (isExplicitlySecretPath(canonicalPath)) {
    throw new ArtifactAuthorizationError("Artifact file is unavailable", 404, "artifact_not_found");
  }

  const stat = fs.lstatSync(canonicalPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) {
    throw new ArtifactAuthorizationError("Artifact must be a safe single-link regular file", 404, "artifact_not_found");
  }
  return { canonicalPath, stat };
}

export function reauthorizeArtifactRow(
  sessionId: string,
  row: ArtifactCatalogRow,
): { authorization: ArtifactSessionAuthorization; canonicalPath: string; stat: fs.Stats } {
  const authorization = authorizeArtifactSession(sessionId, "http");
  const current = authorizeArtifactPath(authorization, row.locator_path, row.locator_kind);
  if (current.canonicalPath !== row.locator_path) {
    throw new ArtifactAuthorizationError("Artifact locator changed", 404, "artifact_not_found");
  }
  return { authorization, ...current };
}

function boundedDisplayPath(value: string): string {
  if (Buffer.byteLength(value, "utf8") <= 1024) return value;
  let head = Math.floor(value.length / 2);
  let tail = value.length - head;
  while (head > 1 && tail > 1) {
    const candidate = `${value.slice(0, head)}…${value.slice(value.length - tail)}`;
    if (Buffer.byteLength(candidate, "utf8") <= 1024) return candidate;
    if (head >= tail) head -= 1;
    else tail -= 1;
  }
  return "…";
}

export function artifactDisplayPath(
  authorization: ArtifactSessionAuthorization,
  canonicalPath: string,
  locatorKind: ArtifactLocatorKind,
  displayName: string,
): string {
  if (locatorKind === "session_attachment") return boundedDisplayPath(displayName);
  const relativeProject = path.relative(authorization.project.cwd, canonicalPath);
  if (relativeProject !== "" && !relativeProject.startsWith("..") && !path.isAbsolute(relativeProject)) {
    return boundedDisplayPath(relativeProject.split(path.sep).join("/"));
  }
  const relativeHome = path.relative(canonicalHome(), canonicalPath);
  return boundedDisplayPath(relativeHome && !relativeHome.startsWith("..") && !path.isAbsolute(relativeHome)
    ? `~/${relativeHome.split(path.sep).join("/")}`
    : displayName);
}
