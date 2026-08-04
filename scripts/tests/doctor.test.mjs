import assert from "node:assert/strict";
import test from "node:test";
import { diagnoseLinuxUserBus } from "../lib/doctor.mjs";

function metadata({ uid = 1000, directory = false, socket = false } = {}) {
  return {
    uid,
    isDirectory: () => directory,
    isSocket: () => socket,
  };
}

test("Linux user-bus diagnostic checks only expected metadata paths", () => {
  const inspected = [];
  const result = diagnoseLinuxUserBus({
    platform: "linux",
    getUid: () => 1000,
    lstat: (path) => {
      inspected.push(path);
      if (path === "/run/user/1000") return metadata({ directory: true });
      if (path === "/run/user/1000/bus") return metadata({ socket: true });
      throw new Error("unexpected path");
    },
  });

  assert.deepEqual(inspected, ["/run/user/1000", "/run/user/1000/bus"]);
  assert.deepEqual(result, {
    level: "ok",
    message: "Linux user bus metadata is present at /run/user/1000/bus (owned by uid 1000)",
  });
});

test("Linux user-bus diagnostic warns for missing, wrong-type, or wrong-owner metadata", async (t) => {
  const cases = [
    {
      name: "missing runtime directory",
      lstat: () => { throw new Error("synthetic missing"); },
      pattern: /runtime directory .* missing or unreadable/,
    },
    {
      name: "runtime path is not a directory",
      lstat: () => metadata(),
      pattern: /runtime path .* is not a directory/,
    },
    {
      name: "runtime directory has another owner",
      lstat: () => metadata({ uid: 1001, directory: true }),
      pattern: /runtime directory .* owned by uid 1001; expected uid 1000/,
    },
    {
      name: "missing bus socket",
      lstat: (path) => {
        if (path === "/run/user/1000") return metadata({ directory: true });
        throw new Error("synthetic missing");
      },
      pattern: /bus socket .* missing or unreadable/,
    },
    {
      name: "bus path is not a socket",
      lstat: (path) => path.endsWith("/bus") ? metadata() : metadata({ directory: true }),
      pattern: /bus path .* is not a Unix socket/,
    },
    {
      name: "bus socket has another owner",
      lstat: (path) => path.endsWith("/bus")
        ? metadata({ uid: 1001, socket: true })
        : metadata({ directory: true }),
      pattern: /bus socket .* owned by uid 1001; expected uid 1000/,
    },
  ];

  for (const synthetic of cases) {
    await t.test(synthetic.name, () => {
      const result = diagnoseLinuxUserBus({
        platform: "linux",
        getUid: () => 1000,
        lstat: synthetic.lstat,
      });
      assert.equal(result.level, "warn");
      assert.match(result.message, synthetic.pattern);
    });
  }
});

test("Linux user-bus diagnostic warns when a numeric uid is unavailable", () => {
  assert.deepEqual(
    diagnoseLinuxUserBus({ platform: "linux", getUid: null, lstat: () => metadata() }),
    {
      level: "warn",
      message: "Linux user bus metadata cannot be checked because the current uid is unavailable",
    },
  );
  assert.match(
    diagnoseLinuxUserBus({ platform: "linux", getUid: () => Number.NaN, lstat: () => metadata() }).message,
    /current uid is invalid/,
  );
});

test("user-bus diagnostic is a no-op on non-Linux platforms", () => {
  let inspected = false;
  const result = diagnoseLinuxUserBus({
    platform: "darwin",
    getUid: () => { throw new Error("must not be called"); },
    lstat: () => { inspected = true; throw new Error("must not be called"); },
  });
  assert.equal(result, null);
  assert.equal(inspected, false);
});
