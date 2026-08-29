import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { getStore, type SessionRow } from "./db.js";
import {
  getProtectedArtifactRootSnapshot,
  type ProtectedArtifactRootSnapshot,
} from "./protected-artifacts.js";
import { authorizeProjectAction, pathIsWithin } from "./policy.js";
import { fingerprintsEqual, type FileFingerprint } from "./session-metadata.js";
import type { ProjectRow } from "./workspace-types.js";

export const MAX_SESSION_HEADER_BYTES = 64 * 1024;
export const MAX_SESSION_HEADER_ID_BYTES = 256;

export interface BoundedSessionHeader {
  id: string;
  cwd: string;
  timestamp: string | number | null;
}

export interface ExactDurableTranscriptIdentity {
  path: string;
  stat: fs.Stats;
  fingerprint: FileFingerprint;
  header: BoundedSessionHeader;
  headerBytes: number;
  row: SessionRow;
  project: ProjectRow;
}

export interface ExactStandardTranscriptAuthorization extends ExactDurableTranscriptIdentity {}

/** Exact owning-chat authorization. Protected projects are intentionally valid. */
export interface ExactUiTranscriptAuthorization extends ExactDurableTranscriptIdentity {
  resolvedAgentProfileId: string;
}

export function fingerprintFromStat(stat: fs.Stats): FileFingerprint {
  return {
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    ino: Number(stat.ino) || 0,
  };
}

function lexicalHeaderCwd(value: string): string | null {
  let cwd = value.trim();
  if (cwd === "~") cwd = os.homedir();
  else if (cwd.startsWith("~/")) cwd = path.join(os.homedir(), cwd.slice(2));
  if (!cwd || !path.isAbsolute(cwd)) return null;
  return path.resolve(cwd);
}

function exactCanonicalRegularFile(filePath: string): { path: string; stat: fs.Stats } {
  const canonicalPath = path.resolve(filePath);
  const lexical = fs.lstatSync(canonicalPath);
  if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1
    || fs.realpathSync.native(canonicalPath) !== canonicalPath) {
    throw new Error("Transcript path is not a canonical single-link regular file");
  }
  return { path: canonicalPath, stat: lexical };
}

export function readBoundedSessionHeader(
  filePath: string,
  expectedFingerprint?: FileFingerprint,
  observeBytes?: (bytes: Uint8Array) => void,
): {
  path: string;
  stat: fs.Stats;
  fingerprint: FileFingerprint;
  header: BoundedSessionHeader;
  headerBytes: number;
} {
  const safe = exactCanonicalRegularFile(filePath);
  const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0);
  const fd = fs.openSync(safe.path, flags);
  try {
    const opened = fs.fstatSync(fd);
    const fingerprint = fingerprintFromStat(opened);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== safe.stat.dev || opened.ino !== safe.stat.ino
      || (expectedFingerprint && !fingerprintsEqual(fingerprint, expectedFingerprint))) {
      throw new Error("Transcript changed before bounded header authorization");
    }
    const maximum = Math.min(MAX_SESSION_HEADER_BYTES, fingerprint.size);
    const bytes = new Uint8Array(maximum);
    const single = new Uint8Array(1);
    let length = 0;
    let newline = false;
    while (length < maximum) {
      const count = fs.readSync(fd, single, 0, 1, null);
      if (count === 0) break;
      bytes[length++] = single[0]!;
      if (single[0] === 0x0a) { newline = true; break; }
    }
    if (!newline && fingerprint.size > length) throw new Error("Session header exceeds the bounded authorization limit");
    const prefix = bytes.subarray(0, length);
    observeBytes?.(prefix);
    const lineLength = newline ? length - 1 : length;
    let parsed: unknown;
    try {
      parsed = JSON.parse(Buffer.from(prefix.subarray(0, lineLength)).toString("utf8").replace(/\r$/, "").trim());
    } catch {
      throw new Error("Session header is malformed");
    }
    const value = parsed as { type?: unknown; id?: unknown; cwd?: unknown; timestamp?: unknown } | null;
    if (!value || value.type !== "session") throw new Error("Session header is missing");
    if (typeof value.id !== "string" || !value.id
      || Buffer.byteLength(value.id, "utf8") > MAX_SESSION_HEADER_ID_BYTES
      || /[\u0000-\u001f\u007f]/u.test(value.id)) {
      throw new Error("Session header id is invalid");
    }
    if (typeof value.cwd !== "string" || !value.cwd.trim()) throw new Error("Session header cwd is missing");
    if (!(value.timestamp === undefined || value.timestamp === null
      || typeof value.timestamp === "string" || typeof value.timestamp === "number")) {
      throw new Error("Session header timestamp is invalid");
    }
    const afterStat = fs.fstatSync(fd);
    const after = fingerprintFromStat(afterStat);
    if (!afterStat.isFile() || afterStat.nlink !== 1 || !fingerprintsEqual(after, fingerprint)) {
      throw new Error("Transcript changed during bounded header authorization");
    }
    return {
      path: safe.path,
      stat: opened,
      fingerprint,
      header: { id: value.id, cwd: value.cwd, timestamp: value.timestamp ?? null },
      headerBytes: length,
    };
  } finally {
    fs.closeSync(fd);
  }
}

