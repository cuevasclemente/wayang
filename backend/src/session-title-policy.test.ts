import test from "node:test";
import assert from "node:assert/strict";
import {
  AUTO_TITLE_TOTAL_INPUT_CODE_POINTS,
  acceptedTurnTitleProjection,
  buildBoundedTitleInput,
  extractCompletedTitleExchanges,
  isSafeLegacyInteractiveUserText,
  normalizeGeneratedTitle,
} from "./session-title-policy.js";
import { WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE } from "./interactive-turn-provenance.js";

function exchangeEntries(index: number, options: { stopReason?: string; raw?: string; user?: string; assistant?: unknown } = {}): any[] {
  const userId = `user-${index}`;
  return [
    { type: "message", id: userId, message: { role: "user", content: options.user ?? `decorated user ${index}` } },
    { type: "message", id: `assistant-tool-${index}`, message: { role: "assistant", content: [{ type: "thinking", thinking: "private" }, { type: "text", text: `part ${index}` }], stopReason: "toolUse" } },
    { type: "message", id: `assistant-${index}`, message: { role: "assistant", content: options.assistant ?? [{ type: "text", text: ` done ${index}` }, { type: "thinking", thinking: "never" }], stopReason: options.stopReason ?? "stop" } },
    { type: "custom", id: `marker-${index}`, customType: WAYANG_INTERACTIVE_TURN_SOURCE_CUSTOM_TYPE, data: { user_entry_id: userId, raw_user_text: options.raw ?? `raw user ${index}`, accepted_at: index, client_message_id: `client-${index}` } },
  ];
}

test("title policy counts only marked terminal exchanges and sends only first-three prose", () => {
  const entries = [
    ...exchangeEntries(1),
    ...exchangeEntries(2, { stopReason: "error" }),
    ...exchangeEntries(3, { assistant: [] }),
    ...exchangeEntries(4),
    ...exchangeEntries(5),
  ];
  const projection = extractCompletedTitleExchanges(entries);
  assert.ok(projection);
  assert.equal(projection.completedExchangeCount, 4);
  assert.deepEqual(projection.firstThree.map((exchange) => exchange.userText), ["raw user 1", "raw user 3", "raw user 4"]);
  assert.match(projection.boundedInput, /part 1\s+done 1/);
  assert.doesNotMatch(projection.boundedInput, /private|never|raw user 5|decorated user/);
});

test("accepted browser text builds the standard bounded title request before settlement", () => {
  const projection = acceptedTurnTitleProjection("browser-message-1", "first accepted browser request");
  assert.ok(projection);
  assert.equal(projection.completedExchangeCount, 0);
  assert.deepEqual(projection.firstThree.map((exchange) => exchange.userText), ["first accepted browser request"]);
  assert.match(projection.boundedInput, /Exchange 1 user:\nfirst accepted browser request/);
  assert.equal(acceptedTurnTitleProjection("browser-message-2", "   "), null);
});

test("bounded title input truncates by Unicode code points with a hard total ceiling", () => {
  const huge = "🪶".repeat(20_000);
  const input = buildBoundedTitleInput([
    { userEntryId: "1", userText: huge, assistantText: huge },
    { userEntryId: "2", userText: huge, assistantText: huge },
    { userEntryId: "3", userText: huge, assistantText: huge },
  ]);
  assert.ok(Array.from(input).length <= AUTO_TITLE_TOTAL_INPUT_CODE_POINTS);
  assert.match(input, /…\[truncated\]/);
});

test("legacy source rejects recognized Wayang goal and attachment decoration", () => {
  assert.equal(isSafeLegacyInteractiveUserText("ordinary historical prompt"), true);
  assert.equal(isSafeLegacyInteractiveUserText("[Goal: secret] Working toward this goal.\n\nordinary"), false);
  assert.equal(isSafeLegacyInteractiveUserText('<file name="/private/path" attachment_id="abc">x</file>'), false);
});

test("generated title validation accepts one plain line and rejects wrapper or control output", () => {
  assert.equal(normalizeGeneratedTitle('“Concise session title”'), "Concise session title");
  for (const rejected of [
    "Title: Concise session title",
    "# Concise session title",
    "```title```",
    '{"title":"bad"}',
    "Here is the title: bad",
    "line one\nline two",
    `unsafe\u001b[31m`,
    `unsafe\u202econtrol`,
    "x".repeat(81),
  ]) assert.equal(normalizeGeneratedTitle(rejected), null, rejected);
});
