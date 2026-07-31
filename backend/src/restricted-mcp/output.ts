import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { RestrictedMcpServerAlias } from "./config.js";

export interface RestrictedMcpOutputLimits {
  readonly inlineBytes: number;
  readonly inlineLines: number;
  readonly spill: boolean;
}

/** Hard ceiling for any one fully serialized MCP result, including spills. */
export const MAX_RESTRICTED_MCP_SERIALIZED_RESULT_BYTES = 4 * 1024 * 1024;

export const RESTRICTED_MCP_OUTPUT_LIMITS: Readonly<Record<RestrictedMcpServerAlias, RestrictedMcpOutputLimits>> = Object.freeze({
  exasearch: Object.freeze({ inlineBytes: 24_000, inlineLines: 300, spill: false }),
  mempalace: Object.freeze({ inlineBytes: 12_000, inlineLines: 200, spill: true }),
  "public-readonly": Object.freeze({ inlineBytes: 12_000, inlineLines: 200, spill: true }),
});

export interface RestrictedMcpRenderedOutput {
  readonly text: string;
  readonly truncated: boolean;
  readonly artifact?: {
    readonly relativePath: string;
    readonly bytes: number;
    readonly sha256: string;
  };
}

function boundedPreview(input: string, maxBytes: number, maxLines: number): { text: string; truncated: boolean } {
  const lines = input.split("\n");
  let candidate = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : input;
  let truncated = lines.length > maxLines;
  const bytes = Buffer.from(candidate, "utf8");
  if (bytes.byteLength > maxBytes) {
    candidate = bytes.subarray(0, maxBytes).toString("utf8");
    // Drop a potentially partial replacement character from a split UTF-8 codepoint.
    if (candidate.endsWith("\ufffd")) candidate = candidate.slice(0, -1);
    truncated = true;
  }
  return { text: candidate, truncated };
}

function serializeBoundedResult(value: unknown): string {
  let conservativeBytes = 0;
  let nodes = 0;
  const add = (bytes: number): void => {
    conservativeBytes += bytes;
    if (conservativeBytes > MAX_RESTRICTED_MCP_SERIALIZED_RESULT_BYTES) {
      throw new Error("server result exceeds protected output limit");
    }
  };
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value, function boundedReplacer(key, current) {
      if (++nodes > 250_000) throw new Error("server result exceeds protected output limit");
      if (key && !Array.isArray(this)) {
        const encodedKey = JSON.stringify(key);
        add(Buffer.byteLength(encodedKey ?? "", "utf8") + 1);
      }
      if (current === null || typeof current !== "object") {
        const encoded = JSON.stringify(current);
        if (encoded !== undefined) add(Buffer.byteLength(encoded, "utf8") + 1);
      } else {
        // Conservatively reserve container punctuation before traversing it.
        add(2);
      }
      return current;
    });
  } catch (error) {
    if (error instanceof Error && error.message === "server result exceeds protected output limit") throw error;
    throw new Error("server returned an unsupported result");
  }
  if (serialized === undefined) serialized = "null";
  if (Buffer.byteLength(serialized, "utf8") > MAX_RESTRICTED_MCP_SERIALIZED_RESULT_BYTES) {
    throw new Error("server result exceeds protected output limit");
  }
  return serialized;
}

function requireSafeSessionId(sourceSessionId: string): void {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(sourceSessionId)) throw new Error("invalid source session binding");
}

function assertOwnedDirectory(target: string, exactPrivate: boolean): void {
  const link = fs.lstatSync(target);
  if (link.isSymbolicLink() || !link.isDirectory()) throw new Error("protected output parent is unsafe");
  const stat = fs.statSync(target);
  const uid = process.getuid?.();
  if (uid !== undefined && stat.uid !== uid) throw new Error("protected output parent has an invalid owner");
  const mode = stat.mode & 0o777;
  if (exactPrivate ? mode !== 0o700 : (mode & 0o022) !== 0) throw new Error("protected output parent has unsafe permissions");
}

