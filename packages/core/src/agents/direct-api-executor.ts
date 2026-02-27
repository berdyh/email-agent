import OpenAI from "openai";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

export class DirectApiExecutor implements AgentExecutor {
  readonly id = "claude" as const; // Uses OpenAI-compatible API

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env["OPENAI_API_KEY"]);
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();
    const openai = getClient();

    const messages: OpenAI.ChatCompletionMessageParam[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.prompt });

    const response = await openai.chat.completions.create({
      model: process.env["OPENAI_MODEL"] ?? "gpt-4o-mini",
      messages,
      max_tokens: request.maxTokens,
      temperature: request.temperature ?? 0.3,
    });

    const choice = response.choices[0];
    const text = choice?.message?.content ?? "";

    return {
      text,
      agentUsed: "claude",
      tokensUsed: response.usage?.total_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  }
}
