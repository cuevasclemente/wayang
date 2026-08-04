import assert from "node:assert/strict";
import test from "node:test";
import { getConfig } from "./config.js";

test("legacy identity-specific host flag is not runtime authority", () => {
  const previous = process.env.WAYANG_WREN_HOST_BASH;
  try {
    process.env.WAYANG_WREN_HOST_BASH = "1";
    const config = getConfig();
    assert.equal("wrenHostBash" in config, false);
  } finally {
    if (previous === undefined) delete process.env.WAYANG_WREN_HOST_BASH;
    else process.env.WAYANG_WREN_HOST_BASH = previous;
  }
});
