import OpenAI from "openai";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI({
      baseURL: "https://openrouter.ai/api/v1",
      apiKey: process.env["OPENROUTER_API_KEY"],
    });
  }
  return client;
}

export class OpenRouterExecutor implements AgentExecutor {
  readonly id = "openrouter" as const;

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env["OPENROUTER_API_KEY"]);
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();
    const openrouter = getClient();

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.prompt });

    const response = await openrouter.chat.completions.create({
      model: process.env["OPENROUTER_MODEL"] ?? "qwen/qwen3-8b",
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.3,
    });

    const choice = response.choices[0];
    const text = choice?.message?.content ?? "";

    return {
      text,
      agentUsed: "openrouter",
      tokensUsed: response.usage?.total_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  }
}
