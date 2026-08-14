import * as net from "node:net";
import type { ProtectedBrowserViewerTransport } from "../routes/protected-browser.js";

const MAX_BUFFER_BYTES = 2 * 1024 * 1024;
const MAX_PENDING_INPUTS = 64;

/** Binary-only loopback RFB bridge with authorization before every bounded input or output batch. */
export async function openLoopbackVncTransport(
  port: number,
  authorize: () => Promise<void>,
): Promise<ProtectedBrowserViewerTransport> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("VNC port is unavailable");
  await authorize();
  const socket = net.createConnection({ host: "127.0.0.1", port });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { socket.destroy(); reject(new Error("VNC connection timed out")); }, 5_000);
    socket.once("connect", () => { clearTimeout(timer); resolve(); });
    socket.once("error", () => { clearTimeout(timer); reject(new Error("VNC connection failed")); });
  });
  const listeners = new Set<(message: Buffer, isBinary: boolean) => void>();
  const closeListeners = new Set<() => void>();
  let closed = false;
  let inputTail = Promise.resolve();
  let pendingInputBytes = 0;
  let pendingInputs = 0;
  let outputTail = Promise.resolve();
  let pendingOutputBytes = 0;
  const bufferedOutput: Buffer[] = [];
  let bufferedOutputBytes = 0;

  const markClosed = () => {
    if (closed) return false;
    closed = true;
    listeners.clear();
    const closedCallbacks = [...closeListeners];
    closeListeners.clear();
    for (const listener of closedCallbacks) listener();
    bufferedOutput.length = 0;
    bufferedOutputBytes = 0;
    return true;
  };

  const close = async () => {
    if (!markClosed()) return;
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => { socket.destroy(); resolve(); }, 1_000);
      socket.once("close", () => { clearTimeout(timer); resolve(); });
      socket.destroy();
    });
  };

  socket.on("data", (chunk) => {
    if (closed) return;
    const message = Buffer.from(chunk);
    if (bufferedOutputBytes + pendingOutputBytes + message.length > MAX_BUFFER_BYTES) { void close(); return; }
    pendingOutputBytes += message.length;
    socket.pause();
    const operation = outputTail.then(async () => {
      await authorize();
      if (closed) throw new Error("VNC controller is closed");
      if (listeners.size === 0) {
        bufferedOutput.push(message);
        bufferedOutputBytes += message.length;
      } else {
        for (const listener of listeners) listener(message, true);
      }
    });
    outputTail = operation.catch(() => { void close(); }).finally(() => {
      pendingOutputBytes -= message.length;
      if (!closed && pendingOutputBytes === 0) socket.resume();
    });
  });
  socket.on("error", () => { void close(); });
  socket.on("close", () => { markClosed(); });

  return {
    async dispatch(message, isBinary) {
      if (closed || !isBinary || message.length === 0 || message.length > MAX_BUFFER_BYTES) throw new Error("VNC input is invalid");
      if (pendingInputs >= MAX_PENDING_INPUTS || pendingInputBytes + message.length > MAX_BUFFER_BYTES) {
        await close();
        throw new Error("VNC input queue exceeded");
      }
      pendingInputs += 1;
      pendingInputBytes += message.length;
      const operation = inputTail.then(async () => {
        await authorize();
        if (closed || socket.destroyed) throw new Error("VNC controller is closed");
        if (socket.writableLength > MAX_BUFFER_BYTES) throw new Error("VNC input buffer exceeded");
        await new Promise<void>((resolve, reject) => {
          socket.write(message, (error) => error ? reject(new Error("VNC input failed")) : resolve());
        });
      }).finally(() => {
        pendingInputs -= 1;
        pendingInputBytes -= message.length;
      });
      inputTail = operation.catch(() => undefined);
      return operation;
    },
    close,
    onMessage(listener) {
      if (closed) throw new Error("VNC controller is closed");
      listeners.add(listener);
      if (bufferedOutput.length > 0) {
        const pending = bufferedOutput.splice(0);
        bufferedOutputBytes = 0;
        for (const message of pending) listener(message, true);
      }
      return () => listeners.delete(listener);
    },
    onClose(listener) {
      if (closed) { listener(); return () => undefined; }
      closeListeners.add(listener);
      return () => closeListeners.delete(listener);
    },
  };
}
