import assert from "node:assert/strict";
import test from "node:test";

import {
  getChromiumCandidates,
  getChromiumHostArchitecture,
  getPlaywrightCacheRoot,
  getPlaywrightChromiumCandidates,
  getSystemChromiumCandidates,
} from "./manager.js";

const HOME = "/synthetic/home";

test("Chromium candidates preserve configured, Playwright, then system precedence", () => {
  assert.deepEqual(
    getChromiumCandidates("/configured/chrome", "linux", "x64", HOME, ["chromium-1234"]),
    [
      "/configured/chrome",
      "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
    ],
  );
});

test("macOS uses the Playwright cache under Library/Caches", () => {
  assert.equal(getPlaywrightCacheRoot("darwin", HOME), "/synthetic/home/Library/Caches/ms-playwright");
});

test("macOS system candidates include system and per-user Chrome and Chromium applications", () => {
  assert.deepEqual(getSystemChromiumCandidates("darwin", HOME), [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/synthetic/home/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/synthetic/home/Applications/Chromium.app/Contents/MacOS/Chromium",
  ]);
});

test("macOS x64 processes on Apple Silicon use only arm64 Playwright candidates", () => {
  assert.equal(getChromiumHostArchitecture("darwin", "x64", ["Virtual CPU", "Apple M2 Max"]), "arm64");
  const candidates = getChromiumCandidates(
    undefined,
    "darwin",
    "x64",
    HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
    ["Virtual CPU", "Apple M2 Max"],
  );

  assert.ok(candidates.some((candidate) => candidate.includes("chrome-mac-arm64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-headless-shell-mac-arm64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-mac-x64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-headless-shell-mac-x64")));
});

test("macOS x64 processes on Intel use only x64 Playwright candidates", () => {
  assert.equal(getChromiumHostArchitecture("darwin", "x64", ["Intel(R) Core(TM) i7"]), "x64");
  const candidates = getChromiumCandidates(
    undefined,
    "darwin",
    "x64",
    HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
    ["Intel(R) Core(TM) i7"],
  );

  assert.ok(candidates.some((candidate) => candidate.includes("chrome-mac-x64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-headless-shell-mac-x64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-mac-arm64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-headless-shell-mac-arm64")));
});

test("macOS with unknown process architecture and CPU probes both Playwright architectures", () => {
  assert.equal(getChromiumHostArchitecture("darwin", "riscv64", ["Unknown CPU"]), "riscv64");
  const candidates = getChromiumCandidates(
    undefined,
    "darwin",
    "riscv64",
    HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
    ["Unknown CPU"],
  );

  assert.ok(candidates.some((candidate) => candidate.includes("chrome-mac-arm64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-mac-x64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-headless-shell-mac-arm64")));
  assert.ok(candidates.some((candidate) => candidate.includes("chrome-headless-shell-mac-x64")));
});

test("Linux Chromium candidates preserve the process architecture and ignore CPU model strings", () => {
  assert.equal(getChromiumHostArchitecture("linux", "x64", ["Apple M2 Max"]), "x64");
  assert.deepEqual(
    getChromiumCandidates(undefined, "linux", "x64", HOME, ["chromium-1234"], ["Apple M2 Max"]),
    [
      "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
      "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
      "/usr/bin/chromium",
      "/usr/bin/chromium-browser",
      "/usr/bin/google-chrome-stable",
      "/usr/bin/google-chrome",
      "/opt/google/chrome/chrome",
    ],
  );
});

test("Linux Playwright headless-shell entries produce no candidates", () => {
  assert.deepEqual(
    getPlaywrightChromiumCandidates("linux", "x64", HOME, ["chromium_headless_shell-1234"]),
    [],
  );
});

test("macOS Playwright candidates include only arm64 layouts when arm64 is requested", () => {
  const candidates = getPlaywrightChromiumCandidates(
    "darwin",
    "arm64",
    HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
  );
  const chromiumArm64 = "/synthetic/home/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const shellArm64 = "/synthetic/home/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-arm64/chrome-headless-shell";

  assert.ok(candidates.includes(chromiumArm64));
  assert.ok(candidates.includes(shellArm64));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-mac-x64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-headless-shell-mac-x64")));
});

test("macOS Playwright candidates include only x64 layouts when x64 is requested", () => {
  const candidates = getPlaywrightChromiumCandidates(
    "darwin",
    "x64",
    HOME,
    ["chromium-1234", "chromium_headless_shell-1234"],
  );
  const chromiumX64 = "/synthetic/home/Library/Caches/ms-playwright/chromium-1234/chrome-mac-x64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing";
  const shellX64 = "/synthetic/home/Library/Caches/ms-playwright/chromium_headless_shell-1234/chrome-headless-shell-mac-x64/chrome-headless-shell";

  assert.ok(candidates.includes(chromiumX64));
  assert.ok(candidates.includes(shellX64));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-mac-arm64")));
  assert.ok(candidates.every((candidate) => !candidate.includes("chrome-headless-shell-mac-arm64")));
});

test("macOS Playwright Chromium entries retain the legacy Chromium app layout", () => {
  assert.ok(
    getPlaywrightChromiumCandidates("darwin", "arm64", HOME, ["chromium-1234"]).includes(
      "/synthetic/home/Library/Caches/ms-playwright/chromium-1234/chrome-mac/Chromium.app/Contents/MacOS/Chromium",
    ),
  );
});

test("Playwright cache entries are ordered by newest revision across Chromium products", () => {
  const candidates = getPlaywrightChromiumCandidates(
    "darwin",
    "arm64",
    HOME,
    ["chromium-1233", "chromium_headless_shell-1234"],
  );

  assert.match(candidates[0], /chromium_headless_shell-1234/);
  assert.ok(candidates.findIndex((candidate) => candidate.includes("chromium-1233")) > 0);
});

test("Playwright cache entries prefer full Chromium over headless shell at the same revision", () => {
  const candidates = getPlaywrightChromiumCandidates(
    "darwin",
    "arm64",
    HOME,
    ["chromium_headless_shell-1234", "chromium-1234"],
  );
  const chromiumIndex = candidates.findIndex((candidate) => candidate.includes("chromium-1234"));
  const shellIndex = candidates.findIndex((candidate) => candidate.includes("chromium_headless_shell-1234"));

  assert.ok(chromiumIndex >= 0);
  assert.ok(shellIndex >= 0);
  assert.ok(chromiumIndex < shellIndex);
});

test("Linux retains its Playwright cache root and Chromium layouts", () => {
  assert.equal(getPlaywrightCacheRoot("linux", HOME), "/synthetic/home/.cache/ms-playwright");
  assert.deepEqual(getPlaywrightChromiumCandidates("linux", "arm64", HOME, ["chromium-1234"]), [
    "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux64/chrome",
    "/synthetic/home/.cache/ms-playwright/chromium-1234/chrome-linux/chrome",
  ]);
});
