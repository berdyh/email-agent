/** Escape single quotes for LanceDB `.where()` filter strings. */
export function escapeSql(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * The limit every unbounded scan must set explicitly.
 *
 * LANCEDB APPLIES A DEFAULT LIMIT OF 10 TO A PLAIN FILTERED QUERY. Verified on
 * a real temp-directory table against `@lancedb/lancedb` 0.15.0, 2026-08-07:
 * a table holding 25 rows answers `countRows()` with 25, and both
 * `query().toArray()` and `query().where("status = 'pending'").toArray()` with
 * TEN. It is not a vector-search-only default, which is what this codebase
 * previously asserted in a comment (`email-lookup.ts`) and never checked.
 *
 * What that silently did, before every scan here set a limit: the approval
 * queue showed at most 10 changes however many were queued, `approvals apply`
 * applied 10 of them, the stranded list could hide rows, the mail list capped
 * at 10 regardless of the caller's own `limit`, and the batched email lookup
 * resolved 10 emails and rendered the rest as "not in local DB". Nothing threw;
 * the eleventh row simply did not exist as far as the app was concerned.
 *
 * `limit(0)` is NOT "no limit" — it returns zero rows. The argument is a Rust
 * `u32`, so this is 2^31-1: comfortably below the type's ceiling and far above
 * any row count a local mailbox database reaches, while staying a number rather
 * than a sentinel that a future LanceDB version might reinterpret.
 *
 * Anything that means to read ALL matching rows must pass this. A query with a
 * caller-supplied page size passes that instead; a lookup of one row passes 1.
 */
export const UNLIMITED_QUERY_ROWS = 2_147_483_647;
