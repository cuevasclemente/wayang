import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { deserializeMessage, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { RestrictedMcpServerGrant } from "./config.js";
import { validateRestrictedMcpCommand } from "./config.js";

export interface RestrictedMcpToolMetadata {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
}

export interface RestrictedMcpPeer {
  listTools(options: { signal?: AbortSignal; timeoutMs: number }): Promise<readonly RestrictedMcpToolMetadata[]>;
  callTool(name: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs: number }): Promise<unknown>;
  close(): Promise<void>;
}

export interface RestrictedMcpPeerFactory {
  connect(options: {
    command: string;
    args: readonly string[];
    env: Readonly<Record<string, string>>;
    signal?: AbortSignal;
    timeoutMs: number;
  }): Promise<RestrictedMcpPeer>;
}

/** Slightly above the protected 4 MiB result cap for its JSON-RPC envelope. */
export const MAX_RESTRICTED_MCP_STDOUT_FRAME_BYTES = 4 * 1024 * 1024 + 512 * 1024;
const MAX_RESTRICTED_MCP_STDOUT_FRAME_SEGMENTS = 4_096;
const MAX_RESTRICTED_MCP_MESSAGES_PER_CHUNK = 4_096;

const SAFE_INHERITED_NAMES = Object.freeze([
  "USER",
  "LOGNAME",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
] as const);

/** Build a fresh object; never spread process.env. */
export function buildRestrictedMcpChildEnvironment(source: NodeJS.ProcessEnv = process.env): Readonly<Record<string, string>> {
  const result: Record<string, string> = { PATH: "/usr/local/bin:/usr/bin:/bin" };
  for (const name of SAFE_INHERITED_NAMES) {
    const value = source[name];
    if (typeof value === "string" && value.length > 0 && value.length <= 16_384 && !value.includes("\0")) result[name] = value;
  }
  return Object.freeze(result);
}

class BoundedNewlineJsonRpcFramer {
  #chunks: Buffer[] = [];
  #bytes = 0;

  push(chunk: Buffer): JSONRPCMessage[] {
    const messages: JSONRPCMessage[] = [];
    let offset = 0;
    while (offset < chunk.byteLength) {
      const newline = chunk.indexOf(0x0a, offset);
      const end = newline === -1 ? chunk.byteLength : newline;
      const segmentBytes = end - offset;
      if (this.#bytes + segmentBytes > MAX_RESTRICTED_MCP_STDOUT_FRAME_BYTES) {
        this.clear();
        throw new Error("restricted MCP stdout framing failed");
      }
      if (segmentBytes > 0) {
        if (this.#chunks.length >= MAX_RESTRICTED_MCP_STDOUT_FRAME_SEGMENTS) {
          this.clear();
          throw new Error("restricted MCP stdout framing failed");
        }
        // Copy so a short pending segment cannot retain an attacker-sized chunk.
        this.#chunks.push(Buffer.from(chunk.subarray(offset, end)));
        this.#bytes += segmentBytes;
      }
      if (newline === -1) break;
      const frame = this.#chunks.length === 0
        ? Buffer.alloc(0)
        : this.#chunks.length === 1
          ? this.#chunks[0]!
          : Buffer.concat(this.#chunks, this.#bytes);
      this.clear();
      try {
        const line = frame.toString("utf8").replace(/\r$/, "");
        if (messages.length >= MAX_RESTRICTED_MCP_MESSAGES_PER_CHUNK) {
          throw new Error("restricted MCP stdout framing failed");
        }
        messages.push(deserializeMessage(line));
      } catch {
        throw new Error("restricted MCP stdout framing failed");
      }
      offset = newline + 1;
    }
    return messages;
  }

  hasPendingFrame(): boolean {
    return this.#bytes > 0;
  }

  clear(): void {
    this.#chunks = [];
    this.#bytes = 0;
  }
}

class StrictStdioClientTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  readonly #framer = new BoundedNewlineJsonRpcFramer();
  #process?: ChildProcessWithoutNullStreams;
  #framingFailed = false;

  constructor(readonly options: { command: string; args: readonly string[]; env: Readonly<Record<string, string>> }) {}

