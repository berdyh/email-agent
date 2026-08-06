import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

const execFile = promisify(execFileCb);

export interface GeminiParseResult {
  text: string;
  tokensUsed: number;
}

/** Per-model token counters inside the CLI's telemetry `stats` object. */
interface GeminiModelStats {
  tokens?: {
    total?: number | null;
  } | null;
}

/**
 * Parse the JSON emitted by `gemini -p ... --output-format json`.
 *
 * Pure so the parse path can be exercised without the CLI (which requires an
 * interactive browser OAuth flow to authenticate — see TODOS.md).
 *
 * # Envelope
 *
 * Confirmed from the CLI's own shipped docs (`docs/cli/headless.md`) and its
 * `JsonFormatter.format()` implementation, both read out of the installed
 * package (`@google/gemini-cli` 0.54.0):
 *
 *     { session_id?, response?, stats?, error?, warnings? }
 *
 * `formatError()` emits `error` with **no** `response` field, so a failed run
 * must not be reported as an empty successful answer — callers get an error.
 *
 * # Token accounting
 *
 * For `--output-format json` the CLI passes `uiTelemetryService.getMetrics()`
 * straight through as `stats`, giving:
 *
 *     stats.models["<model>"].tokens = {
 *       input, prompt, candidates, total, cached, thoughts, tool
 *     }
 *
 * There is **no** `stats.totalTokenCount` — this parser previously read that
 * (camelCase) field, which does not exist in the JSON envelope, so gemini runs
 * always recorded 0 tokens. `tokens.total` derives from the Google GenAI SDK's
 * `usageMetadata.totalTokenCount` and is already a true total (prompt +
 * candidates + thoughts), matching the canonical definition in `tokens.js`. A
 * session can touch more than one model, so the per-model totals are summed.
 *
 * `usageMetadata.totalTokenCount` is accepted as a secondary shape for a raw
 * GenAI response body. Both shapes are verified against source, not against a
 * live run — no authenticated gemini invocation has ever exercised this path.
 */
export function parseGeminiOutput(stdout: string): GeminiParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    // Not JSON — treat the raw output as plain text rather than failing.
    return { text: stdout.trim(), tokensUsed: 0 };
  }

  if (typeof parsed !== "object" || parsed === null) {
    return { text: stdout.trim(), tokensUsed: 0 };
  }

  const record = parsed as {
    response?: unknown;
    result?: unknown;
    text?: unknown;
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    stats?: {
      models?: Record<string, GeminiModelStats> | null;
    } | null;
    usageMetadata?: { totalTokenCount?: number | null } | null;
    error?: { type?: string; message?: string; code?: string } | null;
  };

  // The CLI reports failures as an `error` object with no `response`. Surfacing
  // that as empty text would persist a silent, successful-looking empty run.
  if (record.error) {
    const detail = record.error.message ?? record.error.type ?? "unknown error";
    throw new Error(`gemini returned an error: ${detail}`);
  }

  const text =
    typeof record.response === "string"
      ? record.response
      : typeof record.result === "string"
        ? record.result
        : typeof record.text === "string"
          ? record.text
          : (record.candidates?.[0]?.content?.parts?.[0]?.text ?? "");

  let tokensUsed = 0;
  const models = record.stats?.models;
  if (models && typeof models === "object") {
    for (const model of Object.values(models)) {
      const total = model?.tokens?.total;
      if (typeof total === "number" && Number.isFinite(total) && total > 0) {
        tokensUsed += total;
      }
    }
  }
  if (tokensUsed === 0) {
    const fallback = record.usageMetadata?.totalTokenCount;
    if (
      typeof fallback === "number" &&
      Number.isFinite(fallback) &&
      fallback > 0
    ) {
      tokensUsed = fallback;
    }
  }

  return { text, tokensUsed };
}

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

    const { text, tokensUsed } = parseGeminiOutput(stdout);

    return {
      text,
      agentUsed: "gemini",
      tokensUsed,
      durationMs: Date.now() - start,
    };
  }
}
