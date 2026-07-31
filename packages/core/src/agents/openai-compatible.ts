import type OpenAI from "openai";
import type { AgentId } from "../config/types.js";
import type { AgentRequest, AgentResult } from "./types.js";

export interface OpenAiCompatibleConfig {
  /** Agent id reported on the result (distinct per executor). */
  agentUsed: AgentId;
  /** Model name (distinct per executor, env-var-overridable by the caller). */
  model: string;
  /**
   * Lazily acquires the cached OpenAI-compatible client (distinct
   * baseURL/apiKey per executor). Invoked after the duration timer starts so
   * first-call client construction is counted in the reported latency.
   */
  getClient: () => OpenAI;
}

/**
 * Shared chat-completion execution for OpenAI-compatible providers
 * (direct OpenAI API, OpenRouter, ...). Callers own client construction
 * and caching so distinct baseURLs/API keys/env vars stay isolated.
 */
export async function executeOpenAiCompatible(
  request: AgentRequest,
  config: OpenAiCompatibleConfig,
): Promise<AgentResult> {
  const start = Date.now();
  const client = config.getClient();

  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (request.systemPrompt) {
    messages.push({ role: "system", content: request.systemPrompt });
  }
  messages.push({ role: "user", content: request.prompt });

  const response = await client.chat.completions.create(
    {
      model: config.model,
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.3,
    },
    { signal: request.signal },
  );

  const choice = response.choices[0];
  const text = choice?.message?.content ?? "";
  const usage = response.usage;
  // Prefer the provider's total_tokens; fall back to prompt + completion for
  // providers that report only the components. Some providers supply only
  // total_tokens, so summing the components alone would report 0.
  const tokensUsed = usage
    ? (usage.total_tokens ?? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0))
    : 0;

  return {
    text,
    agentUsed: config.agentUsed,
    tokensUsed,
    durationMs: Date.now() - start,
  };
}
