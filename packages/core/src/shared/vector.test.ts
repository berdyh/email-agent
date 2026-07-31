import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  VECTOR_DIMENSION,
  createEmptyVector,
  createLocalEmbeddingVector,
} from "./vector.js";

describe("local embedding vectors", () => {
  it("creates deterministic normalized vectors for text", () => {
    const first = createLocalEmbeddingVector("Invoice payment reminder", 32);
    const second = createLocalEmbeddingVector("Invoice payment reminder", 32);

    assert.deepEqual(first, second);
    assert.equal(first.length, 32);
    assert.equal(first.some((value) => value !== 0), true);
    assert.ok(Math.abs(Math.hypot(...first) - 1) < 0.000001);
  });

  it("creates empty vectors for empty text", () => {
    assert.deepEqual(createLocalEmbeddingVector("", 4), createEmptyVector(4));
    assert.equal(createEmptyVector().length, VECTOR_DIMENSION);
  });
});
