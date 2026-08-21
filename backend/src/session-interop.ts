import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { getAgentProfile } from "./agent-profiles.js";
import { getStore } from "./db.js";
import { getSessionAttachmentRoot } from "./protected-artifacts.js";
import { authorizeProjectAction } from "./policy.js";
import { getProjectByCwd } from "./projects.js";
import { getSessionById, type SessionRow } from "./sessions.js";

export const SESSION_LIST_TOOL_NAME = "session_list";
export const SESSION_READ_TOOL_NAME = "session_read";
export const SESSION_ATTACHMENTS_TOOL_NAME = "session_attachments";
export const SESSION_INTEROP_TOOL_NAMES = new Set([
  SESSION_LIST_TOOL_NAME,
  SESSION_READ_TOOL_NAME,
  SESSION_ATTACHMENTS_TOOL_NAME,
]);

const MAX_LIST_LIMIT = 100;
const MAX_READ_LINES = 200;
const MAX_READ_BYTES = 48 * 1024;
const READ_CHUNK_BYTES = 64 * 1024;
const MAX_ATTACHMENT_RESULTS = 100;

export type SessionPrivacyClass = "standard" | "protected" | "unknown";

export function classifySessionPrivacy(row: SessionRow | undefined): SessionPrivacyClass {
  if (!row || row.legacy_private_session_quarantine || !row.project_id) return "unknown";
  const project = getProjectByCwd(row.cwd);
  if (!project || project.id !== row.project_id) return "unknown";
  return project.access_policy.privacy_mode;
}

function requireLiveSourceSession(sourceSessionId: string): SessionRow {
  const source = getSessionById(sourceSessionId);
  const profile = source?.agent_profile_id ? getAgentProfile(source.agent_profile_id) : undefined;
  const authorization = source && profile
    ? authorizeProjectAction({ cwd: source.cwd, actor: "interactive", agentProfileId: profile.id })
    : { allowed: false as const };
  if (!source || source.legacy_private_session_quarantine || !authorization.allowed) {
    throw new Error("Source session is unavailable for session interop");
  }
  return source;
}

function requireStandardTarget(targetSessionId: string): SessionRow {
  const target = getSessionById(targetSessionId);
  if (classifySessionPrivacy(target) !== "standard") {
    throw new Error("Target session is not available for cross-session inspection");
  }
  return target!;
}

function canonicalExactRegularFile(filePath: string): { path: string; stat: fs.Stats } {
  const absolute = path.resolve(filePath);
  const lexical = fs.lstatSync(absolute);
  if (!lexical.isFile() || lexical.isSymbolicLink() || lexical.nlink !== 1) {
    throw new Error("Session artifact is not a safe regular file");
  }
  if (fs.realpathSync.native(absolute) !== absolute) {
    throw new Error("Session artifact path is not canonical");
  }
  return { path: absolute, stat: lexical };
}

function targetStillStandard(target: SessionRow, expectedPath?: string): boolean {
  const current = getSessionById(target.id);
  return Boolean(
    current
    && classifySessionPrivacy(current) === "standard"
    && (!expectedPath || current.pi_session_file === expectedPath),
  );
}

export function classifyReadableStandardArtifact(canonicalPath: string): {
  kind: "transcript" | "attachment";
  sessionId: string;
} | null {
  const target = path.resolve(canonicalPath);
  try {
    const stat = fs.lstatSync(target);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || fs.realpathSync.native(target) !== target) return null;
  } catch {
    return null;
  }
  for (const row of getStore().sessions) {
    if (classifySessionPrivacy(row) !== "standard") continue;
    if (row.pi_session_file && path.resolve(row.pi_session_file) === target) {
      return { kind: "transcript", sessionId: row.id };
    }
    const attachmentRoot = path.resolve(getSessionAttachmentRoot(row.id));
    const relative = path.relative(attachmentRoot, target);
    if (relative && !relative.startsWith("..") && !path.isAbsolute(relative)) {
      return { kind: "attachment", sessionId: row.id };
    }
  }
  return null;
}

