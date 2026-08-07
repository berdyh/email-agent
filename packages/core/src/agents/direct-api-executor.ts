import OpenAI from "openai";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";
import { executeOpenAiCompatible } from "./openai-compatible.js";

/**
 * Test/self-host seam. Omit for production behaviour: the OpenAI SDK then
 * resolves the base URL itself (honouring `OPENAI_BASE_URL`) and reads
 * `OPENAI_API_KEY` from the environment, exactly as before.
 */
export interface DirectApiExecutorOptions {
  baseURL?: string;
  apiKey?: string;
  model?: string;
}

export class DirectApiExecutor implements AgentExecutor {
  readonly id = "direct-api" as const; // OpenAI-compatible chat completions API

  // Cached per instance so distinct baseURLs/API keys stay isolated. The router
  // constructs one instance, so this preserves the previous caching behaviour.
  private client: OpenAI | null = null;

  constructor(private readonly options: DirectApiExecutorOptions = {}) {}

  async isAvailable(): Promise<boolean> {
    return Boolean(this.options.apiKey ?? process.env["OPENAI_API_KEY"]);
  }

  private getClient(): OpenAI {
    if (!this.client) {
      // Pass only the overrides that were supplied, so the default path stays
      // byte-identical to `new OpenAI()`.
      this.client = new OpenAI({
        ...(this.options.baseURL ? { baseURL: this.options.baseURL } : {}),
        ...(this.options.apiKey ? { apiKey: this.options.apiKey } : {}),
      });
    }
    return this.client;
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    return executeOpenAiCompatible(request, {
      agentUsed: "direct-api",
      model:
        this.options.model ?? process.env["OPENAI_MODEL"] ?? "gpt-4o-mini",
      getClient: () => this.getClient(),
    });
  }
}
