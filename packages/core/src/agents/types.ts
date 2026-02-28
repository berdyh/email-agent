import type { AgentId } from "../config/types.js";

export interface AgentRequest {
  prompt: string;
  systemPrompt?: string;
  maxTokens?: number;
  temperature?: number;
  /** Abort signal — kills the spawned process when the client disconnects. */
  signal?: AbortSignal;
}

export interface AgentResult {
  text: string;
  agentUsed: AgentId;
  tokensUsed: number;
  durationMs: number;
}

export interface AgentStreamChunk {
  text: string;
  done: boolean;
}

export interface AgentExecutor {
  readonly id: AgentId;
  isAvailable(): Promise<boolean>;
  execute(request: AgentRequest): Promise<AgentResult>;
  executeStream?(request: AgentRequest): AsyncGenerator<AgentStreamChunk>;
}
