import assert from "node:assert/strict";
import test from "node:test";
import {
  sendFullBrowserPaste,
  validateFullBrowserPasteText,
  type FullBrowserPasteTransport,
} from "../src/components/browser/full-browser-paste.ts";

function transport(events: Array<Record<string, unknown>>, failAt?: "paste" | "key"): FullBrowserPasteTransport {
  return {
    focus(options) { events.push({ type: "focus", preventScroll: options?.preventScroll }); },
    clipboardPasteFrom(text) {
      events.push({ type: "clipboard", text });
      if (failAt === "paste") throw new Error("synthetic clipboard failure");
    },
    sendKey(keysym, code, down) {
      events.push({ type: "key", keysym, code, down });
      if (failAt === "key" && code === "KeyV") throw new Error("synthetic key failure");
    },
  };
}

test("Full browser paste sends one clipboard update followed by one Ctrl+V chord", () => {
  const events: Array<Record<string, unknown>> = [];
  sendFullBrowserPaste(transport(events), "synthetic-human-paste");
  assert.deepEqual(events, [
    { type: "focus", preventScroll: true },
    { type: "clipboard", text: "synthetic-human-paste" },
    { type: "key", keysym: 0xffe3, code: "ControlLeft", down: true },
    { type: "key", keysym: 0x76, code: "KeyV", down: undefined },
    { type: "key", keysym: 0xffe3, code: "ControlLeft", down: false },
  ]);
});

test("Full browser paste releases Control when the remote V key fails", () => {
  const events: Array<Record<string, unknown>> = [];
  assert.throws(() => sendFullBrowserPaste(transport(events, "key"), "synthetic"), /synthetic key failure/);
  assert.deepEqual(events.at(-1), { type: "key", keysym: 0xffe3, code: "ControlLeft", down: false });
  assert.equal(events.filter((event) => event.type === "clipboard").length, 1);
});

test("Full browser paste rejects empty, oversized, NUL, and unpaired-surrogate text before RFB dispatch", () => {
  for (const invalid of [
    "",
    "x".repeat(4_097),
    "nul\0text",
    "unpaired-\ud800",
    "😀".repeat(4_096),
  ]) {
    const events: Array<Record<string, unknown>> = [];
    assert.throws(() => {
      validateFullBrowserPasteText(invalid);
      sendFullBrowserPaste(transport(events), invalid);
    }, /empty|limit|invalid/i);
    assert.deepEqual(events, []);
  }
});

test("Full browser paste errors and transport surface do not serialize clipboard text", () => {
  const canary = "secret-shaped-synthetic-canary";
  const events: Array<Record<string, unknown>> = [];
  let error: unknown;
  try {
    sendFullBrowserPaste(transport(events, "paste"), canary);
  } catch (caught) {
    error = caught;
  }
  assert.ok(error instanceof Error);
  assert.doesNotMatch(error.message, new RegExp(canary));
  // The RFB clipboard frame necessarily carries the human input; no other
  // event, error, state object, or metadata projection receives it.
  assert.equal(events.filter((event) => JSON.stringify(event).includes(canary)).length, 1);
});
