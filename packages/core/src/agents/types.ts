import type { AgentId } from "../config/types.js";

export interface AgentRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface AgentResult {
  text: string;
  agentUsed: AgentId;
  tokensUsed: number;
  durationMs: number;
}

export interface AgentExecutor {
  readonly id: AgentId;
  isAvailable(): Promise<boolean>;
  execute(request: AgentRequest): Promise<AgentResult>;
}