function sessionMetadata(row: SessionRow) {
  return {
    id: row.id,
    title: row.title,
    cwd: row.cwd,
    provider: row.provider,
    model: row.model,
    created_at: row.created_at,
    last_active: row.last_active,
    archived: Boolean(row.archived),
    has_transcript: Boolean(row.pi_session_file),
    has_attachments: fs.existsSync(getSessionAttachmentRoot(row.id)),
  };
}

export function listStandardSessions(options: {
  offset?: number;
  limit?: number;
  includeArchived?: boolean;
} = {}) {
  const offset = options.offset ?? 0;
  const limit = options.limit ?? 50;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("offset must be a non-negative integer");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_LIST_LIMIT) {
    throw new Error(`limit must be between 1 and ${MAX_LIST_LIMIT}`);
  }
  const rows = getStore().sessions
    .filter((row) => classifySessionPrivacy(row) === "standard")
    .filter((row) => options.includeArchived || !row.archived)
    .sort((left, right) => right.last_active - left.last_active || left.id.localeCompare(right.id));
  const selected = rows.slice(offset, offset + limit);
  return {
    sessions: selected.map(sessionMetadata),
    next_offset: offset + selected.length < rows.length ? offset + selected.length : null,
  };
}

export function readStandardSessionLines(targetSessionId: string, options: {
  offset?: number;
  limit?: number;
} = {}) {
  const offset = options.offset ?? 1;
  const limit = options.limit ?? 100;
  if (!Number.isSafeInteger(offset) || offset < 1) throw new Error("offset must be a positive 1-based line number");
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_READ_LINES) {
    throw new Error(`limit must be between 1 and ${MAX_READ_LINES}`);
  }
  const target = requireStandardTarget(targetSessionId);
  if (!target.pi_session_file) throw new Error("Target session has no materialized transcript");
  const expectedPath = target.pi_session_file;
  const safe = canonicalExactRegularFile(expectedPath);
  const noFollow = typeof fs.constants.O_NOFOLLOW === "number" ? fs.constants.O_NOFOLLOW : 0;
  const descriptor = fs.openSync(safe.path, fs.constants.O_RDONLY | noFollow);
  const lines: string[] = [];
  let currentLine = 1;
  let selectedBytes = 0;
  let selectedLine = Buffer.alloc(0);
  let position = 0;
  let reachedEof = false;
  let byteLimited = false;
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || opened.nlink !== 1 || opened.dev !== safe.stat.dev || opened.ino !== safe.stat.ino) {
      throw new Error("Session transcript changed before it could be read");
    }
    const chunk = Buffer.allocUnsafe(READ_CHUNK_BYTES);
    while (lines.length < limit && selectedBytes < MAX_READ_BYTES) {
      const count = fs.readSync(descriptor, chunk, 0, chunk.length, position);
      if (count === 0) {
        reachedEof = true;
        if (currentLine >= offset && selectedLine.length > 0) {
          if (selectedBytes + selectedLine.length > MAX_READ_BYTES) byteLimited = true;
          else lines.push(selectedLine.toString("utf8"));
        }
        break;
      }
      position += count;
      let start = 0;
      for (let index = 0; index < count && lines.length < limit; index++) {
        if (chunk[index] !== 0x0a) continue;
        if (currentLine >= offset) {
          const segment = chunk.subarray(start, index);
          if (selectedBytes + selectedLine.length + segment.length + 1 > MAX_READ_BYTES) {
            byteLimited = true;
            start = count;
            break;
          }
          selectedLine = Buffer.concat([selectedLine, segment]);
          lines.push(selectedLine.toString("utf8"));
          selectedBytes += selectedLine.length + 1;
          selectedLine = Buffer.alloc(0);
        }
        currentLine++;
        start = index + 1;
      }
      if (byteLimited) break;
      if (start < count && currentLine >= offset && lines.length < limit) {
        const segment = chunk.subarray(start, count);
        if (selectedLine.length + segment.length > MAX_READ_BYTES) {
          throw new Error("A transcript line exceeds the session_read byte bound");
        }
        selectedLine = Buffer.concat([selectedLine, segment]);
      }
    }
    if (byteLimited && lines.length === 0) {
      throw new Error("A transcript line exceeds the session_read byte bound");
    }
    const after = fs.fstatSync(descriptor);
    if (after.dev !== safe.stat.dev || after.ino !== safe.stat.ino || !targetStillStandard(target, expectedPath)) {
      throw new Error("Session privacy or transcript identity changed during read");
    }
  } finally {
    fs.closeSync(descriptor);
  }
  return {
    session: sessionMetadata(target),
    offset,
    lines,
    next_offset: !reachedEof && lines.length > 0 ? offset + lines.length : null,
    byte_limited: byteLimited,
  };
}

