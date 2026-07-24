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

/** True when an error represents a client-initiated cancellation. */
function isAbortError(err: unknown): boolean {
  return (
    err instanceof Error &&
    (err.name === "AbortError" || err.message === "Request aborted")
  );
}

const directApi = new DirectApiExecutor();

// direct-api is registered so preferredAgent can select it, but it is kept out
// of fallbackOrder — it only runs when explicitly preferred or via agentMode.
const executors: Partial<Record<AgentId, AgentExecutor>> = {
  "claude-sdk": new SdkExecutor(),
  claude: new ClaudeExecutor(),
  codex: new CodexExecutor(),
  gemini: new GeminiExecutor(),
  openrouter: new OpenRouterExecutor(),
  "direct-api": directApi,
};

export class AgentRouter {
  /**
   * Execute a request using the configured agent routing strategy.
   *
   * - "all-agents": tries preferred agent, falls back to others
   * - "hybrid": tries CLI agents first, falls back to direct API
   * - "direct-api": uses OpenAI-compatible API directly
   */
  async execute(request: AgentRequest): Promise<AgentResult> {
    const executor = await this.resolveExecutor();
    return executor.execute(request);
  }

  /**
   * Stream a request, yielding text chunks as they arrive.
   * Falls back to a single non-streaming chunk if the executor doesn't support
   * streaming, or if streaming fails BEFORE any chunk was emitted. Once chunks
   * have been yielded, a mid-stream error is re-thrown rather than falling back,
   * so partial output is never duplicated by a full re-execute.
   */
  async *executeStream(
    request: AgentRequest,
  ): AsyncGenerator<AgentStreamChunk> {
    const executor = await this.resolveExecutor();

    if (!executor.executeStream) {
      const result = await executor.execute(request);
      yield { text: result.text, done: true };
      return;
    }

    let hasChunks = false;
    try {
      for await (const chunk of executor.executeStream(request)) {
        hasChunks = true;
        yield chunk;
      }
    } catch (err) {
      // Already streamed partial output — re-throw so the caller surfaces the
      // error instead of re-running execute() and duplicating the text.
      if (hasChunks) throw err;
      // An abort before the first chunk is a cancellation, not a stream
      // failure — falling back to execute() would re-run the cancelled work.
      if (isAbortError(err) || request.signal?.aborted) throw err;
      const result = await executor.execute(request);
      yield { text: result.text, done: true };
      return;
    }

    // Streaming produced nothing — fall back to non-streaming.
    if (!hasChunks) {
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
