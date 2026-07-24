import OpenAI from "openai";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";
import { executeOpenAiCompatible } from "./openai-compatible.js";

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
    return executeOpenAiCompatible(request, {
      agentUsed: "openrouter",
      model: process.env["OPENROUTER_MODEL"] ?? "qwen/qwen3-8b",
      client: getClient(),
    });
  }
}
