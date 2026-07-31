import { spawn } from "node:child_process";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

/** CODEX_* vars that carry auth/config and must survive env cleaning. */
const CODEX_KEEP = new Set(["CODEX_HOME", "CODEX_API_KEY"]);

/**
 * Env for spawned codex processes with nested-session markers stripped.
 *
 * Mirrors the claude-executor cleanEnv gotcha: a coding agent that spawns
 * another CLI can be refused as a "nested session". We drop CLAUDECODE and
 * defensively strip unknown CODEX_* session vars, keeping only well-known
 * auth/config vars so real credentials and config still reach the child.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  delete env["CLAUDECODE"];
  for (const key of Object.keys(env)) {
    if (key.startsWith("CODEX_") && !CODEX_KEEP.has(key)) {
      delete env[key];
    }
  }
  return env;
}

export interface CodexParseResult {
  text: string;
  tokensUsed: number;
}

/**
 * Parse the JSONL emitted by `codex exec --json` into the final answer + token
 * usage. This is a pure function so it can be unit-tested against fixtures.
 *
 * Current codex CLI (0.144.x) emits event objects like:
 *   {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
 *   {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":M}}
 *
 * Older releases wrapped every payload under `msg`:
 *   {"msg":{"type":"agent_message","message":"..."}}
 *   {"msg":{"type":"token_count","info":{"total_token_usage":{"total_tokens":N}}}}
 *
 * The current shape is primary; the legacy `msg` envelope is the fallback.
 * Non-JSON lines are treated as plain-text output and only surfaced if no
 * agent_message events were parsed (so raw event-log JSON is never returned).
 */
export function parseCodexOutput(stdout: string): CodexParseResult {
  const lines = stdout.trim().split("\n").filter(Boolean);
  let text = "";
  let plainFallback = "";
  let tokensUsed = 0;

  for (const line of lines) {
    let event: unknown;
    try {
      event = JSON.parse(line);
    } catch {
      // Non-JSON line — the CLI emitted plain text; keep it as a fallback but
      // never surface raw event-log JSON as the answer.
      plainFallback += line;
      continue;
    }

    if (typeof event !== "object" || event === null) continue;
    const record = event as Record<string, unknown>;

    // Current shape: {"type":"item.completed","item":{"type":"agent_message","text":"..."}}
    if (record["type"] === "item.completed") {
      const item = record["item"] as
        | { type?: string; text?: string }
        | undefined;
      if (item?.type === "agent_message" && typeof item.text === "string") {
        text += item.text;
      }
      continue;
    }

    // Current shape: {"type":"turn.completed","usage":{"input_tokens":N,"output_tokens":M}}
    if (record["type"] === "turn.completed") {
      const usage = record["usage"] as
        | { input_tokens?: number; output_tokens?: number }
        | undefined;
      const input =
        typeof usage?.input_tokens === "number" ? usage.input_tokens : 0;
      const output =
        typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
      if (input || output) {
        tokensUsed = input + output;
      }
      continue;
    }

    // Legacy shape: {"msg":{"type":"agent_message","message":"..."}}
    const msg = record["msg"] as
      | {
          type?: string;
          message?: string;
          info?: { total_token_usage?: { total_tokens?: number } };
        }
      | undefined;
    if (msg?.type === "agent_message" && typeof msg.message === "string") {
      text += msg.message;
    } else if (
      msg?.type === "token_count" &&
      typeof msg.info?.total_token_usage?.total_tokens === "number"
    ) {
      tokensUsed = msg.info.total_token_usage.total_tokens;
    }
  }

  return { text: text || plainFallback, tokensUsed };
}

export class CodexExecutor implements AgentExecutor {
  readonly id = "codex" as const;

  async isAvailable(): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn("which", ["codex"], {
        stdio: "ignore",
        env: cleanEnv(),
      });
      child.on("close", (code) => resolve(code === 0));
      child.on("error", () => resolve(false));
    });
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    const start = Date.now();

    // Codex has no system-prompt flag — fold it into the user prompt like the
    // Claude CLI executor does, otherwise the skill doc is silently dropped.
    const fullPrompt = request.systemPrompt
      ? `${request.systemPrompt}\n\n---\n\n${request.prompt}`
      : request.prompt;

    const args = ["exec", fullPrompt, "--json"];

    // Use spawn instead of execFile — execFile can be SIGTERM-killed by Node
    // for long-running processes (documented Claude CLI gotcha, same applies to
    // codex), and spawn lets us strip nested-session env vars.
    return new Promise<AgentResult>((resolve, reject) => {
      const child = spawn("codex", args, {
        stdio: ["ignore", "pipe", "pipe"],
        env: cleanEnv(),
      });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (d: Buffer) => {
        stdout += d.toString();
      });
      child.stderr.on("data", (d: Buffer) => {
        stderr += d.toString();
      });

      const timeout = setTimeout(() => {
        child.kill();
        reject(new Error("codex timed out after 120s"));
      }, 120_000);

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
          reject(new Error(stderr.trim() || `codex exited with code ${code}`));
          return;
        }

        const { text, tokensUsed } = parseCodexOutput(stdout);
        resolve({
          text,
          agentUsed: "codex",
          tokensUsed,
          durationMs: Date.now() - start,
        });
      });

      child.on("error", (err) => {
        clearTimeout(timeout);
        request.signal?.removeEventListener("abort", onAbort);
        reject(new Error(err.message));
      });
    });
  }
}
