import type OpenAI from "openai";
import type { AgentId } from "../config/types.js";
import type { AgentRequest, AgentResult } from "./types.js";
import { openAiTotalTokens } from "./tokens.js";

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
  // Canonical tokensUsed (see tokens.js): all input + all output. For
  // OpenAI-compatible providers `total_tokens` is already that figure, with
  // prompt+completion as the fallback for providers reporting only components.
  const tokensUsed = openAiTotalTokens(response.usage);

  return {
    text,
    agentUsed: config.agentUsed,
    tokensUsed,
    durationMs: Date.now() - start,
  };
}
