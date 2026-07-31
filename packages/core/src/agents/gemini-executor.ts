import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

const execFile = promisify(execFileCb);

export class GeminiExecutor implements AgentExecutor {
  readonly id = "gemini" as const;

  async isAvailable(): Promise<boolean> {
    try {
      // `--no-install` so probing availability never triggers an npx auto-install
      // of the CLI from the registry.
      await execFile("npx", ["--no-install", "@google/gemini-cli", "--version"]);
      return true;
    } catch {
      return false;
    }
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();

    // Gemini has no system-prompt flag — fold it into the user prompt like the
    // Claude CLI executor does, otherwise the skill doc is silently dropped.
    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.prompt}`
      : request.prompt;

    const args = [
      "--no-install",
      "@google/gemini-cli",
      "-p",
      fullPrompt,
      "--output-format",
      "json",
    ];

    const { stdout } = await execFile("npx", args, {
      timeout: 120_000,
      maxBuffer: 10 * 1024 * 1024,
      signal: request.signal,
    });

    // `gemini --output-format json` emits {"response":"...","stats":{...}}.
    let text = "";
    let tokensUsed = 0;
    try {
      const parsed = JSON.parse(stdout) as {
        response?: string;
        result?: string;
        text?: string;
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        stats?: { totalTokenCount?: number };
        usageMetadata?: { totalTokenCount?: number };
      };
      text =
        parsed.response ??
        parsed.result ??
        parsed.text ??
        parsed.candidates?.[0]?.content?.parts?.[0]?.text ??
        "";
      tokensUsed =
        parsed.stats?.totalTokenCount ??
        parsed.usageMetadata?.totalTokenCount ??
        0;
    } catch {
      // Not JSON — treat the raw output as plain text rather than failing.
      text = stdout.trim();
    }

    return {
      text,
      agentUsed: "gemini",
      tokensUsed,
      durationMs: Date.now() - start,
    };
  }
}