function ensureDirectory(target: string, exactPrivate: boolean): void {
  try {
    fs.mkdirSync(target, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  assertOwnedDirectory(target, exactPrivate);
}

function writeProtectedArtifact(projectCwd: string, sourceSessionId: string, content: Buffer): NonNullable<RestrictedMcpRenderedOutput["artifact"]> {
  requireSafeSessionId(sourceSessionId);
  const canonicalProject = fs.realpathSync.native(projectCwd);
  if (canonicalProject !== projectCwd || !fs.statSync(canonicalProject).isDirectory()) throw new Error("project binding is no longer canonical");
  const wayangDir = path.join(canonicalProject, ".wayang");
  const resultsDir = path.join(wayangDir, "mcp-results");
  const sessionDir = path.join(resultsDir, sourceSessionId);
  ensureDirectory(wayangDir, false);
  ensureDirectory(resultsDir, true);
  ensureDirectory(sessionDir, true);
  if (fs.realpathSync.native(sessionDir) !== sessionDir) throw new Error("protected output path changed");

  const sha256 = crypto.createHash("sha256").update(content).digest("hex");
  const nonce = crypto.randomUUID();
  const filename = `${Date.now()}-${sha256.slice(0, 16)}-${nonce}.json`;
  const absolutePath = path.join(sessionDir, filename);
  const temporaryPath = path.join(sessionDir, `.tmp-${nonce}`);
  let fd: number | undefined;
  let published = false;
  let expectedIdentity: { dev: number; ino: number } | undefined;
  const cleanupPublishedArtifact = (): void => {
    if (!published || !expectedIdentity) return;
    try {
      const current = fs.lstatSync(absolutePath);
      // Remove only the inode created by this operation, never a raced-in path.
      if (!current.isSymbolicLink() && current.dev === expectedIdentity.dev && current.ino === expectedIdentity.ino) {
        fs.unlinkSync(absolutePath);
      }
    } catch { /* already absent or no longer our inode */ }
  };
  try {
    fd = fs.openSync(temporaryPath, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, content);
    fs.fsyncSync(fd);
    const temporaryStat = fs.fstatSync(fd);
    expectedIdentity = { dev: temporaryStat.dev, ino: temporaryStat.ino };
    fs.closeSync(fd);
    fd = undefined;
    // Hard-link publication is atomic and fails rather than replacing any
    // unexpected destination. The temporary name is never returned.
    fs.linkSync(temporaryPath, absolutePath);
    published = true;
    fs.unlinkSync(temporaryPath);
  } catch (error) {
    if (fd !== undefined) fs.closeSync(fd);
    fd = undefined;
    try { fs.unlinkSync(temporaryPath); } catch { /* no partial artifact remains */ }
    cleanupPublishedArtifact();
    throw error;
  }
  try {
    const stat = fs.lstatSync(absolutePath);
    if (!expectedIdentity
      || stat.dev !== expectedIdentity.dev
      || stat.ino !== expectedIdentity.ino
      || !stat.isFile()
      || stat.isSymbolicLink()
      || (stat.mode & 0o777) !== 0o600
      || stat.size !== content.byteLength) {
      throw new Error("protected output commit could not be verified");
    }
    if (fs.realpathSync.native(projectCwd) !== canonicalProject || fs.realpathSync.native(sessionDir) !== sessionDir) {
      throw new Error("protected output binding changed during commit");
    }
    return {
      relativePath: path.relative(canonicalProject, absolutePath),
      bytes: content.byteLength,
      sha256,
    };
  } catch (error) {
    cleanupPublishedArtifact();
    throw error;
  }
}

export function renderRestrictedMcpOutput(options: {
  readonly alias: RestrictedMcpServerAlias;
  readonly projectCwd: string;
  readonly sourceSessionId: string;
  readonly value: unknown;
}): RestrictedMcpRenderedOutput {
  const serialized = serializeBoundedResult(options.value);
  const limits = RESTRICTED_MCP_OUTPUT_LIMITS[options.alias];
  const preview = boundedPreview(serialized, limits.inlineBytes, limits.inlineLines);
  if (!preview.truncated) return { text: preview.text, truncated: false };
  if (!limits.spill) return { text: `${preview.text}\n[output truncated]`, truncated: true };
  const content = Buffer.from(serialized, "utf8");
  const artifact = writeProtectedArtifact(options.projectCwd, options.sourceSessionId, content);
  return {
    text: `${preview.text}\n[full protected result: ${artifact.relativePath}]`,
    truncated: true,
    artifact,
  };
}
