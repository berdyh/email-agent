export const VECTOR_DIMENSION = 768;

export function createZeroVector(): number[] {
  return Array(VECTOR_DIMENSION).fill(0) as number[];
}
