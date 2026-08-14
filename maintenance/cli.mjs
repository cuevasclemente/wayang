#!/usr/bin/env node
import { MAX_INTENT_BYTES, parseIntent } from "./schema.mjs";

async function boundedStdin() {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > MAX_INTENT_BYTES) throw new Error(`stdin exceeds ${MAX_INTENT_BYTES} bytes`);
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

async function main() {
  if (process.argv.length !== 3 || process.argv[2] !== "validate-intent") {
    throw new Error("usage: node maintenance/cli.mjs validate-intent < intent.json");
  }
  const intent = parseIntent(await boundedStdin());
  process.stdout.write(`${JSON.stringify({ valid: true, schema: intent.schema, runId: intent.runId, operation: intent.operation, repository: intent.repository })}\n`);
}

main().catch((error) => {
  process.stderr.write(`maintenance input rejected: ${error.message}\n`);
  process.exitCode = 1;
});
