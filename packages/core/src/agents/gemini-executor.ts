import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

const execFile = promisify(execFileCb);

export class GeminiExecutor implements AgentExecutor {
  readonly id = "gemini" as const;

  async isAvailable(): Promise<boolean> {
    try {
      await execFile("npx", ["@google/gemini-cli", "--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();

    const args = [
      "@google/gemini-cli",
      "-p",
      request.prompt,
      "--output-format",
      "json",
    ];

    const { stdout } = await execFile("npx", args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
    });

    const parsed = JSON.parse(stdout) as {
      result?: string;
      text?: string;
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
      usageMetadata?: { totalTokenCount?: number };
    };

    const text =
      parsed.result ??
      parsed.text ??
      parsed.candidates?.[0]?.content?.parts?.[0]?.text ??
      stdout;

    return {
      text,
      agentUsed: "gemini",
      tokensUsed: parsed.usageMetadata?.totalTokenCount ?? 0,
      durationMs: Date.now() - start,
    };
  }
}
