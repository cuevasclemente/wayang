import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createProtectedAutomationServices } from "./assembly.js";
import { getProtectedAutomationManager } from "./manager.js";
import { getProtectedAutomationScheduler } from "./scheduler.js";

// Follow runtime imports only; TypeScript erases `import type` before production executes.
const IMPORT_PATTERN = /(?:import|export)\s+(?!type\b)(?:[^"']*?\s+from\s+)?["']([^"']+)["']/gu;

function productionImportGraph(entry: string): Map<string, string[]> {
  const graph = new Map<string, string[]>();
  const visit = (file: string): void => {
    if (graph.has(file)) return;
    const source = fs.readFileSync(file, "utf8");
    const imports = [...source.matchAll(IMPORT_PATTERN)].map((match) => match[1]!);
    graph.set(file, imports);
    for (const specifier of imports) {
      if (!specifier.startsWith(".")) continue;
      const resolved = path.resolve(path.dirname(file), specifier.replace(/\.js$/u, ".ts"));
      if (fs.existsSync(resolved)) visit(resolved);
    }
  };
  visit(entry);
  return graph;
}

test("production automation assembly has no Pi, provider, model, MCP, or session-runtime import path", () => {
  const directory = path.dirname(fileURLToPath(import.meta.url));
  const graph = productionImportGraph(path.join(directory, "assembly.ts"));
  const forbidden = [
    /(?:^|\/)pi-bridge(?:\.js)?$/u,
    /(?:^|\/)sessions(?:\.js)?$/u,
    /(?:^|\/)providers?(?:\.js)?$/u,
    /(?:^|\/)models?(?:\.js)?$/u,
    /(?:^|\/)mcp(?:\/|\.js|$)/u,
    /^@earendil-works\/pi-/u,
    /^node:net$/u,
  ];
  const violations = [...graph].flatMap(([file, imports]) => imports
    .filter((specifier) => forbidden.some((pattern) => pattern.test(specifier)))
    .map((specifier) => `${path.relative(directory, file)} -> ${specifier}`));
  assert.deepEqual(violations, []);
  assert.ok([...graph.keys()].some((file) => file.endsWith("runner.ts")));
  assert.ok([...graph.keys()].some((file) => file.endsWith("scheduler.ts")));
  assert.equal([...graph.keys()].some((file) => file.endsWith("interactive-authority.ts")), false);
  assert.equal([...graph.keys()].some((file) => file.endsWith("tool.ts")), false);
});

test("production factory is inert and constructs no session/provider/model runtime", () => {
  const before = { ...process.env };
  const services = createProtectedAutomationServices();
  assert.ok(services.manager);
  assert.ok(services.scheduler);
  assert.deepEqual({ ...process.env }, before);
});

test("shutdown unpublishes both globals even when scheduler and manager cleanup fail independently", async () => {
  const services = createProtectedAutomationServices();
  (services.manager as any).start = () => ({ queued: 0, interrupted: 0 });
  (services.scheduler as any).start = () => undefined;
  services.start();
  assert.equal(getProtectedAutomationManager(), services.manager);
  assert.equal(getProtectedAutomationScheduler(), services.scheduler);
  (services.scheduler as any).stop = () => { throw new Error("synthetic scheduler stop failure"); };
  (services.manager as any).stop = async () => { throw new Error("synthetic manager stop failure"); };
  await assert.doesNotReject(() => services.stop());
  assert.equal(getProtectedAutomationManager(), null);
  assert.equal(getProtectedAutomationScheduler(), null);
});
