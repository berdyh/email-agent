import { loadSettings } from "../config/settings.js";
import type { AgentId } from "../config/types.js";
import type {
  AgentExecutor,
  AgentRequest,
  AgentResult,
  AgentStreamChunk,
} from "./types.js";
import { ClaudeExecutor } from "./claude-executor.js";
import { CodexExecutor } from "./codex-executor.js";
import { GeminiExecutor } from "./gemini-executor.js";
import { DirectApiExecutor } from "./direct-api-executor.js";
import { OpenRouterExecutor } from "./openrouter-executor.js";
import { SdkExecutor } from "./sdk-executor.js";

const executors: Record<AgentId, AgentExecutor> = {
  "claude-sdk": new SdkExecutor(),
  claude: new ClaudeExecutor(),
  codex: new CodexExecutor(),
  gemini: new GeminiExecutor(),
  openrouter: new OpenRouterExecutor(),
};

const directApi = new DirectApiExecutor();

export class AgentRouter {
  /**
   * Execute a request using the configured agent routing strategy.
   *
   * - "all-agents": tries preferred agent, falls back to others
   * - "hybrid": tries CLI agents first, falls back to direct API
   * - "direct-api": uses OpenAI-compatible API directly
   */
  async execute(request: AgentRequest): Promise<AgentResult> {
    const settings = await loadSettings();
    const { agentMode, preferredAgent } = settings;

    if (agentMode === "direct-api") {
      return directApi.execute(request);
    }

    // Try preferred agent first
    const preferred = executors[preferredAgent];
    if (preferred && (await preferred.isAvailable())) {
      return preferred.execute(request);
    }

    // Try other agents in order
    const fallbackOrder: AgentId[] = [
      "claude-sdk",
      "claude",
      "codex",
      "gemini",
      "openrouter",
    ];
    for (const id of fallbackOrder) {
      if (id === preferredAgent) continue;
      const executor = executors[id];
      if (executor && (await executor.isAvailable())) {
        return executor.execute(request);
      }
    }

    // Hybrid mode: fall back to direct API
    if (agentMode === "hybrid") {
      return directApi.execute(request);
    }

    throw new Error(
      "No agent available. Install claude, codex, or gemini CLI, or set agentMode to 'direct-api'.",
    );
  }

  /**
   * Stream a request, yielding text chunks as they arrive.
   * Falls back to single-chunk if the executor doesn't support streaming,
   * or if streaming throws an error.
   */
  async *executeStream(
    request: AgentRequest,
  ): AsyncGenerator<AgentStreamChunk> {
    const executor = await this.resolveExecutor();

    if (executor.executeStream) {
      try {
        let hasChunks = false;
        for await (const chunk of executor.executeStream(request)) {
          hasChunks = true;
          yield chunk;
        }
        // If streaming produced nothing, fall back to non-streaming
        if (!hasChunks) {
          const result = await executor.execute(request);
          yield { text: result.text, done: true };
        }
      } catch {
        // Streaming failed — fall back to non-streaming execute
        const result = await executor.execute(request);
        yield { text: result.text, done: true };
      }
    } else {
      const result = await executor.execute(request);
      yield { text: result.text, done: true };
    }
  }

  private async resolveExecutor(): Promise<AgentExecutor> {
    const settings = await loadSettings();
    const { agentMode, preferredAgent } = settings;

    if (agentMode === "direct-api") {
      return directApi;
    }

    const preferred = executors[preferredAgent];
    if (preferred && (await preferred.isAvailable())) {
      return preferred;
    }

    const fallbackOrder: AgentId[] = [
      "claude-sdk",
      "claude",
      "codex",
      "gemini",
      "openrouter",
    ];
    for (const id of fallbackOrder) {
      if (id === preferredAgent) continue;
      const executor = executors[id];
      if (executor && (await executor.isAvailable())) {
        return executor;
      }
    }

    if (agentMode === "hybrid") {
      return directApi;
    }

    throw new Error(
      "No agent available. Install claude, codex, or gemini CLI, or set agentMode to 'direct-api'.",
    );
  }
}
