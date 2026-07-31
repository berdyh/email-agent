export const VECTOR_DIMENSION = 768;

const TOKEN_PATTERN = /[\p{L}\p{N}]+/gu;

function hashToken(token: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < token.length; i++) {
    hash ^= token.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function createEmptyVector(dimensions = VECTOR_DIMENSION): number[] {
  return Array(dimensions).fill(0) as number[];
}

export function createLocalEmbeddingVector(
  text: string,
  dimensions = VECTOR_DIMENSION,
): number[] {
  if (!Number.isInteger(dimensions) || dimensions < 1) {
    throw new Error("Vector dimensions must be a positive integer");
  }

  const vector = createEmptyVector(dimensions);
  const tokens = text.toLowerCase().match(TOKEN_PATTERN) ?? [];
  if (tokens.length === 0) return vector;

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    const hash = hashToken(token);
    const index = hash % dimensions;
    const sign = hash & 1 ? 1 : -1;
    vector[index]! += sign;

    const next = tokens[i + 1];
    if (next) {
      const bigramHash = hashToken(`${token} ${next}`);
      const bigramIndex = bigramHash % dimensions;
      const bigramSign = bigramHash & 1 ? 1 : -1;
      vector[bigramIndex]! += bigramSign * 0.5;
    }
  }

  const magnitude = Math.hypot(...vector);
  if (magnitude === 0) return vector;
  return vector.map((value) => value / magnitude);
}

export function createLocalEmbeddingVectors(
  texts: string[],
  dimensions = VECTOR_DIMENSION,
): number[][] {
  return texts.map((text) => createLocalEmbeddingVector(text, dimensions));
}
