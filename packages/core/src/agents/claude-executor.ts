import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

const execFile = promisify(execFileCb);

export class ClaudeExecutor implements AgentExecutor {
  readonly id = "claude" as const;

  async isAvailable(): Promise<boolean> {
    try {
      await execFile("which", ["claude"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();

    const args = ["-p", request.prompt, "--output-format", "json"];
    if (request.systemPrompt) {
      args.push("--system", request.systemPrompt);
    }
    if (request.maxTokens) {
      args.push("--max-tokens", String(request.maxTokens));
    }

    const { stdout } = await execFile("claude", args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout) as {
      result?: string;
      text?: string;
      usage?: { output_tokens?: number };
    };

    return {
      text: parsed.result ?? parsed.text ?? stdout,
      agentUsed: "claude",
      tokensUsed: parsed.usage?.output_tokens ?? 0,
      durationMs: Date.now() - start,
    };
  }
}
