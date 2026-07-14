import { WebSocket } from "ws";

interface PendingCommand {
  resolve: (value: any) => void;
  reject: (err: Error) => void;
}

export class CdpConnection {
  private nextId = 1;
  private pending = new Map<number, PendingCommand>();
  private listeners = new Map<string, Set<(params: any) => void>>();

  private constructor(private readonly ws: WebSocket) {}

  static connect(wsUrl: string): Promise<CdpConnection> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      const onError = (err: Error) => reject(err);
      ws.once("error", onError);
      ws.once("open", () => {
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
        if (msg.error) {
          pending.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
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
        pending.reject(new Error("CDP connection closed"));
      }
      this.pending.clear();
      this.listeners.clear();
    });
  }

  send<T = any>(method: string, params?: Record<string, unknown>): Promise<T> {
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("CDP connection is not open"));
    }
    const id = this.nextId++;
    const payload = JSON.stringify({ id, method, params: params ?? {} });
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(payload, (err) => {
        if (!err) return;
        this.pending.delete(id);
        reject(err);
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
  webSocketDebuggerUrl?: string;
}
