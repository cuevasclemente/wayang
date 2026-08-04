import assert from "node:assert/strict";
import { test } from "node:test";
import { runProtectedAutomationFeasibilityGate } from "./feasibility-gate.js";

const CURRENT_RUNTIME_BLOCKERS = [
  "shell_free_backend_resolved_node",
  "exact_node_executable_view",
  "exact_write_allowlist",
  "proxy_without_shell_prelude",
] as const;

test("Milestone 0 protected automation synthetic Linux feasibility gate", { timeout: 60_000 }, async (t) => {
  if (process.platform !== "linux") {
    t.skip("focused host gate is Linux-only; macOS requires a separate run");
    return;
  }

  const report = await runProtectedAutomationFeasibilityGate();
  t.diagnostic(JSON.stringify(report, null, 2));

  assert.equal(report.runtimeVersion, "0.0.65");
  assert.equal(report.verdict, "NO-GO", "do not weaken the gate when current primitives cannot meet the boundary");
  const dependency = report.checks.find((item) => item.id === "sandbox_dependencies");
  assert.ok(dependency, "the report must include dependency readiness");
  if (dependency.status === "BLOCKED") {
    t.skip(`sandbox dependencies unavailable: ${dependency.detail}`);
    return;
  }
  const runtimeBlocked = report.checks.find((item) => item.id === "runtime_probe" && item.status === "BLOCKED");
  if (runtimeBlocked) {
    t.skip(`sandbox runtime probe unavailable: ${runtimeBlocked.detail}`);
    return;
  }

  for (const id of CURRENT_RUNTIME_BLOCKERS) {
    const finding = report.checks.find((item) => item.id === id);
    assert.ok(finding, `missing required finding: ${id}`);
    assert.equal(finding.status, "FAIL", `${id} must remain an explicit current-runtime NO-GO until the primitive changes`);
  }

  const noPi = report.checks.find((item) => item.id === "no_pi_provider_or_protected_state");
  assert.equal(noPi?.status, "PASS");
});