export function universallyDeniedTranscriptPath(
  target: string,
  protectedArtifacts = getProtectedArtifactRootSnapshot(),
): boolean {
  if (!protectedArtifacts.piSessionStorageRoots.some((root) => pathIsWithin(target, root))) return true;
  if (protectedArtifacts.nonTranscriptReadDenyRoots.some((root) => pathIsWithin(target, root))) return true;
  return getStore().projects.some((project) => (
    project.access_policy.privacy_mode === "protected" && pathIsWithin(target, project.cwd)
  ));
}

export function classifyExternalStandardTranscriptHeader(
  filePath: string,
  header: BoundedSessionHeader,
): ProjectRow | null {
  const target = path.resolve(filePath);
  const protectedArtifacts = getProtectedArtifactRootSnapshot();
  if (universallyDeniedTranscriptPath(target, protectedArtifacts)) return null;
  const store = getStore();
  if (store.sessions.some((row) => row.pi_session_file === target || row.id === header.id)) return null;
  const cwd = lexicalHeaderCwd(header.cwd);
  if (!cwd) return null;
  const projects = store.projects.filter((project) => project.cwd === cwd);
  if (projects.length !== 1 || projects[0]!.access_policy.privacy_mode !== "standard") return null;
  return { ...projects[0]!, access_policy: { ...projects[0]!.access_policy } };
}

function authorizeExactDurableTranscriptIdentity(
  filePath: string,
  options: {
    expectedSessionId?: string;
    expectedFingerprint?: FileFingerprint;
    observedHeader?: ReturnType<typeof readBoundedSessionHeader>;
    protectedArtifacts?: ProtectedArtifactRootSnapshot;
  } = {},
): ExactDurableTranscriptIdentity | null {
  const protectedArtifacts = options.protectedArtifacts ?? getProtectedArtifactRootSnapshot();
  const requestedPath = path.resolve(filePath);
  if (universallyDeniedTranscriptPath(requestedPath, protectedArtifacts)) return null;
  let observed: ReturnType<typeof readBoundedSessionHeader>;
  try {
    observed = options.observedHeader ?? readBoundedSessionHeader(requestedPath, options.expectedFingerprint);
  } catch {
    return null;
  }
  if (requestedPath !== observed.path || universallyDeniedTranscriptPath(observed.path, protectedArtifacts)) return null;
  if (options.expectedFingerprint && !fingerprintsEqual(observed.fingerprint, options.expectedFingerprint)) return null;
  if (options.expectedSessionId !== undefined && observed.header.id !== options.expectedSessionId) return null;

  const store = getStore();
  const pathOwners = store.sessions.filter((row) => row.pi_session_file === observed.path);
  const idOwners = store.sessions.filter((row) => row.id === observed.header.id);
  if (pathOwners.length !== 1 || idOwners.length !== 1 || pathOwners[0] !== idOwners[0]) return null;
  const row = pathOwners[0]!;
  if (!row.project_id) return null;
  const projectsById = store.projects.filter((project) => project.id === row.project_id);
  const projectsByCwd = store.projects.filter((project) => project.cwd === row.cwd);
  if (projectsById.length !== 1 || projectsByCwd.length !== 1 || projectsById[0] !== projectsByCwd[0]) return null;
  const project = projectsById[0]!;
  if (project.cwd !== row.cwd || lexicalHeaderCwd(observed.header.cwd) !== project.cwd) return null;

  return { ...observed, row: { ...row }, project: { ...project, access_policy: { ...project.access_policy } } };
}

export function authorizeExactStandardTranscript(
  filePath: string,
  options: {
    expectedSessionId?: string;
    expectedFingerprint?: FileFingerprint;
    observedHeader?: ReturnType<typeof readBoundedSessionHeader>;
    protectedArtifacts?: ProtectedArtifactRootSnapshot;
  } = {},
): ExactStandardTranscriptAuthorization | null {
  const identity = authorizeExactDurableTranscriptIdentity(filePath, options);
  if (!identity || identity.row.legacy_private_session_quarantine !== false
    || identity.project.access_policy.privacy_mode !== "standard") return null;
  return identity;
}

export function authorizeExactUiTranscript(
  filePath: string,
  options: {
    expectedSessionId?: string;
    expectedFingerprint?: FileFingerprint;
    observedHeader?: ReturnType<typeof readBoundedSessionHeader>;
    protectedArtifacts?: ProtectedArtifactRootSnapshot;
  } = {},
): ExactUiTranscriptAuthorization | null {
  const identity = authorizeExactDurableTranscriptIdentity(filePath, options);
  if (!identity || identity.row.legacy_private_session_quarantine !== false
    || identity.row.agent_profile_id === undefined) return null;
  const decision = authorizeProjectAction({
    cwd: identity.row.cwd,
    actor: "interactive",
    agentProfileId: identity.row.agent_profile_id,
  });
  if (!decision.allowed || decision.project?.id !== identity.project.id || !decision.agentProfile) return null;
  return { ...identity, resolvedAgentProfileId: decision.agentProfile.id };
}

export function exactUiTranscriptAuthorizationsEqual(
  left: ExactUiTranscriptAuthorization,
  right: ExactUiTranscriptAuthorization,
): boolean {
  return left.path === right.path
    && left.row.id === right.row.id
    && left.row.cwd === right.row.cwd
    && left.row.project_id === right.row.project_id
    && left.row.agent_profile_id === right.row.agent_profile_id
    && left.project.id === right.project.id
    && left.project.cwd === right.project.cwd
    && left.resolvedAgentProfileId === right.resolvedAgentProfileId
    && fingerprintsEqual(left.fingerprint, right.fingerprint);
}
