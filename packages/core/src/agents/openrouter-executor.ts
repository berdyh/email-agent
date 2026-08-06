import OpenAI from "openai";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";
import { executeOpenAiCompatible } from "./openai-compatible.js";

/** Production OpenRouter endpoint. Overridable only for tests/self-hosting. */
const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

/**
 * Test/self-host seam. Omit for production behaviour: the executor then targets
 * {@link OPENROUTER_BASE_URL} with `OPENROUTER_API_KEY`, exactly as before.
 */
export interface OpenRouterExecutorOptions {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export class OpenRouterExecutor implements AgentExecutor {
  readonly id = "openrouter" as const;

  // Cached per instance so distinct baseURLs/API keys stay isolated.
  private client: OpenAI | null = null;

  constructor(private readonly options: OpenRouterExecutorOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.options.apiKey ?? process.env["OPENROUTER_API_KEY"]);
  }

  private getClient(): OpenAI {
    if (!this.client) {
      this.client = new OpenAI({
        baseURL: this.options.baseURL ?? OPENROUTER_BASE_URL,
        apiKey: this.options.apiKey ?? process.env["OPENROUTER_API_KEY"],
      });
    }
    return this.client;
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    return executeOpenAiCompatible(request, {
      agentUsed: "openrouter",
      model:
        this.options.model ?? process.env["OPENROUTER_MODEL"] ?? "qwen/qwen3-8b",
      getClient: () => this.getClient(),
    });
  }
}