export function listStandardSessionAttachments(targetSessionId: string) {
  const target = requireStandardTarget(targetSessionId);
  const root = getSessionAttachmentRoot(target.id);
  if (!fs.existsSync(root)) return { session_id: target.id, attachments: [] };
  const rootStat = fs.lstatSync(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || fs.realpathSync.native(root) !== root) {
    throw new Error("Session attachment root is unsafe");
  }
  const attachments = fs.readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isFile() && !entry.isSymbolicLink())
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, MAX_ATTACHMENT_RESULTS)
    .map((entry) => {
      const filePath = path.join(root, entry.name);
      const safe = canonicalExactRegularFile(filePath);
      return { name: entry.name, path: safe.path, size: safe.stat.size, modified_at: safe.stat.mtimeMs };
    });
  if (!targetStillStandard(target)) throw new Error("Session privacy changed during attachment listing");
  return { session_id: target.id, attachments };
}

export function createSessionInteropToolDefinitions(sourceSessionId: string): ToolDefinition[] {
  const execute = async (operation: () => unknown) => {
    requireLiveSourceSession(sourceSessionId);
    const value = operation();
    return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} };
  };
  return [
    defineTool({
      name: SESSION_LIST_TOOL_NAME,
      label: "List Standard sessions",
      description: "List bounded metadata for non-Protected Wayang sessions. Protected and unclassified sessions are omitted.",
      promptSnippet: "List non-Protected Wayang sessions available for cross-session inspection",
      promptGuidelines: ["Use session_list before session_read when the exact target session ID is unknown."],
      parameters: Type.Object({
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_LIST_LIMIT })),
        include_archived: Type.Optional(Type.Boolean()),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return execute(() => listStandardSessions({
          offset: params.offset,
          limit: params.limit,
          includeArchived: params.include_archived,
        }));
      },
    }),
    defineTool({
      name: SESSION_READ_TOOL_NAME,
      label: "Read Standard session",
      description: "Read a bounded JSONL segment from one non-Protected Wayang session. Protected, quarantined, and unknown sessions are denied.",
      promptSnippet: "Read bounded transcript lines from a non-Protected Wayang session",
      promptGuidelines: ["Treat readable Standard transcripts as entrusted context: do not unnecessarily reproduce credentials or sensitive personal data."],
      parameters: Type.Object({
        session_id: Type.String({ minLength: 1, maxLength: 128 }),
        offset: Type.Optional(Type.Integer({ minimum: 1 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: MAX_READ_LINES })),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return execute(() => readStandardSessionLines(params.session_id, { offset: params.offset, limit: params.limit }));
      },
    }),
    defineTool({
      name: SESSION_ATTACHMENTS_TOOL_NAME,
      label: "List Standard session attachments",
      description: "List bounded metadata and exact read-only paths for regular attachments owned by one non-Protected Wayang session.",
      promptSnippet: "List read-only attachment paths for a non-Protected Wayang session",
      promptGuidelines: ["Use the ordinary read tool on an exact returned path; cross-session writes remain forbidden."],
      parameters: Type.Object({
        session_id: Type.String({ minLength: 1, maxLength: 128 }),
      }, { additionalProperties: false }),
      async execute(_toolCallId, params) {
        return execute(() => listStandardSessionAttachments(params.session_id));
      },
    }),
  ];
}
