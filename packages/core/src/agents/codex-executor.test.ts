import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCodexOutput } from "./codex-executor.js";

describe("parseCodexOutput", () => {
  it("parses the current item.completed / turn.completed shape", () => {
    const stdout = [
      JSON.stringify({ type: "session.created", session_id: "abc" }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Hello " },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "world" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: { input_tokens: 12, output_tokens: 8 },
      }),
    ].join("\n");

    const result = parseCodexOutput(stdout);
    assert.equal(result.text, "Hello world");
    assert.equal(result.tokensUsed, 20);
  });

  it("counts input+output on the real live usage shape, excluding cached", () => {
    // Recorded verbatim from `codex exec --json` (codex-cli 0.145.0); the whole
    // answer was the word "pong".
    const stdout = [
      JSON.stringify({ type: "thread.started", thread_id: "t1" }),
      JSON.stringify({ type: "turn.started" }),
      JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "pong" },
      }),
      JSON.stringify({
        type: "turn.completed",
        usage: {
          input_tokens: 21403,
          cached_input_tokens: 5888,
          cache_write_input_tokens: 0,
          output_tokens: 5,
          reasoning_output_tokens: 0,
        },
      }),
    ].join("\n");

    const result = parseCodexOutput(stdout);
    assert.equal(result.text, "pong");
    // input + output. cached_input_tokens is a subset of input_tokens —
    // verified by a live delta test — so adding it would double-count.
    assert.equal(result.tokensUsed, 21408);
    assert.notEqual(result.tokensUsed, 27296);
  });

  it("ignores non-agent item.completed events (e.g. reasoning)", () => {
    const stdout = [
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "thinking..." },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Final" },
      }),
    ].join("\n");

    const result = parseCodexOutput(stdout);
    assert.equal(result.text, "Final");
  });

  it("parses the legacy msg envelope shape", () => {
    const stdout = [
      JSON.stringify({
        msg: { type: "agent_message", message: "Legacy answer" },
      }),
      JSON.stringify({
        msg: {
          type: "token_count",
          info: { total_token_usage: { total_tokens: 42 } },
        },
      }),
    ].join("\n");

    const result = parseCodexOutput(stdout);
    assert.equal(result.text, "Legacy answer");
    assert.equal(result.tokensUsed, 42);
  });

  it("falls back to plain text when no JSON events parse", () => {
    const result = parseCodexOutput("just plain text\nmore text");
    assert.equal(result.text, "just plain textmore text");
    assert.equal(result.tokensUsed, 0);
  });

  it("never surfaces raw JSON noise when an agent_message is present", () => {
    const stdout = [
      "not json noise",
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: "Answer" },
      }),
    ].join("\n");

    const result = parseCodexOutput(stdout);
    assert.equal(result.text, "Answer");
  });

  it("returns empty text and zero tokens for empty output", () => {
    const result = parseCodexOutput("");
    assert.equal(result.text, "");
    assert.equal(result.tokensUsed, 0);
  });
});
