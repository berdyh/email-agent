/**
 * Test-only fixtures. NOT part of the product surface: this barrel is not
 * re-exported from `src/index.ts` and not listed in the package `exports` map,
 * so only test files (which reach it by relative path, or through the web
 * package's tsconfig `paths` alias) can import it.
 */
export * from "./lancedb-fixture.js";
