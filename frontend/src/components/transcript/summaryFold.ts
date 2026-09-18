/**
 * Folded derived summaries (compaction and branch summaries).
 *
 * Pi persists a compaction as a `compaction` transcript entry carrying a
 * `summary`, and `serializeHistoryEntries` turns it into a `custom` message
 * with `customType: "compaction-summary"` (a `branch_summary` becomes
 * `"branch-summary"`). Those summaries are long — a compaction can stand in for
 * most of a session's history — and rendering them expanded by default drowned
 * out the actual conversation when scrolling, so they fold like thinking
 * blocks: collapsed by default, expandable in place.
 *
 * The label and preview rules live here, as pure functions, so they are
 * testable without rendering and stay identical if another surface needs them.
 */

const SUMMARY_LABELS: Readonly<Record<string, string>> = {
  "compaction-summary": "Compaction summary",
  "branch-summary": "Branch summary",
};

/** Custom message types whose content is a long derived summary. */
export const FOLDED_SUMMARY_CUSTOM_TYPES: string[] = Object.keys(SUMMARY_LABELS);

export function isFoldedSummaryCustomType(customType: unknown): boolean {
  return typeof customType === "string" && Object.prototype.hasOwnProperty.call(SUMMARY_LABELS, customType);
}

/** Compact size for the folded header: "0 chars", "840 chars", "4.1k chars", "412k chars". */
export function summarySizeLabel(length: number): string {
  if (!Number.isFinite(length) || length <= 0) return "0 chars";
  if (length < 1000) return `${length} chars`;
  if (length < 10000) return `${(length / 1000).toFixed(1)}k chars`;
  return `${Math.round(length / 1000)}k chars`;
}

/** Header for the folded row: names what is hidden and how much of it. */
export function summaryFoldTitle(customType: string, text: string): string {
  const label = SUMMARY_LABELS[customType] ?? "Summary";
  return `${label} · ${summarySizeLabel(text.length)}`;
}

/**
 * First non-blank line, whitespace-collapsed and bounded, so a folded summary is
 * still identifiable without being opened. Never returns the full body.
 */
export function summaryFoldPreview(text: string, maxChars = 160): string {
  const line = text
    .split("\n")
    .map((part) => part.replace(/\s+/g, " ").trim())
    .find((part) => part.length > 0) ?? "";
  if (line.length <= maxChars) return line;
  return `${line.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}
