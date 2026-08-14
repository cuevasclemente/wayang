#!/usr/bin/env node
import { closeWayangServer, start } from "./app.js";
import { cleanup } from "./pi-bridge.js";

const server = start();

// Graceful shutdown. A failed Chromium termination keeps its exact in-memory
// cleanup identity, so retry before allowing process exit to discard it.
const MAX_SHUTDOWN_ATTEMPTS = 3;
const SHUTDOWN_RETRY_DELAY_MS = 1_000;
let shuttingDown = false;

async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log("\n[wayang] shutting down...");
  try {
    for (let attempt = 1; attempt <= MAX_SHUTDOWN_ATTEMPTS; attempt += 1) {
      try {
        await closeWayangServer(server);
        await cleanup();
        process.exit(0);
      } catch {
        if (attempt === MAX_SHUTDOWN_ATTEMPTS) {
          console.error("[wayang] shutdown remains incomplete; process retained for another signal retry");
          return;
        }
        console.warn("[wayang] shutdown cleanup remains pending; retrying");
        await new Promise<void>((resolve) => setTimeout(resolve, SHUTDOWN_RETRY_DELAY_MS));
      }
    }
  } finally {
    shuttingDown = false;
  }
}

process.on("SIGINT", () => { void shutdown(); });
process.on("SIGTERM", () => { void shutdown(); });
