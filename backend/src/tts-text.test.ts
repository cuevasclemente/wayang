import assert from "node:assert/strict";
import test from "node:test";

import {
  extractTtsText, extractTtsTextFromEntries, findAssistantSpeechGroup,
  normalizeSpeechText, type MessageEntry,
} from "./tts-text.js";

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

test("normalizeSpeechText reads every column of wide tables", () => {
  const text = `Specs:

| Model | Head | Weight | Beam | Balance | Pattern |
|---|---:|---:|---|---:|---|
| EZONE 98 | 98 | 305g | 23.5/24.5/19.5 | 315 | 16x19 |

Bottom line.`;

  const normalized = normalizeSpeechText(text);

  assert.match(normalized, /Table with 1 row\./);
  assert.match(normalized, /Row 1: Model: EZONE 98; Head: 98; Weight: 305g; Beam: 23\.5\/24\.5\/19\.5; Balance: 315; Pattern: 16x19\./);
  assert.doesNotMatch(normalized, /omitted/);
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

function assistant(id: string, content: unknown, stopReason = "stop"): MessageEntry {
  return { id, type: "assistant", message: { role: "assistant", content, stopReason } };
}

function speech(markdown: string): string {
  return extractTtsText(assistant("answer", markdown));
}

test("tables retain empty-cell positions and use positional labels for empty headings", () => {
  assert.equal(speech("| Name | | Value |\n|---|---|---|\n| Example | | Correct |\n| | Middle | |"),
    "Table with 2 rows. Row 1: Name: Example; Column 2: empty; Value: Correct. Row 2: Name: empty; Column 2: Middle; Value: empty.");
  assert.equal(speech("Name | Empty | Value\n---|---|---\nExample || Correct\nShort | present"),
    "Table with 2 rows. Row 1: Name: Example; Empty: empty; Value: Correct. Row 2: Name: Short; Empty: present; Value: empty.");
});

test("tables read all rows, including wholly empty rows, without an omission limit", () => {
  const rows = Array.from({ length: 9 }, (_, i) => `| Item ${i + 1} | ${i + 1}.25 |`);
  const text = speech(["| Name | Value |", "|---|---|", ...rows, "| | |"].join("\n"));
  assert.match(text, /Table with 10 rows\./);
  for (let i = 1; i <= 9; i++) assert.ok(text.includes(`Row ${i}: Name: Item ${i}; Value: ${i}.25.`));
  assert.match(text, /Row 10: Name: empty; Value: empty\./);
  assert.doesNotMatch(text, /omitted/);
});

test("table parsing respects escaped pipes, inline spans, and reference links", () => {
  const text = speech(String.raw`| Label | Value |
|---|---|
| A\|B | **bold** and [guide][ref] |
| Span | \`x\|y\` |

[ref]: https://example.invalid/path_(part)`.replaceAll("\\`", "`"));
  assert.match(text, /Row 1: Label: A pipe B; Value: bold and guide\./);
  assert.match(text, /Row 2: Label: Span; Value: x pipe y\./);
  assert.doesNotMatch(text, /https|\[ref\]|\*\*|`/);
});

test("fenced and indented code is removed before table narration, including unclosed fences", () => {
  const fixtures = [
    "```ts\nhidden code\n```",
    "~~~ts\nhidden code\n~~~",
    "````md\n```\nhidden code\n```\n````",
    "~~~md\n| Hidden | Code |\n|---|---|\n| no | speech |\n~~~",
    "    hidden code\n    | Hidden | Code |",
    "> ~~~\n> hidden code\n> ~~~",
    "- ```ts\n  hidden code\n  ```",
  ];
  for (const code of fixtures) {
    assert.equal(speech(`Before.\n\n${code}\n\nAfter.`).replace(/\s+/g, " "), "Before. After.", code);
    assert.equal(speech(code), "", code);
  }
  for (const fence of ["```", "~~~", "````"]) {
    assert.equal(speech(`Before.\n\n${fence}ts\nhidden code`), "Before.");
  }
});

test("prose preserves headings, nested lists, links, images, and inline labels without markup", () => {
  const text = speech("# Answer\n\n> **Visible** commentary.\n\n- First [guide](https://example.invalid/a_(b)).\n  - Second `label`.\n\n![Diagram](https://example.invalid/image.png)\n\nFinal [reference][ref].\n\n[ref]: https://example.invalid");
  assert.equal(text.replace(/\s+/g, " "), "Answer Visible commentary. First guide. Second label. Diagram Final reference.");
});

test("literal underscores and operators become faithful broker-safe spoken words", () => {
  assert.equal(speech("Use `version_one_two`; check 2 < 3 > 1."), "Use version underscore one underscore two; check 2 less than 3 greater than 1.");
  assert.equal(speech("`x <= 3` and `y >= 2`; `x != y`; `a => b`; `a + b = c`."),
    "x less than or equal to 3 and y greater than or equal to 2; x not equal to y; a leads to b; a plus b equals c.");
  assert.equal(speech("Literal `*wild*`, `[label](value)`, and `` `tick` ``."),
    "Literal asterisk wild asterisk, left bracket label right bracket (value), and backtick tick backtick.");
});

test("visible entities decode once, but inline code entity spellings remain literal", () => {
  assert.equal(speech("Fish &amp; chips: 2 &lt; 3 &gt; 1; &#65; &#x42; &#x1F642; &quot;yes&quot; &apos;no&apos;."),
    'Fish and chips: 2 less than 3 greater than 1; A B 🙂 "yes" \'no\'.');
  assert.equal(speech("A&nbsp;B &amp;lt; C; `&amp;` and `&#65;`."),
    "A B and lt; C; and amp; and and hash 65;.");
  assert.equal(speech("&#0; &#xD800; &#x110000;"), "� � �");
});

test("image alt prose and reference-image alt prose remain speakable", () => {
  assert.equal(speech("![Diagram &amp; labels](https://example.invalid/image.png)"), "Diagram and labels");
  assert.equal(speech("![**Second** diagram][image]\n\n[image]: https://example.invalid/image.png"), "Second diagram");
});

test("header-only and single-column tables retain their visible labels and values", () => {
  assert.equal(speech("| Name | Value |\n|---|---|"), "Table with columns: Name; Value.");
  assert.equal(speech("| Name |\n|---|\n| First |\n| Second |"),
    "Table with 2 rows. Row 1: Name: First. Row 2: Name: Second.");
});

test("selection reads all visible assistant prose in only the clicked display group", () => {
  const entries: MessageEntry[] = [
    assistant("previous", "Previous response."),
    { id: "user", message: { role: "user", content: "User request." } },
    assistant("commentary", [
      { type: "thinking", thinking: "Hidden reasoning.", text: "Hidden reasoning text." },
      { type: "text", text: "I will check." },
      { type: "toolCall", text: "Hidden tool call." },
    ], "toolUse"),
    { id: "tool", type: "toolResult", message: { role: "toolResult", content: "Hidden tool result." } },
    assistant("final", [{ type: "text", text: "The result is ready." }]),
    { id: "next-user", message: { role: "user", content: "Next request." } },
    assistant("next", "Next response."),
  ];
  for (const id of ["commentary", "final"]) {
    const group = findAssistantSpeechGroup(entries, id);
    assert.deepEqual(group?.map((entry) => entry.id), ["commentary", "tool", "final"]);
    assert.equal(extractTtsTextFromEntries(group!), "I will check.\n\nThe result is ready.");
  }
  assert.equal(extractTtsTextFromEntries(findAssistantSpeechGroup(entries, "user")!), "");
  assert.equal(findAssistantSpeechGroup(entries, "unknown"), undefined);
});

test("separately rendered text blocks cannot consume each other's prose as code", () => {
  for (const fence of ["```ts", "~~~ts"]) {
    const parts = [
      `Before.\n\n${fence}\nHidden unfinished code.`,
      "After.\n\n| Name | Value |\n|---|---|\n| Example | Correct |",
    ];
    const expected = "Before.\n\nAfter.\n\nTable with 1 row. Row 1: Name: Example; Value: Correct.";
    assert.equal(extractTtsText(assistant("blocks", parts.map((text) => ({ type: "text", text })))), expected);
    assert.equal(extractTtsText(assistant("legacy-blocks", parts)), expected);
  }
  assert.equal(extractTtsText(assistant("indented-blocks", [
    { type: "text", text: "    Hidden indented code." },
    { type: "text", text: "Visible next block." },
  ])), "Visible next block.");
});

test("only assistant text blocks and legacy strings are speakable", () => {
  assert.equal(extractTtsText(assistant("legacy", ["Visible.", null, 42,
    { type: "text", text: "Also visible." },
    { type: "thinking", text: "hidden" }, { type: "reasoning", text: "hidden" },
    { type: "tool_use", text: "hidden" }, { type: "tool_result", text: "hidden" },
    { type: "image", text: "hidden" }, { text: "hidden" },
  ])), "Visible.\n\nAlso visible.");
  for (const role of ["user", "system", "toolResult", "tool_result"]) {
    assert.equal(extractTtsText({ message: { role, content: "hidden" } }), "");
  }
  for (const content of [undefined, "", [], [{ type: "thinking", thinking: "hidden" }], "```ts\ncode\n```"])
    assert.equal(extractTtsText(assistant("empty", content)), "");
  assert.equal(extractTtsText(assistant("error", "Error output", "error")), "");
  assert.equal(extractTtsText({ message: { role: "assistant", content: "Error output", errorMessage: "failure" } }), "");
  // Cancellation does not reclassify already-visible prose as hidden reasoning.
  assert.equal(extractTtsText(assistant("aborted", "Visible partial response.", "aborted")), "Visible partial response.");
});
