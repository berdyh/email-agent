import type OpenAI from "openai";
import type { AgentId } from "../config/types.js";
import type { AgentRequest, AgentResult } from "./types.js";

export interface OpenAiCompatibleConfig {
  /** Agent id reported on the result (distinct per executor). */
  agentUsed: AgentId;
  /** Model name (distinct per executor, env-var-overridable by the caller). */
  model: string;
  /** Cached OpenAI-compatible client (distinct baseURL/apiKey per executor). */
  client: OpenAI;
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

  const messages: OpenAI.ChatCompletionMessageParam[] = [];
  if (request.systemPrompt) {
    messages.push({ role: "system", content: request.systemPrompt });
  }
  messages.push({ role: "user", content: request.prompt });

  const response = await config.client.chat.completions.create(
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
  // Standardized as input + output total (not the provider's total_tokens
  // field, which some OpenAI-compatible providers omit or define
  // inconsistently, e.g. including reasoning tokens).
  const tokensUsed = usage
    ? (usage.prompt_tokens ?? 0) + (usage.completion_tokens ?? 0)
    : 0;

  return {
    text,
    agentUsed: config.agentUsed,
    tokensUsed,
    durationMs: Date.now() - start,
  };
}
