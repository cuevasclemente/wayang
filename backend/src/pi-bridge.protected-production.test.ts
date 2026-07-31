import assert from "node:assert/strict";
import test from "node:test";
import {
  getLiveProtectedBrowserRuntime,
  installProductionProtectedBrowserFactory,
  type ProtectedBrowserFactory,
} from "./pi-bridge.js";

test("production protected-browser factory installation is inert, singleton, and removable", () => {
  let calls = 0;
  const factory: ProtectedBrowserFactory = () => {
    calls += 1;
    throw new Error("synthetic factory must not be invoked by installation");
  };
  const uninstall = installProductionProtectedBrowserFactory(factory);
  const uninstallSame = installProductionProtectedBrowserFactory(factory);
  try {
    assert.equal(calls, 0);
    assert.throws(
      () => installProductionProtectedBrowserFactory((() => { throw new Error("other"); }) as ProtectedBrowserFactory),
      /already installed/i,
    );
    assert.equal(getLiveProtectedBrowserRuntime("synthetic-missing-session"), undefined);
  } finally {
    uninstallSame();
    uninstall();
  }
  assert.equal(calls, 0);
});
