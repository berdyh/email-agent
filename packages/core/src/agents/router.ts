import { loadSettings } from "../config/settings.js";
import type { AgentId } from "../config/types.js";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";
import { ClaudeExecutor } from "./claude-executor.js";
import { CodexExecutor } from "./codex-executor.js";
import { GeminiExecutor } from "./gemini-executor.js";
import { DirectApiExecutor } from "./direct-api-executor.js";
import { OpenRouterExecutor } from "./openrouter-executor.js";

const executors: Record<AgentId, AgentExecutor> = {
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
    const fallbackOrder: AgentId[] = ["claude", "codex", "gemini", "openrouter"];
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
}
