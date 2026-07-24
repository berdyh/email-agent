import OpenAI from "openai";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";
import { executeOpenAiCompatible } from "./openai-compatible.js";

let client: OpenAI | null = null;

function getClient(): OpenAI {
  if (!client) {
    client = new OpenAI();
  }
  return client;
}

export class DirectApiExecutor implements AgentExecutor {
  readonly id = "direct-api" as const; // OpenAI-compatible chat completions API

  async isAvailable(): Promise<boolean> {
    return Boolean(process.env["OPENAI_API_KEY"]);
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    return executeOpenAiCompatible(request, {
      agentUsed: "direct-api",
      model: process.env["OPENAI_MODEL"] ?? "gpt-4o-mini",
      getClient,
    });
  }
}
