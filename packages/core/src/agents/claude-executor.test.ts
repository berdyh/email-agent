import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClaudeCliOutput } from "./claude-executor.js";

describe("parseClaudeCliOutput", () => {
  it("parses the live `claude -p --output-format json` shape", () => {
    // Trimmed from an actual CLI run whose whole answer was the word "pong".
    const stdout = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "pong",
      session_id: "abc",
      total_cost_usd: 0.0123,
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 13901,
        cache_read_input_tokens: 15242,
        output_tokens: 4,
        service_tier: "standard",
      },
    });

    const result = parseClaudeCliOutput(stdout);
    assert.equal(result.text, "pong");
    // All input (cache traffic included) plus all output.
    assert.equal(result.tokensUsed, 29149);
  });

  it("no longer reports output_tokens alone", () => {
    const stdout = JSON.stringify({
      result: "pong",
      usage: {
        input_tokens: 2,
        cache_creation_input_tokens: 13901,
        cache_read_input_tokens: 15242,
        output_tokens: 4,
      },
    });
    assert.notEqual(parseClaudeCliOutput(stdout).tokensUsed, 4);
  });

  it("falls back to the `text` field when `result` is absent", () => {
    const stdout = JSON.stringify({
      text: "hello",
      usage: { input_tokens: 5, output_tokens: 3 },
    });
    const result = parseClaudeCliOutput(stdout);
    assert.equal(result.text, "hello");
    assert.equal(result.tokensUsed, 8);
  });

  it("returns raw stdout with zero tokens when the output is not JSON", () => {
    const result = parseClaudeCliOutput("just plain text");
    assert.equal(result.text, "just plain text");
    assert.equal(result.tokensUsed, 0);
  });

  it("reports zero tokens when usage is missing entirely", () => {
    const stdout = JSON.stringify({ result: "hi" });
    const result = parseClaudeCliOutput(stdout);
    assert.equal(result.text, "hi");
    assert.equal(result.tokensUsed, 0);
  });

  it("does not treat a JSON scalar as a result object", () => {
    const result = parseClaudeCliOutput("42");
    assert.equal(result.text, "42");
    assert.equal(result.tokensUsed, 0);
  });
});
