import { DeepSeekTitleProvider } from "./deepseek-title-provider.js";
import { CodexTitleProvider } from "./codex-title-provider.js";
import type { PreparedTitleRequest, TitleProvider } from "./deepseek-title-provider.js";

export type { PreparedTitleRequest, TitleProvider } from "./deepseek-title-provider.js";

/** Host-local selector for the two reviewed, immutable title descriptors. */
export const AUTO_TITLE_PROVIDER_ENV = "WAYANG_AUTO_TITLE_PROVIDER";

/**
 * The only reviewed selector values. An unset or empty selector preserves the
 * historical OpenRouter DeepSeek default; `codex` opts a host into the reviewed
 * Codex/Terra descriptor. Any other value fails closed.
 */
const DEEPSEEK_PROVIDER_VALUES: ReadonlySet<string> = new Set(["openrouter", "deepseek"]);
const CODEX_PROVIDER_VALUES: ReadonlySet<string> = new Set(["codex", "terra"]);

/**
 * Fail-closed provider for an unreviewed selector value.
 *
 * It never substitutes a different reviewed provider and never builds one from
 * user-editable models.json keys/commands, extension providers, or runtime
 * overrides. `prepare()` rejects with the same `title_model_unavailable` error
 * the reviewed providers use when reviewed credentials are absent, so callers
 * record an unavailable attempt and disclose nothing.
 */
class UnavailableTitleProvider implements TitleProvider {
  async prepare(): Promise<PreparedTitleRequest> {
    throw new Error("title_model_unavailable");
  }
}

/**
 * Build the title provider selected by `WAYANG_AUTO_TITLE_PROVIDER`.
 *
 * Exactly one of two reviewed descriptors is returned, or the fail-closed
 * placeholder for any unreviewed value.
 */
export function createTitleProvider(): TitleProvider {
  const selected = process.env[AUTO_TITLE_PROVIDER_ENV];
  if (selected === undefined || selected === "" || DEEPSEEK_PROVIDER_VALUES.has(selected)) {
    return new DeepSeekTitleProvider();
  }
  if (CODEX_PROVIDER_VALUES.has(selected)) return new CodexTitleProvider();
  return new UnavailableTitleProvider();
}
