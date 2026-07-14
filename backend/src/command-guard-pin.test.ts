import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { validateCommandGuardIdentityPin } from "./command-guard-pin.js";

test("validateCommandGuardIdentityPin requires the configured 8-digit PIN", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wayang-command-guard-pin-test-"));
  const previousXdgConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;

  try {
    fs.mkdirSync(path.join(dir, "pi"), { recursive: true });
    fs.writeFileSync(path.join(dir, "pi", "command-guard-identity-pin"), "12345678\n", { mode: 0o600 });

    assert.deepEqual(validateCommandGuardIdentityPin("12345678"), {
      ok: true,
      pinConfigured: true,
    });
    assert.equal(validateCommandGuardIdentityPin("00000000").ok, false);
    assert.equal(validateCommandGuardIdentityPin("00000000").pinConfigured, true);
    assert.equal(validateCommandGuardIdentityPin("not a pin").ok, false);
  } finally {
    if (previousXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME;
    } else {
      process.env.XDG_CONFIG_HOME = previousXdgConfigHome;
    }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
