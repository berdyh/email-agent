import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

const execFile = promisify(execFileCb);

export class CodexExecutor implements AgentExecutor {
  readonly id = "codex" as const;

  async isAvailable(): Promise<boolean> {
    try {
      await execFile("which", ["codex"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();

    const args = ["exec", request.prompt, "--json"];

    const { stdout } = await execFile("codex", args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    // Codex outputs JSONL events; take the last complete JSON line
    const lines = stdout.trim().split("\n").filter(Boolean);
    let text = "";
    let tokensUsed = 0;

    for (const line of lines) {
      try {
        const event = JSON.parse(line) as {
          type?: string;
          content?: string;
          text?: string;
          usage?: { total_tokens?: number };
        };
        if (event.content) text += event.content;
        if (event.text) text += event.text;
        if (event.usage?.total_tokens) tokensUsed = event.usage.total_tokens;
      } catch {
        // Non-JSON line, append as text
        text += line;
      }
    }

    return {
      text: text || stdout,
      agentUsed: "codex",
      tokensUsed,
      durationMs: Date.now() - start,
    };
  }
}
