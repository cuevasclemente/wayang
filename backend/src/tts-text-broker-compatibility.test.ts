import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { normalizeSpeechText } from "./tts-text.js";

// Optional cross-repository probe: only the named source module is imported.
// No broker service, configuration, job registry, real input, or audio is used.
const source = process.env.TTS_BROKER_SPEECH_TEXT_SOURCE;

test("synthetic prepared table prose survives the exact broker normalizer", {
  skip: !source && "Set TTS_BROKER_SPEECH_TEXT_SOURCE to the reviewed speech_text.py file",
}, () => {
  const markdown = [
    "# Visible commentary\n\nChecking the result.",
    "| Name | | Value |\n|---|---|---|\n| Example | | Correct |\n| | Middle | |",
    ["| Name | A | B | C | D |", "|---|---|---|---|---|",
      ...Array.from({ length: 9 }, (_, i) => `| Item ${i + 1} | ${i}.25 | yes | no | last |`)].join("\n"),
    "| Label | Value |\n|---|---|\n| A\\|B | `x\\|y` |",
    "Before.\n\n~~~md\n| hidden | code |\n|---|---|\n| no | speech |\n~~~\n\nAfter.",
  ];
  const prepared = markdown.map(normalizeSpeechText);
  assert.deepEqual(brokerNormalize(prepared), prepared);
});

test("literal operators, identifiers and decoded entities survive the broker's second pass", {
  skip: !source && "Set TTS_BROKER_SPEECH_TEXT_SOURCE to the reviewed speech_text.py file",
}, () => {
  const prepared = [
    "Use `version_one_two`; check 2 < 3 > 1.",
    "`x <= 3` and `y >= 2`; `x != y`; `a => b`; `a + b = c`.",
    "Literal `*wild*`, `[label](value)`, and `` `tick` ``.",
    "Fish &amp; chips: 2 &lt; 3; &#65; &#x42; &#x1F642; &quot;yes&quot;.",
    "| Name | Comparison |\n|---|---|\n| `version_one_two` | `2 < 3 > 1` |",
  ].map(normalizeSpeechText);
  assert.equal(prepared[0], "Use version underscore one underscore two; check 2 less than 3 greater than 1.");
  assert.deepEqual(brokerNormalize(prepared), prepared);
});

function brokerNormalize(texts: string[]): string[] {
  const result = spawnSync("python3", ["-I", "-c", `
import importlib.util, json, sys
sys.dont_write_bytecode = True
spec = importlib.util.spec_from_file_location("speech_text_probe", sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
print(json.dumps([module.prepare_text_for_tts(text) for text in json.load(sys.stdin)]))
`, source!], { input: JSON.stringify(texts), encoding: "utf8", timeout: 10_000 });
  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}
