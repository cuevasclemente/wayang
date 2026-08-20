/**
 * Human-friendly context-window labels for model pickers.
 *
 * Uses decimal units so 524288 renders as "524.3K", matching the labels
 * used for the Narwhal-Horn experimental 512K tier.
 */
export function formatContextWindow(tokens: number | null | undefined): string {
  if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return "";
  if (tokens >= 1_000_000) {
    return `${(tokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  return `${(tokens / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
}
