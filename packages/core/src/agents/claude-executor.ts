import { spawn } from "node:child_process";
import type {
  AgentExecutor,
  AgentRequest,
  AgentResult,
  AgentStreamChunk,
} from "./types.js";

/** Env with CLAUDECODE unset so spawned claude processes don't detect a nested session. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["CLAUDECODE"];
  return env;
}

export class ClaudeExecutor implements AgentExecutor {
  readonly id = "claude" as const;

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("which", ["claude"], { stdio: "ignore", env: cleanEnv() });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();

    // Combine system prompt into the user prompt — passing large text via
    // --system-prompt CLI arg can hang the process.
    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.prompt}`
      : request.prompt;

    const args = ["-p", fullPrompt, "--output-format", "json"];

    // Use spawn instead of execFile — execFile can fail with large args
    return new Promise<AgentResult>((resolve, reject) => {
      const child = spawn("claude", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanEnv(),
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d: Buffer) => { stdout += d.toString(); });
      child.stderr.on("data", (d: Buffer) => { stderr += d.toString(); });

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("claude timed out after 180s"));
      }, 180_000);

      // Kill child if the request is aborted (client disconnect)
      const onAbort = () => {
        child.kill();
        clearTimeout(timeout);
        reject(new Error("Request aborted"));
      };
      request.signal?.addEventListener("abort", onAbort, { once: true });

      child.on("close", (code) => {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
        if (code !== 0) {
          reject(new Error(stderr.trim() || `claude exited with code ${code}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as {
            result?: string;
            text?: string;
            usage?: { output_tokens?: number };
          };

          resolve({
            text: parsed.result ?? parsed.text ?? stdout,
            agentUsed: "claude",
            tokensUsed: parsed.usage?.output_tokens ?? 0,
            durationMs: Date.now() - start,
          });
        } catch {
          resolve({
            text: stdout,
            agentUsed: "claude",
            tokensUsed: 0,
            durationMs: Date.now() - start,
          });
        }
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        reject(new Error(err.message));
      });
    });
  }

  async *executeStream(request: AgentRequest): AsyncGenerator<AgentStreamChunk> {
    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.prompt}`
      : request.prompt;

    const args = ["-p", fullPrompt, "--output-format", "stream-json"];

    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
    let buffer = "";
    let stderrBuf = "";

    const chunks: AgentStreamChunk[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let exitCode: number | null = null;

    // Kill the process if it runs longer than 180s
    const timeout = setTimeout(() => {
      child.kill();
    }, 180_000);

    child.stderr.on("data", (data: Buffer) => {
      stderrBuf += data.toString();
    });

    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
          const event = JSON.parse(trimmed) as Record<string, unknown>;
          if (event["type"] === "content_block_delta") {
            const delta = event["delta"] as
              | { type?: string; text?: string }
              | undefined;
            if (delta?.type === "text_delta" && delta.text) {
              chunks.push({ text: delta.text, done: false });
            }
          } else if (event["type"] === "assistant" && typeof event["content"] === "string") {
            chunks.push({ text: event["content"] as string, done: false });
          } else if (event["type"] === "result" && typeof event["result"] === "string") {
            chunks.push({ text: event["result"] as string, done: true });
          }
        } catch {
          chunks.push({ text: trimmed, done: false });
        }
        resolve?.();
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      exitCode = code;
      done = true;
      resolve?.();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      stderrBuf += err.message;
      done = true;
      resolve?.();
    });

    try {
      while (true) {
        if (chunks.length > 0) {
          yield chunks.shift()!;
        } else if (done) {
          break;
        } else {
          await new Promise<void>((r) => {
            resolve = r;
          });
        }
      }
    } finally {
      // Kill child process if consumer abandons the generator (e.g. client disconnect)
      if (!done) {
        clearTimeout(timeout);
        child.kill();
      }
    }

    if (exitCode !== 0 && chunks.length === 0) {
      throw new Error(
        stderrBuf.trim() || `claude exited with code ${exitCode}`,
      );
    }
  }
}
