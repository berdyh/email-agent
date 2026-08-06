/**
 * Canonical definition of `AgentResult.tokensUsed`, shared by every executor.
 *
 * # The definition
 *
 * `tokensUsed` is the **total number of tokens processed for the request**:
 *
 *     tokensUsed = (all input tokens) + (all output tokens)
 *
 * "All input" counts cached/cache-read tokens at **full weight**. It is a
 * measure of work, not of money: we do not model per-provider cache discounts,
 * because each provider prices them differently and none of them reports a
 * normalized figure. Two runs with the same `tokensUsed` did the same amount of
 * token processing, whatever they cost.
 *
 * Every executor must report this same quantity, so `action_results.tokensUsed`
 * is comparable across agents. Before this was unified, each executor reported
 * something different (output-only, input+output, provider totals), which made
 * the column meaningless in aggregate.
 *
 * # Why the per-provider maths differ
 *
 * The providers disagree on whether cached input is *included in* or *additional
 * to* their `input_tokens` field, so the same field name means opposite things.
 * Both behaviours were verified against live runs (see `TODOS.md`):
 *
 * - **Anthropic** (Claude CLI `--output-format json`, Claude Agent SDK):
 *   `input_tokens` is the *uncached remainder only*. `cache_creation_input_tokens`
 *   and `cache_read_input_tokens` are **additive** and must be summed in.
 *   Observed for a one-word reply: `input_tokens: 2`,
 *   `cache_creation_input_tokens: 13901`, `cache_read_input_tokens: 15242`,
 *   `output_tokens: 4` → total 29,149.
 *
 * - **Codex** (`codex exec --json`): `input_tokens` is the *complete* input, and
 *   `cached_input_tokens` is a **subset** of it. Adding it would double-count.
 *   Verified by a delta test: adding ~4,000 tokens of filler to the prompt moved
 *   `input_tokens` 21,403 → 25,412 (+4,009), tracking the prompt 1:1.
 *
 * - **OpenAI-compatible**: `total_tokens` is already the total; the components
 *   are `prompt_tokens` (inclusive of cached) + `completion_tokens`.
 *
 * - **Gemini**: `tokens.total` derives from the Google GenAI SDK's
 *   `usageMetadata.totalTokenCount`, which is already a true total.
 *
 * # Unknown vs. zero
 *
 * Executors report `0` when a provider gives no usage data. `0` therefore means
 * "not reported", not "free" — do not treat it as a measurement.
 */

/** Coerce a possibly-absent numeric usage field to a number. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? value
    : 0;
}

/**
 * Usage shape reported by Anthropic surfaces (Claude CLI JSON output and the
 * Claude Agent SDK's `result` message).
 */
export interface AnthropicUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cache_creation_input_tokens?: number | null;
  cache_read_input_tokens?: number | null;
}

/**
 * Total tokens for an Anthropic usage object.
 *
 * The cache fields are **additive** here: Anthropic's `input_tokens` counts only
 * the uncached remainder, so omitting the cache fields under-reports massively
 * (a live one-word reply reported 4 output tokens against 29,145 input tokens,
 * of which all but 2 were cache traffic).
 */
export function anthropicTotalTokens(
  usage: AnthropicUsageLike | null | undefined,
): number {
  if (!usage) return 0;
  return (
    num(usage.input_tokens) +
    num(usage.cache_creation_input_tokens) +
    num(usage.cache_read_input_tokens) +
    num(usage.output_tokens)
  );
}

/**
 * Usage shape reported by `codex exec --json` on a `turn.completed` event.
 *
 * `cached_input_tokens` and `reasoning_output_tokens` are **subsets** of
 * `input_tokens` / `output_tokens` respectively and are deliberately not summed.
 */
export interface CodexUsageLike {
  input_tokens?: number | null;
  output_tokens?: number | null;
  cached_input_tokens?: number | null;
  reasoning_output_tokens?: number | null;
}

/** Total tokens for a codex `turn.completed` usage object. */
export function codexTotalTokens(
  usage: CodexUsageLike | null | undefined,
): number {
  if (!usage) return 0;
  return num(usage.input_tokens) + num(usage.output_tokens);
}

/** Usage shape reported by OpenAI-compatible chat-completion providers. */
export interface OpenAiUsageLike {
  total_tokens?: number | null;
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
}

/**
 * Total tokens for an OpenAI-compatible usage object.
 *
 * Prefers the provider's own `total_tokens`; falls back to summing the
 * components for providers that report only those. Summing alone would report 0
 * for providers that supply only `total_tokens`.
 */
export function openAiTotalTokens(
  usage: OpenAiUsageLike | null | undefined,
): number {
  if (!usage) return 0;
  const total = num(usage.total_tokens);
  if (total > 0) return total;
  return num(usage.prompt_tokens) + num(usage.completion_tokens);
}
