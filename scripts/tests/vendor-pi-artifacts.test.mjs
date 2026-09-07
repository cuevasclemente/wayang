import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

test("Pi artifact packer preserves legacy repacks and validates the synthetic 0.85 source/catalog triplet", () => {
  const result = spawnSync("python3", ["-B", fileURLToPath(new URL("./vendor-pi-artifacts.test.py", import.meta.url))], {
    encoding: "utf8", timeout: 30_000,
  });
  assert.equal(result.error, undefined);
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
});
