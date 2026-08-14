import assert from "node:assert/strict";
import * as net from "node:net";
import test from "node:test";
import { openLoopbackVncTransport } from "./vnc-transport.js";

async function listen(server: net.Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("missing address");
  return address.port;
}

test("loopback VNC transport preserves a server-first RFB greeting until the viewer attaches", async () => {
  const greeting = Buffer.from("RFB 003.008\\n");
  const server = net.createServer((socket) => socket.write(greeting));
  const port = await listen(server);
  const transport = await openLoopbackVncTransport(port, async () => undefined);
  let closed = 0;
  transport.onClose?.(() => { closed += 1; });
  await new Promise((resolve) => setTimeout(resolve, 20));
  const received = await new Promise<Buffer>((resolve) => transport.onMessage((message) => resolve(message)));
  assert.deepEqual(received, greeting);
  await transport.close();
  assert.equal(closed, 1);
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("loopback VNC transport is binary-only and reauthorizes every input", async () => {
  let serverSocket: net.Socket | null = null;
  const server = net.createServer((socket) => { serverSocket = socket; socket.on("data", (chunk) => socket.write(chunk)); });
  const port = await listen(server);
  let authorized = true;
  let checks = 0;
  const transport = await openLoopbackVncTransport(port, async () => {
    checks += 1;
    if (!authorized) throw new Error("revoked");
  });
  const received = new Promise<Buffer>((resolve) => transport.onMessage((message, binary) => {
    assert.equal(binary, true);
    resolve(message);
  }));
  await transport.dispatch(Buffer.from([1, 2, 3]), true);
  assert.deepEqual(await received, Buffer.from([1, 2, 3]));
  authorized = false;
  await assert.rejects(async () => { await transport.dispatch(Buffer.from([4]), true); }, /revoked/);
  await assert.rejects(async () => { await transport.dispatch(Buffer.from("text"), false); }, /invalid/);
  serverSocket!.write(Buffer.from([9]));
  await new Promise((resolve) => setTimeout(resolve, 20));
  assert.equal(checks, 5);
  await transport.close();
  await new Promise<void>((resolve) => server.close(() => resolve()));
});
