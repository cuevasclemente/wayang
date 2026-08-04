#!/usr/bin/env node
import { closeWayangServer, start } from "./app.js";
import { cleanup } from "./pi-bridge.js";

const server = start();

// Graceful shutdown
let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[wayang] shutting down...");
  await closeWayangServer(server);
  await cleanup();
  process.exit(0);
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
