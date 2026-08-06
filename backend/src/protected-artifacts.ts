import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { commandGuardIdentityPinPath } from "./command-guard-pin.js";
import { getConfig } from "./config.js";
import { getStore } from "./db.js";

export const LEGACY_ATTACHMENT_ROOT = "/tmp/wayang-attachments";
export const ATTACHMENTS_DIRECTORY_NAME = "attachments";
export const PSEUDO_CONTROL_ROOTS = ["/proc", "/sys", "/dev"] as const;

function canonicalExistingOrResolved(target: string): string {
  const absolute = path.resolve(target);
  try {
    return fs.realpathSync.native(absolute);
  } catch {
    const missing: string[] = [];
    let cursor = absolute;
    while (!fs.existsSync(cursor)) {
      const parent = path.dirname(cursor);
      if (parent === cursor) return absolute;
      missing.unshift(path.basename(cursor));
      cursor = parent;
    }
    try {
      return path.join(fs.realpathSync.native(cursor), ...missing);
    } catch {
      return absolute;
    }
  }
}

/** Retain both lexical aliases and canonical targets for OS-sandbox mounts. */
function uniqueCanonicalPaths(paths: Iterable<string>): string[] {
  return [...new Set([...paths].flatMap((target) => [path.resolve(target), canonicalExistingOrResolved(target)]))];
}

export function getWayangDataRoot(): string {
  return canonicalExistingOrResolved(getConfig().dataDir);
}

/** Source and built layouts both place this module two levels below checkout root. */
export function getWayangCheckoutRoot(): string {
  return canonicalExistingOrResolved(path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../.."));
}

/** Launcher configuration is sensitive even when the checkout is not a registered project. */
export function getWayangCheckoutSecretPaths(): string[] {
  const root = getWayangCheckoutRoot();
  return uniqueCanonicalPaths([
    path.join(root, ".env"),
    path.join(root, ".env.backup"),
  ]);
}

export function getAttachmentsRoot(): string {
  return path.join(getWayangDataRoot(), ATTACHMENTS_DIRECTORY_NAME);
}

export function validateAttachmentSessionId(sessionId: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(sessionId)) {
    throw new Error("Invalid attachment session id");
  }
  return sessionId;
}

export function getSessionAttachmentRoot(sessionId: string): string {
  return path.join(getAttachmentsRoot(), validateAttachmentSessionId(sessionId));
}

export function getPiAgentRoot(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim()
    || path.join(os.homedir(), ".pi", "agent");
  return canonicalExistingOrResolved(path.resolve(configured));
}

/** Pi's default/configured session roots are protected even before cataloging. */
export function getPiSessionStorageRoots(): string[] {
  const agentDir = getPiAgentRoot();
  const configuredSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR?.trim();
  return uniqueCanonicalPaths([
    path.join(path.resolve(agentDir), "sessions"),
    ...(configuredSessionDir ? [path.resolve(configuredSessionDir)] : []),
  ]);
}

/** Exact known transcript files cover custom SessionManager directories too. */
export function getKnownPiTranscriptPaths(): string[] {
  return uniqueCanonicalPaths(getStore().sessions.flatMap((session) => (
    session.pi_session_file ? [session.pi_session_file] : []
  )));
}

/** Managed browser profiles are bearer-sensitive regardless of project policy. */
export function getRegisteredProjectBrowserRoots(): string[] {
  return uniqueCanonicalPaths(getStore().projects.map((project) => (
    path.join(project.cwd, ".pi", "browser-workbench")
  )));
}

/** Documented project-root configuration files that may contain provider keys. */
export function getRegisteredProjectSecretPaths(): string[] {
  return uniqueCanonicalPaths(getStore().projects.flatMap((project) => [
    path.join(project.cwd, ".env"),
    path.join(project.cwd, ".env.backup"),
  ]));
}

/** Exact command-guard PIN aliases and canonical target; values are never opened here. */
export function getCommandGuardIdentityPinProtectedPaths(): string[] {
  return uniqueCanonicalPaths([commandGuardIdentityPinPath()]);
}

/** Exact global Pi files that direct tools must never expose to any profile. */
export function getPiSecretBearingPaths(): string[] {
  const agentDir = getPiAgentRoot();
  return uniqueCanonicalPaths([
    path.join(agentDir, "auth.json"),
    path.join(agentDir, "settings.json"),
    path.join(agentDir, "models.json"),
  ]);
}

/** Universal direct-tool/sandbox deny roots; backend and UI code remain unaffected. */
export function getProtectedArtifactReadRoots(): string[] {
  return uniqueCanonicalPaths([
    getWayangDataRoot(),
    LEGACY_ATTACHMENT_ROOT,
    ...getPiSessionStorageRoots(),
    ...getKnownPiTranscriptPaths(),
    ...getCommandGuardIdentityPinProtectedPaths(),
    ...getPiSecretBearingPaths(),
    ...getWayangCheckoutSecretPaths(),
    ...getRegisteredProjectSecretPaths(),
    ...getRegisteredProjectBrowserRoots(),
    ...PSEUDO_CONTROL_ROOTS,
  ]);
}

export function getProtectedArtifactWriteRoots(): string[] {
  return getProtectedArtifactReadRoots();
}

/** Restricted profiles additionally receive no direct access anywhere in Pi's global root. */
export function getRestrictedAgentArtifactRoots(): string[] {
  return uniqueCanonicalPaths([getPiAgentRoot(), ...getProtectedArtifactReadRoots()]);
}
