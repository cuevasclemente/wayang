import assert from "node:assert/strict";
import test from "node:test";

import { extractTtsText, normalizeSpeechText, type MessageEntry } from "./tts-text.js";

test("normalizeSpeechText converts small markdown tables into spoken row descriptions", () => {
  const text = `Yonex basically positions them as:

| Line | Main identity | What you feel on court |
|---|---|---|
| EZONE | Power + comfort + forgiveness | Easier depth, more pop |
| VCORE | Spin + racquet-head speed + shape | Easier topspin |

Done.`;

  const normalized = normalizeSpeechText(text);

  assert.match(normalized, /Table with 2 rows\./);
  assert.match(normalized, /Row 1: Line: EZONE; Main identity: Power plus comfort plus forgiveness; What you feel on court: Easier depth, more pop\./);
  assert.match(normalized, /Row 2: Line: VCORE; Main identity: Spin plus racquet-head speed plus shape; What you feel on court: Easier topspin\./);
  assert.doesNotMatch(normalized, /\|---\|/);
});

test("normalizeSpeechText omits wide tables instead of reading punctuation soup", () => {
  const text = `Specs:

| Model | Head | Weight | Beam | Balance | Pattern |
|---|---:|---:|---|---:|---|
| EZONE 98 | 98 | 305g | 23.5/24.5/19.5 | 315 | 16x19 |

Bottom line.`;

  const normalized = normalizeSpeechText(text);

  assert.match(normalized, /Table omitted: 1 rows and 6 columns\./);
  assert.doesNotMatch(normalized, /23\.5\/24\.5/);
});

test("extractTtsText skips thinking, tools, code fences, and table separators", () => {
  const entry: MessageEntry = {
    message: {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "# Answer\n\n```ts\nconst x = 1\n```\n\n| A | B |\n|---|---|\n| one | two |" },
        { type: "toolCall", text: "hidden tool" },
      ],
    },
  };

  const extracted = extractTtsText(entry);

  assert.match(extracted, /^Answer/);
  assert.match(extracted, /Table with 1 row\. Row 1: A: one; B: two\./);
  assert.doesNotMatch(extracted, /const x/);
  assert.doesNotMatch(extracted, /hidden/);
  assert.doesNotMatch(extracted, /---/);
});
