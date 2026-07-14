#!/usr/bin/env node
import { start } from "./app.js";
import { cleanup } from "./pi-bridge.js";

const server = start();

// Graceful shutdown
process.on("SIGINT", async () => {
  console.log("\n[wayang] shutting down...");
  server.close();
  await cleanup();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n[wayang] shutting down...");
  server.close();
  await cleanup();
  process.exit(0);
});
