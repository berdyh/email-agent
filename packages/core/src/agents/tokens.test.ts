import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  anthropicTotalTokens,
  codexTotalTokens,
  openAiTotalTokens,
} from "./tokens.js";

/**
 * These tests pin the canonical definition of `tokensUsed`:
 *
 *     tokensUsed = all input tokens + all output tokens
 *
 * The per-provider maths differ because the providers disagree on whether
 * cached input is included in or additional to their `input_tokens` field.
 * Getting that backwards is the whole reason the column was incomparable, so
 * each direction is asserted explicitly below.
 */
describe("anthropicTotalTokens", () => {
  it("adds the cache fields — Anthropic's input_tokens is the uncached remainder", () => {
    // Recorded from a live `claude -p --output-format json` run whose entire
    // answer was the word "pong".
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 13901,
      cache_read_input_tokens: 15242,
      output_tokens: 4,
    };
    assert.equal(anthropicTotalTokens(usage), 29149);
  });

  it("does not regress to output-only accounting", () => {
    // The pre-fix executor recorded `usage.output_tokens` alone, reporting 4
    // for the run above. Guard the four-order-of-magnitude gap explicitly.
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 13901,
      cache_read_input_tokens: 15242,
      output_tokens: 4,
    };
    assert.notEqual(anthropicTotalTokens(usage), 4);
  });

  it("does not regress to input+output, ignoring cache traffic", () => {
    const usage = {
      input_tokens: 2,
      cache_creation_input_tokens: 13901,
      cache_read_input_tokens: 15242,
      output_tokens: 4,
    };
    assert.notEqual(anthropicTotalTokens(usage), 6);
  });

  it("handles an uncached turn where the cache fields are zero", () => {
    assert.equal(
      anthropicTotalTokens({
        input_tokens: 100,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
        output_tokens: 25,
      }),
      125,
    );
  });

  it("tolerates missing, null and absent fields", () => {
    assert.equal(anthropicTotalTokens(undefined), 0);
    assert.equal(anthropicTotalTokens(null), 0);
    assert.equal(anthropicTotalTokens({}), 0);
    assert.equal(
      anthropicTotalTokens({ input_tokens: 10, output_tokens: null }),
      10,
    );
  });
});

describe("codexTotalTokens", () => {
  it("treats cached_input_tokens as a SUBSET of input_tokens", () => {
    // Recorded from a live `codex exec --json` run (codex-cli 0.145.0) whose
    // entire answer was the word "pong".
    const usage = {
      input_tokens: 21403,
      cached_input_tokens: 5888,
      cache_write_input_tokens: 0,
      output_tokens: 5,
      reasoning_output_tokens: 0,
    };
    assert.equal(codexTotalTokens(usage), 21408);
  });

  it("does not double-count cached input (the old 27k-for-one-word figure)", () => {
    const usage = {
      input_tokens: 21403,
      cached_input_tokens: 5888,
      output_tokens: 5,
    };
    // 21403 + 5888 + 5 = 27296 — the shape of the misleading number that
    // motivated this investigation. It must not come back.
    assert.notEqual(codexTotalTokens(usage), 27296);
  });

  it("treats reasoning_output_tokens as a subset of output_tokens", () => {
    assert.equal(
      codexTotalTokens({
        input_tokens: 100,
        output_tokens: 50,
        reasoning_output_tokens: 30,
      }),
      150,
    );
  });

  it("tolerates missing and absent usage", () => {
    assert.equal(codexTotalTokens(undefined), 0);
    assert.equal(codexTotalTokens({}), 0);
  });
});

describe("openAiTotalTokens", () => {
  it("prefers the provider's total_tokens", () => {
    assert.equal(
      openAiTotalTokens({
        prompt_tokens: 10,
        completion_tokens: 5,
        total_tokens: 15,
      }),
      15,
    );
  });

  it("falls back to prompt + completion when total_tokens is absent", () => {
    assert.equal(
      openAiTotalTokens({ prompt_tokens: 10, completion_tokens: 5 }),
      15,
    );
  });

  it("reports total_tokens even when the components are missing", () => {
    assert.equal(openAiTotalTokens({ total_tokens: 42 }), 42);
  });

  it("tolerates missing and absent usage", () => {
    assert.equal(openAiTotalTokens(undefined), 0);
    assert.equal(openAiTotalTokens({}), 0);
  });
});
