import { execFile as execFileCb } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { AgentExecutor, AgentRequest, AgentResult } from "./types.js";

const execFile = promisify(execFileCb);

/**
 * Where the gemini CLI looks for credentials.
 *
 * READ OUT OF THE INSTALLED PACKAGE, `@google/gemini-cli` 0.54.4 (2026-08-07),
 * not from documentation:
 *   - `getApiKeyFromEnv()` reads `GOOGLE_API_KEY` then `GEMINI_API_KEY`.
 *   - `fetchCachedCredentialsList()` reads `Storage.getOAuthCredsPath()` —
 *     `<homedir>/.gemini/oauth_creds.json` (`GEMINI_DIR` + `OAUTH_FILE`) — and
 *     `GOOGLE_APPLICATION_CREDENTIALS`. When
 *     `GEMINI_FORCE_ENCRYPTED_FILE_STORAGE=true` the cached credentials live in
 *     the OS keychain instead, which nothing here can inspect.
 *   - Vertex mode is `GOOGLE_GENAI_USE_VERTEXAI` with `GOOGLE_CLOUD_PROJECT`.
 *
 * WHAT A HIT MEANS, exactly: "credential material is present". NOT "the
 * credentials are valid" — an expired refresh token, a revoked key and a
 * mistyped project all look identical from here, and only a real call can tell.
 * That is a strictly better answer than the old probe, which reported gemini
 * usable on the strength of the CLI being INSTALLED. It is deliberately
 * generous at the edges (the keychain and Vertex cases are believed rather than
 * inspected) because a false negative silently drops a usable agent, while a
 * false positive now costs one fast, clearly-worded failure instead of a 120s
 * hang.
 */
export interface GeminiCredentialProbe {
  env?: NodeJS.ProcessEnv;
  home?: string;
  fileExists?: (path: string) => boolean;
}

export function geminiCredentialSource(
  probe: GeminiCredentialProbe = {},
): string | null {
  const env = probe.env ?? process.env;
  const home = probe.home ?? homedir();
  const exists = probe.fileExists ?? existsSync;

  const nonEmpty = (name: string): boolean => (env[name] ?? "").trim().length > 0;

  if (nonEmpty("GOOGLE_API_KEY")) return "GOOGLE_API_KEY";
  if (nonEmpty("GEMINI_API_KEY")) return "GEMINI_API_KEY";
  if (nonEmpty("GOOGLE_APPLICATION_CREDENTIALS")) {
    return "GOOGLE_APPLICATION_CREDENTIALS";
  }
  // Vertex mode authenticates through ADC rather than a gemini-specific file.
  if (
    (env["GOOGLE_GENAI_USE_VERTEXAI"] ?? "").trim().toLowerCase() === "true" &&
    nonEmpty("GOOGLE_CLOUD_PROJECT")
  ) {
    return "Vertex AI (GOOGLE_CLOUD_PROJECT)";
  }
  // The keychain path: the file will not be there, and we cannot look inside
  // the keychain, so treat the opt-in as the evidence.
  if ((env["GEMINI_FORCE_ENCRYPTED_FILE_STORAGE"] ?? "").trim() === "true") {
    return "encrypted credential storage";
  }
  if (exists(join(home, ".gemini", "oauth_creds.json"))) {
    return "~/.gemini/oauth_creds.json";
  }
  return null;
}

/**
 * The message a run gets when the CLI is installed but cannot authenticate.
 *
 * `NO_BROWSER=1` turns that case from a 120s hang into a 2s failure carrying
 * gemini's own `FatalAuthenticationError` (observed live, 2026-08-07: exit code
 * 41, ~2s). This translates it into something that names the fix, because the
 * CLI's own wording tells the user to run it interactively — which is not
 * something this process can do on their behalf.
 */
export function describeGeminiAuthFailure(detail: string): string {
  return (
    `gemini is installed but not authenticated, so this run could not start. ` +
    `Run \`gemini\` once in a terminal and complete the sign-in, or set ` +
    `GEMINI_API_KEY (or GOOGLE_API_KEY). Original error: ${detail}`
  );
}

/** Recognises gemini's non-interactive auth refusal in whatever it wrote. */
export function isGeminiAuthFailure(text: string): boolean {
  return (
    /FatalAuthenticationError/.test(text) ||
    /Manual authorization is required/.test(text) ||
    /Please select a different authentication method/.test(text)
  );
}

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

  /**
   * "Can this run a prompt?", not "is the binary there?".
   *
   * The old version answered `--version`, so on a machine with the CLI
   * installed and unauthenticated it returned TRUE. `AgentRouter` then selected
   * gemini as a fallback, the CLI opened an interactive browser OAuth prompt
   * and blocked until the 120s `execFile` timeout killed it: one dead agent run
   * per attempt, surfacing as a timeout rather than a usable error. That is the
   * default state of a fresh install, so it is the common case rather than an
   * edge one.
   *
   * Presence AND credential material are now both required. It still cannot
   * prove the credentials WORK — see `geminiCredentialSource` — but "installed
   * and never signed in" is the case that was costing two minutes, and it is
   * decidable without a call.
   *
   * The presence probe also gained a timeout. It had none, so an `npx` that
   * hung took the whole run with it before the executor was even chosen.
   */
  async isAvailable(): Promise<boolean> {
    if (geminiCredentialSource() === null) return false;
    try {
      // `--no-install` so probing availability never triggers an npx auto-install
      // of the CLI from the registry.
      await execFile("npx", ["--no-install", "@google/gemini-cli", "--version"], {
        timeout: 15_000,
      });
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

    let stdout: string;
    try {
      ({ stdout } = await execFile("npx", args, {
        timeout: 120_000,
        maxBuffer: 10 * 1024 * 1024,
        signal: request.signal,
        // NEVER LET IT OPEN A BROWSER. `noBrowser: !!process.env["NO_BROWSER"]`
        // in the installed CLI (0.54.4), and with it set an unauthenticated
        // non-interactive run fails in about two seconds with
        // `FatalAuthenticationError` (exit 41) instead of blocking on a consent
        // screen nobody is watching until the 120s timeout. Verified live,
        // 2026-08-07. Without it, `shouldAttemptBrowserLaunch()` returns true on
        // any Linux desktop with `DISPLAY` set, which is the machine this runs on.
        env: { ...process.env, NO_BROWSER: "1" },
      }));
    } catch (err) {
      // execFile surfaces the child's stderr on the error object.
      const detail =
        typeof (err as { stderr?: unknown }).stderr === "string"
          ? ((err as { stderr: string }).stderr.trim() ||
            (err instanceof Error ? err.message : String(err)))
          : err instanceof Error
            ? err.message
            : String(err);
      if (isGeminiAuthFailure(detail)) {
        throw new Error(describeGeminiAuthFailure(detail));
      }
      throw err;
    }

    const { text, tokensUsed } = parseGeminiOutput(stdout);

    return {
      text,
      agentUsed: "gemini",
      tokensUsed,
      durationMs: Date.now() - start,
    };
  }
}
