import * as fs from "node:fs";
import * as path from "node:path";

export interface SyntheticCorpusOptions {
  sessionCount: number;
  messagesPerSession: number;
  bytesPerSession?: number;
  projectCount?: number;
  prefix?: string;
}

export interface SyntheticSessionFixture {
  id: string;
  title: string;
  cwd: string;
  filePath: string;
  messageCount: number;
  bytes: number;
}

function deterministicId(prefix: string, index: number): string {
  return `${prefix}-${String(index).padStart(6, "0")}`;
}

/**
 * Writes public, deterministic pi JSONL under the isolated E2E session root.
 * It never inspects or copies real sessions. `bytesPerSession` supports the
 * 0.5/5/25/90MB complexity buckets without committing giant fixtures.
 */
export function createSyntheticCorpus(options: SyntheticCorpusOptions): SyntheticSessionFixture[] {
  const root = process.env.WAYANG_E2E_PI_SESSIONS_DIR;
  if (!root || !root.startsWith("/tmp/")) throw new Error("Synthetic sessions require isolated WAYANG_E2E_PI_SESSIONS_DIR under /tmp");
  const prefix = options.prefix ?? "public-synthetic";
  const projectCount = Math.max(1, options.projectCount ?? Math.min(10, options.sessionCount || 1));
  const fixtures: SyntheticSessionFixture[] = [];

  for (let index = 0; index < options.sessionCount; index++) {
    const id = deterministicId(prefix, index);
    const projectIndex = index % projectCount;
    const cwd = path.join(root, "projects", `project-${projectIndex}`);
    const sessionDirectory = path.join(root, `--synthetic-project-${projectIndex}--`);
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(sessionDirectory, { recursive: true });
    const title = `Public synthetic ${prefix} session ${String(index).padStart(6, "0")}`;
    const entries: Record<string, unknown>[] = [{
      type: "session", version: 3, id, timestamp: "2026-01-01T00:00:00.000Z", cwd,
    }];
    let parentId: string | null = null;
    const nameId = `${id}-name`;
    entries.push({ type: "session_info", id: nameId, parentId, timestamp: "2026-01-01T00:00:00.500Z", name: title });
    parentId = nameId;
    for (let messageIndex = 0; messageIndex < options.messagesPerSession; messageIndex++) {
      const entryId = `${id}-message-${messageIndex}`;
      const role = messageIndex % 2 === 0 ? "user" : "assistant";
      entries.push({
        type: "message",
        id: entryId,
        parentId,
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, 1) + messageIndex * 1_000).toISOString(),
        message: {
          role,
          content: `Public synthetic ${role} message ${messageIndex}. **Markdown fixture** with stable text.`,
          ...(role === "assistant" ? { provider: "offline", model: "deterministic-fixture" } : {}),
        },
      });
      parentId = entryId;
    }
    let content = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
    const targetBytes = options.bytesPerSession ?? 0;
    if (targetBytes > Buffer.byteLength(content)) {
      const paddingId = `${id}-padding`;
      const overhead = Buffer.byteLength(JSON.stringify({ type: "custom_message", id: paddingId, parentId, timestamp: "2026-01-01T01:00:00.000Z", customType: "synthetic-padding", content: "", display: true }) + "\n");
      const padding = "Public synthetic payload. ".repeat(Math.ceil(Math.max(0, targetBytes - Buffer.byteLength(content) - overhead) / 26));
      content += JSON.stringify({ type: "custom_message", id: paddingId, parentId, timestamp: "2026-01-01T01:00:00.000Z", customType: "synthetic-padding", content: padding, display: true }) + "\n";
    }
    const filePath = path.join(sessionDirectory, `${id}.jsonl`);
    fs.writeFileSync(filePath, content, { mode: 0o600 });
    fixtures.push({ id, title, cwd, filePath, messageCount: options.messagesPerSession, bytes: Buffer.byteLength(content) });
  }
  return fixtures;
}
