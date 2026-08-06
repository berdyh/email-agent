import { spawn } from "node:child_process";
import type {
  AgentExecutor,
  AgentRequest,
  AgentResult,
  AgentStreamChunk,
} from "./types.js";
import { anthropicTotalTokens, type AnthropicUsageLike } from "./tokens.js";

/** Env with CLAUDECODE unset so spawned claude processes don't detect a nested session. */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["CLAUDECODE"];
  return env;
}

export interface ClaudeCliParseResult {
  text: string;
  tokensUsed: number;
}

/**
 * Parse the JSON emitted by `claude -p --output-format json`.
 *
 * Pure so the token accounting can be unit-tested without spawning the CLI.
 *
 * Observed shape (CLI live run, one-word reply):
 *   {"type":"result","subtype":"success","result":"pong",
 *    "usage":{"input_tokens":2,"cache_creation_input_tokens":13901,
 *             "cache_read_input_tokens":15242,"output_tokens":4}, ...}
 *
 * `tokensUsed` follows the canonical definition in `tokens.js`: all input
 * (including cache traffic, which Anthropic reports *separately from*
 * `input_tokens`) plus all output. Recording `output_tokens` alone — as this
 * executor used to — under-reported that run by roughly four orders of
 * magnitude.
 *
 * Non-JSON stdout is returned verbatim as the answer with 0 tokens, so a CLI
 * that prints plain text still produces a usable result rather than an error.
 */
export function parseClaudeCliOutput(stdout: string): ClaudeCliParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { text: stdout, tokensUsed: 0 };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { text: stdout, tokensUsed: 0 };
  }

  const record = parsed as {
    result?: unknown;
    text?: unknown;
    usage?: AnthropicUsageLike | null;
  };

  const text =
    typeof record.result === "string"
      ? record.result
      : typeof record.text === "string"
        ? record.text
        : stdout;

  return { text, tokensUsed: anthropicTotalTokens(record.usage) };
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

        const { text, tokensUsed } = parseClaudeCliOutput(stdout);
        resolve({
          text,
          agentUsed: "claude",
          tokensUsed,
          durationMs: Date.now() - start,
        });
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

    // stream-json requires --verbose; --include-partial-messages makes the CLI
    // emit incremental content_block_delta events so text streams token-by-token.
    const args = [
      "-p",
      fullPrompt,
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--verbose",
    ];

    const child = spawn("claude", args, { stdio: ["ignore", "pipe", "pipe"], env: cleanEnv() });
    let buffer = "";
    let stderrBuf = "";

    const chunks: AgentStreamChunk[] = [];
    let resolve: (() => void) | null = null;
    let done = false;
    let exitCode: number | null = null;
    let aborted = false;
    // Track whether any incremental text was emitted so the terminal `assistant`
    // and `result` events don't re-emit the full message and duplicate output.
    let emittedText = false;

    // Kill the process if it runs longer than 180s
    const timeout = setTimeout(() => {
      child.kill();
    }, 180_000);

    // Kill child immediately if the request is aborted (client disconnect) so an
    // abandoned chat doesn't keep the subprocess alive until the timeout fires.
    const onAbort = () => {
      aborted = true;
      clearTimeout(timeout);
      child.kill();
      done = true;
      resolve?.();
    };
    request.signal?.addEventListener("abort", onAbort, { once: true });

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
          const type = event["type"];
          if (type === "stream_event") {
            // --include-partial-messages wraps deltas in a stream_event envelope.
            const inner = event["event"] as
              | { type?: string; delta?: { type?: string; text?: string } }
              | undefined;
            if (
              inner?.type === "content_block_delta" &&
              inner.delta?.type === "text_delta" &&
              inner.delta.text
            ) {
              emittedText = true;
              chunks.push({ text: inner.delta.text, done: false });
            }
          } else if (type === "content_block_delta") {
            const delta = event["delta"] as
              | { type?: string; text?: string }
              | undefined;
            if (delta?.type === "text_delta" && delta.text) {
              emittedText = true;
              chunks.push({ text: delta.text, done: false });
            }
          } else if (type === "assistant") {
            // The CLI puts text blocks in an array under message.content.
            const message = event["message"] as
              | { content?: Array<{ type?: string; text?: string }> }
              | undefined;
            if (!emittedText && Array.isArray(message?.content)) {
              for (const block of message!.content) {
                if (block?.type === "text" && block.text) {
                  emittedText = true;
                  chunks.push({ text: block.text, done: false });
                }
              }
            }
          } else if (type === "result" && typeof event["result"] === "string") {
            // If deltas already streamed, only signal completion — don't repeat
            // the full text.
            chunks.push({
              text: emittedText ? "" : (event["result"] as string),
              done: true,
            });
          }
        } catch {
          chunks.push({ text: trimmed, done: false });
        }
        resolve?.();
      }
    });

    child.on("close", (code) => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
      exitCode = code;
      done = true;
      resolve?.();
    });

    child.on("error", (err) => {
      clearTimeout(timeout);
      request.signal?.removeEventListener("abort", onAbort);
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
      request.signal?.removeEventListener("abort", onAbort);
      // Kill child process if consumer abandons the generator (e.g. client disconnect)
      if (!done) {
        clearTimeout(timeout);
        child.kill();
      }
    }

    // Surface aborts as an AbortError so the router can distinguish a cancelled
    // stream from a genuine failure and avoid a duplicate execute() fallback.
    if (aborted || request.signal?.aborted) {
      const err = new Error("Request aborted");
      err.name = "AbortError";
      throw err;
    }

    if (exitCode !== 0 && chunks.length === 0) {
      throw new Error(
        stderrBuf.trim() || `claude exited with code ${exitCode}`,
      );
    }
  }
}
