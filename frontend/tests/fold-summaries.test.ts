import assert from "node:assert/strict";
import test from "node:test";
import {
  FOLDED_SUMMARY_CUSTOM_TYPES,
  isFoldedSummaryCustomType,
  summaryFoldPreview,
  summaryFoldTitle,
  summarySizeLabel,
} from "../src/components/transcript/summaryFold.ts";

test("only compaction and branch summaries fold by default", () => {
  assert.deepEqual(FOLDED_SUMMARY_CUSTOM_TYPES.sort(), ["branch-summary", "compaction-summary"]);
  assert.equal(isFoldedSummaryCustomType("compaction-summary"), true);
  assert.equal(isFoldedSummaryCustomType("branch-summary"), true);
  // Other custom entries stay expanded: they are short notices, not history.
  assert.equal(isFoldedSummaryCustomType("wayang-agent-change"), false);
  assert.equal(isFoldedSummaryCustomType("wayang-interview-submission"), false);
  assert.equal(isFoldedSummaryCustomType("command-guard-status"), false);
  assert.equal(isFoldedSummaryCustomType("custom"), false);
  assert.equal(isFoldedSummaryCustomType(undefined), false);
  assert.equal(isFoldedSummaryCustomType(null), false);
});

test("inherited object keys are never treated as summary types", () => {
  assert.equal(isFoldedSummaryCustomType("constructor"), false);
  assert.equal(isFoldedSummaryCustomType("toString"), false);
});

test("the folded header names what is hidden and how much of it", () => {
  assert.equal(summaryFoldTitle("compaction-summary", "x".repeat(4120)), "Compaction summary · 4.1k chars");
  assert.equal(summaryFoldTitle("branch-summary", "x".repeat(840)), "Branch summary · 840 chars");
  assert.equal(summaryFoldTitle("compaction-summary", ""), "Compaction summary · 0 chars");
  assert.equal(summarySizeLabel(999), "999 chars");
  assert.equal(summarySizeLabel(1000), "1.0k chars");
  assert.equal(summarySizeLabel(412300), "412k chars");
});

test("the collapsed preview is one bounded line, never the summary body", () => {
  const summary = "\n\n  Earlier turns were replaced by this summary.  \nMore detail here.\n";
  assert.equal(summaryFoldPreview(summary), "Earlier turns were replaced by this summary.");
  assert.equal(
    summaryFoldPreview("q".repeat(400)).length,
    160,
    "an over-long first line is truncated to the preview budget",
  );
  assert.equal(summaryFoldPreview("q".repeat(400)).endsWith("…"), true);
  assert.equal(summaryFoldPreview(""), "");
  assert.equal(summaryFoldPreview("   \n\t\n"), "");
});
