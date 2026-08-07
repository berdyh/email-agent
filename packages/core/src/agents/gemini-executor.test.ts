import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseGeminiOutput } from "./gemini-executor.js";

/**
 * The gemini CLI on this machine is installed but unauthenticated (it demands
 * an interactive browser OAuth flow), so no live run has ever exercised the
 * execute path. These fixtures are built from the shapes read out of the
 * installed `@google/gemini-cli` 0.54.0 package itself — its `JsonFormatter`,
 * its `uiTelemetry` metrics initialiser, and its shipped `docs/cli/headless.md`
 * — not from a live invocation. See TODOS.md for what that does and does not
 * establish.
 */
describe("parseGeminiOutput", () => {
  it("reads tokens from stats.models[*].tokens.total", () => {
    const stdout = JSON.stringify({
      session_id: "s1",
      response: "pong",
      stats: {
        models: {
          "gemini-2.5-pro": {
            api: { totalRequests: 1, totalErrors: 0, totalLatencyMs: 900 },
            tokens: {
              input: 12,
              prompt: 12,
              candidates: 5,
              total: 17,
              cached: 0,
              thoughts: 0,
              tool: 0,
            },
            roles: {},
          },
        },
        tools: { totalCalls: 0 },
      },
    });

    const result = parseGeminiOutput(stdout);
    assert.equal(result.text, "pong");
    assert.equal(result.tokensUsed, 17);
  });

  it("sums totals across models when a session touches more than one", () => {
    const stdout = JSON.stringify({
      response: "ok",
      stats: {
        models: {
          "gemini-2.5-pro": { tokens: { total: 100 } },
          "gemini-2.5-flash": { tokens: { total: 40 } },
        },
      },
    });
    assert.equal(parseGeminiOutput(stdout).tokensUsed, 140);
  });

  it("does not read the nonexistent stats.totalTokenCount field", () => {
    // Regression guard: the previous parser read `stats.totalTokenCount`, which
    // the CLI never emits, so every gemini run recorded 0 tokens. A fixture
    // carrying ONLY that camelCase field must still yield 0 — and the real
    // snake_case shape above must yield a real number.
    const stdout = JSON.stringify({
      response: "pong",
      stats: { totalTokenCount: 999 },
    });
    assert.equal(parseGeminiOutput(stdout).tokensUsed, 0);
  });

  it("falls back to a raw usageMetadata.totalTokenCount body", () => {
    const stdout = JSON.stringify({
      candidates: [{ content: { parts: [{ text: "hi" }] } }],
      usageMetadata: { totalTokenCount: 55 },
    });
    const result = parseGeminiOutput(stdout);
    assert.equal(result.text, "hi");
    assert.equal(result.tokensUsed, 55);
  });

  it("throws on the CLI's error envelope instead of returning empty text", () => {
    // JsonFormatter.formatError() emits `error` with no `response`; returning
    // "" here would persist a failed run as a successful empty answer.
    const stdout = JSON.stringify({
      session_id: "s1",
      error: { type: "ApiError", message: "quota exceeded", code: "429" },
    });
    assert.throws(() => parseGeminiOutput(stdout), /quota exceeded/);
  });

  it("treats non-JSON output as plain text", () => {
    const result = parseGeminiOutput("  plain answer  ");
    assert.equal(result.text, "plain answer");
    assert.equal(result.tokensUsed, 0);
  });

  it("returns empty text and zero tokens when stats are absent", () => {
    const result = parseGeminiOutput(JSON.stringify({ response: "hey" }));
    assert.equal(result.text, "hey");
    assert.equal(result.tokensUsed, 0);
  });
});
