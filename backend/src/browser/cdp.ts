import { WebSocket } from "ws";

interface PendingCommand {
  method: string;
  timeout: NodeJS.Timeout;
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

const DEFAULT_CDP_TIMEOUT_MS = 10_000;

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private listeners = new Map<string, Set<(params: any) => void>>();

  private constructor(private readonly ws: WebSocket) {}

  static connect(wsUrl: string, timeoutMs = DEFAULT_CDP_TIMEOUT_MS): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const timeout = setTimeout(() => {
        ws.terminate();
        reject(new Error("CDP connection timed out"));
      }, timeoutMs);
      const onError = () => {
        clearTimeout(timeout);
        reject(new Error("CDP connection failed"));
      };
      ws.once("error", onError);
      ws.once("open", () => {
        clearTimeout(timeout);
        ws.off("error", onError);
        const conn = new CdpConnection(ws);
        conn.attachHandlers();
        resolve(conn);
      });
    });
  }

  private attachHandlers(): void {
    this.ws.on("message", (raw) => {
      let msg: any;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (typeof msg.id === "number") {
        const pending = this.pending.get(msg.id);
        if (!pending) return;
        this.pending.delete(msg.id);
        clearTimeout(pending.timeout);
        if (msg.error) {
          pending.reject(new Error(`CDP ${pending.method} failed`));
        } else {
          pending.resolve(msg.result ?? null);
        }
        return;
      }

      if (typeof msg.method === "string") {
        const listeners = this.listeners.get(msg.method);
        if (!listeners) return;
        for (const listener of listeners) listener(msg.params ?? {});
      }
    });

    this.ws.on("close", () => {
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error(`CDP ${pending.method} connection closed`));
      }
      this.pending.clear();
      this.listeners.clear();
    });
  }

  send<T = any>(method: string, params?: Record<string, unknown>, timeoutMs = DEFAULT_CDP_TIMEOUT_MS): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP connection is not open"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, Math.max(1, timeoutMs));
      this.pending.set(id, { method, timeout, resolve, reject });
      this.ws.send(payload, (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (pending) clearTimeout(pending.timeout);
        this.pending.delete(id);
        reject(new Error(`CDP ${method} send failed`));
      });
    });
  }

  on(method: string, listener: (params: any) => void): () => void {
    const listeners = this.listeners.get(method) ?? new Set<(params: any) => void>();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close(): void {
    try {
      this.ws.close();
    } catch {
      // ignore
    }
  }
}

export interface ChromeTarget {
  id: string;
  type: string;
  title?: string;
  url?: string;
  openerId?: string;
  webSocketDebuggerUrl?: string;
}

export interface ChromeVersion {
  Browser?: string;
  ProtocolVersion?: string;
  webSocketDebuggerUrl?: string;
}

/**
 * Resolve Chromium's browser-level CDP socket. Page target sockets do not emit
 * Browser.download* events, so download-owning runtimes must use /json/version.
 */
export async function browserCdpWebSocketUrl(
  port: number,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error("Invalid Chromium CDP port");
  }
  const response = await fetchImpl(`http://127.0.0.1:${port}/json/version`);
  if (!response.ok) throw new Error("Chromium browser CDP discovery failed");
  const version = await response.json() as ChromeVersion;
  const wsUrl = version.webSocketDebuggerUrl;
  if (typeof wsUrl !== "string") throw new Error("Chromium did not expose a browser CDP connection");
  try {
    const parsed = new URL(wsUrl);
    const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      parsed.protocol !== "ws:" ||
      parsed.username || parsed.password ||
      (host !== "127.0.0.1" && host !== "localhost" && host !== "::1") ||
      Number(parsed.port) !== port
    ) throw new Error("invalid browser socket");
  } catch {
    throw new Error("Chromium did not expose a loopback browser CDP connection");
  }
  return wsUrl;
}

export async function connectBrowserCdp(port: number, timeoutMs = DEFAULT_CDP_TIMEOUT_MS): Promise<CdpConnection> {
  return CdpConnection.connect(await browserCdpWebSocketUrl(port), timeoutMs);
}