  async start(): Promise<void> {
    if (this.#process) throw new Error("restricted MCP transport already started");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.options.command, [...this.options.args], {
        cwd: "/",
        env: { ...this.options.env },
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.#process = child;
      child.once("error", (error) => {
        reject(error);
        this.onerror?.(error);
      });
      child.once("spawn", resolve);
      child.once("close", () => {
        if (this.#process === child) this.#process = undefined;
        if (this.#framer.hasPendingFrame()) this.#failFraming();
        this.#framer.clear();
        this.onclose?.();
      });
      child.stdin.on("error", () => this.onerror?.(new Error("restricted MCP stdio failed")));
      child.stdout.on("error", () => this.#failFraming());
      child.stdout.on("data", (chunk: Buffer) => {
        if (this.#framingFailed) return;
        try {
          for (const message of this.#framer.push(chunk)) this.onmessage?.(message);
        } catch {
          this.#failFraming();
        }
      });
      // Never inherit or retain stderr. It may contain launcher paths, provider
      // bodies, or credential diagnostics.
      child.stderr.resume();
    });
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const stdin = this.#process?.stdin;
    if (!stdin) throw new Error("restricted MCP transport is not connected");
    await new Promise<void>((resolve, reject) => {
      stdin.write(serializeMessage(message), (error) => error ? reject(error) : resolve());
    });
  }

  async close(): Promise<void> {
    const child = this.#process;
    this.#process = undefined;
    this.#framer.clear();
    if (!child) return;
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try { child.stdin.end(); } catch { /* already closed */ }
    if (await this.#waitForClose(closed, 500)) return;
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGTERM"); } catch { /* already closed */ }
    }
    if (await this.#waitForClose(closed, 1_500)) return;
    if (child.exitCode === null && child.signalCode === null) {
      try { child.kill("SIGKILL"); } catch { /* already closed */ }
    }
    await this.#waitForClose(closed, 1_500);
  }

  #failFraming(): void {
    if (this.#framingFailed) return;
    this.#framingFailed = true;
    this.#framer.clear();
    this.onerror?.(new Error("restricted MCP stdout framing failed"));
    void this.close().catch(() => undefined);
  }

  async #waitForClose(closed: Promise<void>, timeoutMs: number): Promise<boolean> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        closed.then(() => true),
        new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export const sdkRestrictedMcpPeerFactory: RestrictedMcpPeerFactory = {
  async connect(options) {
    validateRestrictedMcpCommand(options.command);
    if (options.signal?.aborted) throw options.signal.reason ?? new Error("operation aborted");
    const transport = new StrictStdioClientTransport({
      command: options.command,
      args: options.args,
      env: options.env,
    });
    const client = new Client({ name: "wayang-restricted-mcp", version: "1" }, { capabilities: {} });
    try {
      await client.connect(transport, { signal: options.signal, timeout: options.timeoutMs, maxTotalTimeout: options.timeoutMs });
    } catch (error) {
      await transport.close().catch(() => undefined);
      throw error;
    }
    return {
      async listTools(request) {
        const tools: RestrictedMcpToolMetadata[] = [];
        let cursor: string | undefined;
        let pages = 0;
        do {
          if (++pages > 16) throw new Error("tool metadata limit exceeded");
          const response = await client.listTools(cursor ? { cursor } : undefined, {
            signal: request.signal,
            timeout: request.timeoutMs,
            maxTotalTimeout: request.timeoutMs,
          });
          for (const tool of response.tools) {
            tools.push({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema });
            if (tools.length > 512) throw new Error("tool metadata limit exceeded");
          }
          cursor = response.nextCursor;
        } while (cursor);
        return tools;
      },
      async callTool(name, args, request) {
        return client.callTool({ name, arguments: args }, undefined, {
          signal: request.signal,
          timeout: request.timeoutMs,
          maxTotalTimeout: request.timeoutMs,
        });
      },
      async close() {
        await client.close().catch(() => transport.close());
      },
    };
  },
};

export interface RestrictedMcpClientPoolOptions {
  readonly factory?: RestrictedMcpPeerFactory;
  readonly idleTimeoutMs?: number;
  readonly operationTimeoutMs?: number;
  readonly environment?: Readonly<Record<string, string>>;
}

interface PoolEntry {
  readonly peer: RestrictedMcpPeer;
  readonly signature: string;
  timer?: NodeJS.Timeout;
}

interface PendingConnection {
  promise: Promise<RestrictedMcpPeer>;
  readonly controller: AbortController;
  readonly signature: string;
}

function grantSignature(grant: RestrictedMcpServerGrant): string {
  return JSON.stringify([grant.command, grant.args]);
}

/** Per-source-session lazy pool. Never share an instance across runtimes. */
export class RestrictedMcpClientPool {
  readonly #factory: RestrictedMcpPeerFactory;
  readonly #idleTimeoutMs: number;
  readonly #operationTimeoutMs: number;
  readonly #environment: Readonly<Record<string, string>>;
  readonly #entries = new Map<string, PoolEntry>();
  readonly #connecting = new Map<string, PendingConnection>();
  #closed = false;

  constructor(options: RestrictedMcpClientPoolOptions = {}) {
    this.#factory = options.factory ?? sdkRestrictedMcpPeerFactory;
    this.#idleTimeoutMs = options.idleTimeoutMs ?? 5 * 60_000;
    this.#operationTimeoutMs = options.operationTimeoutMs ?? 60_000;
    this.#environment = options.environment ?? buildRestrictedMcpChildEnvironment();
  }

  connectedAliases(): readonly string[] {
    return [...this.#entries.keys()].sort();
  }

  async get(alias: string, grant: RestrictedMcpServerGrant, signal?: AbortSignal): Promise<RestrictedMcpPeer> {
    if (this.#closed) throw new Error("restricted MCP runtime is closed");
    if (signal?.aborted) throw signal.reason ?? new Error("operation aborted");
    const signature = grantSignature(grant);
    const existing = this.#entries.get(alias);
    if (existing && existing.signature === signature) {
      this.#touch(alias, existing);
      return existing.peer;
    }
    if (existing) await this.disconnect(alias);
    const pending = this.#connecting.get(alias);
    if (pending && pending.signature === signature) return pending.promise;
    if (pending) {
      pending.controller.abort(new Error("restricted MCP server binding changed"));
      await Promise.allSettled([pending.promise]);
    }
    validateRestrictedMcpCommand(grant.command);
    const controller = new AbortController();
    const combinedSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const pendingEntry: PendingConnection = {
      promise: Promise.resolve(undefined as unknown as RestrictedMcpPeer),
      controller,
      signature,
    };
    const connecting = this.#factory.connect({
      command: grant.command,
      args: grant.args,
      env: this.#environment,
      signal: combinedSignal,
      timeoutMs: this.#operationTimeoutMs,
    }).then((peer) => {
      if (this.#closed || controller.signal.aborted) {
        void peer.close();
        throw new Error("restricted MCP runtime is closed or revoked");
      }
      const entry: PoolEntry = { peer, signature };
      this.#entries.set(alias, entry);
      this.#touch(alias, entry);
      return peer;
    }).finally(() => {
      if (this.#connecting.get(alias) === pendingEntry) this.#connecting.delete(alias);
    });
    pendingEntry.promise = connecting;
    this.#connecting.set(alias, pendingEntry);
    return connecting;
  }

  async disconnect(alias: string): Promise<void> {
    const entry = this.#entries.get(alias);
    if (!entry) return;
    this.#entries.delete(alias);
    if (entry.timer) clearTimeout(entry.timer);
    await entry.peer.close().catch(() => undefined);
  }

  async retainAliases(aliases: ReadonlySet<string>): Promise<void> {
    await Promise.all([...this.#entries.keys()].filter((alias) => !aliases.has(alias)).map((alias) => this.disconnect(alias)));
  }

  async disconnectAll(): Promise<void> {
    const pending = [...this.#connecting.values()];
    for (const connection of pending) connection.controller.abort(new Error("restricted MCP connection revoked"));
    await Promise.allSettled(pending.map((connection) => connection.promise));
    await Promise.all([...this.#entries.keys()].map((alias) => this.disconnect(alias)));
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    await this.disconnectAll();
  }

  operationTimeoutMs(): number {
    return this.#operationTimeoutMs;
  }

  #touch(alias: string, entry: PoolEntry): void {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = setTimeout(() => void this.disconnect(alias), this.#idleTimeoutMs);
    entry.timer.unref();
  }
}
