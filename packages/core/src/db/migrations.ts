// In-place schema migrations for LanceDB tables.
//
// LanceDB DOES have schema evolution. Verified 2026-08-07 against the installed
// `@lancedb/lancedb` 0.15.0 (native `lance` 0.22.0), by running it on a real
// temp-directory table, not by reading docs:
//
//   * `Table.addColumns([{ name, valueSql }])` adds a column IN PLACE. Every
//     existing row survives, keeps its values, and immediately accepts
//     `update()` and `where()` on the new column (backticked, per the camelCase
//     rule in this module's card).
//   * The resulting Arrow type is exactly the one the CAST names:
//     `CAST('' AS STRING)` -> Utf8, `CAST(0 AS INT)` -> Int32,
//     `CAST(false AS BOOLEAN)` -> Bool, each with the same `nullable` flag a
//     fresh `createEmptyTable` of the target schema produces.
//   * Two processes calling `addColumns` for the same column concurrently:
//     one commits, the other fails loudly with "Column <name> already exists in
//     the dataset". Observed over 5 runs; every row survived in every
//     interleaving. `ensureTableColumns` re-probes on failure so the loser
//     treats the winner's commit as success rather than guessing.
//   * `addColumns` APPENDS. A migrated table's column ORDER therefore differs
//     from a fresh `createEmptyTable` of the same schema — the added columns
//     land at the end, not at their declared position. Nothing depends on
//     order (LanceDB matches `add()` fields and filter identifiers by name),
//     but do not assert order equality between a migrated and a fresh table.
//   * A `FixedSizeList` vector column can NOT be produced this way —
//     `CAST(NULL AS FLOAT)` yields a scalar Float. No table here needs one
//     added after the fact; if that changes, re-verify before assuming.
//   * `tableNames()` AND `openTable()` DISAGREE DURING A CONCURRENT CREATE.
//     `tableNames()` enumerates the on-disk `*.lance` directories; a table's
//     directory exists before its `_versions/1.manifest` is committed, so a
//     name is LISTED for a sub-millisecond window in which `openTable()` still
//     rejects it — with `Table 'X' was not found`, byte-identical to the error
//     for a name that was never created at all. Verified by racing two
//     connections over one directory: 3 of 30 trials caught the window, and
//     `mkdir X.lance` with no manifest reproduces it with no timing at all
//     (listed, unopenable, same message). Measured window 0.31-0.47ms,
//     converging on the SECOND `openTable` in 6 of 6 observations; two
//     concurrent `createEmptyTable` calls never both succeed (40 of 40: one
//     gets "Table 'X' already exists"), so both race directions funnel into
//     this same open. Only `openTable` is affected — once a handle is in hand,
//     `schema()` and `countRows()` never failed (0 of 120). `openCommitted`
//     below is the whole response: retry ONLY while the name is still listed,
//     which is what separates "another process is mid-create" from "this table
//     is not there".
//
// This replaces a read -> drop -> create -> re-insert sequence that these
// migrations used to run, adopted from a comment asserting "LanceDB has no
// ALTER TABLE". That assertion was false for the installed version, and the
// sequence it forced could destroy every row on a crash after the drop — which
// is what the (now deleted) durable-snapshot, cross-process-lock and
// replay-merge subsystem existed to survive. Nothing is dropped here, so there
// is nothing for a crash to destroy: `addColumns` is a single MVCC commit that
// either lands or does not.
//
// IF YOU UPGRADE `@lancedb/lancedb`, re-check all six facts above. They are
// facts about a version, not about LanceDB in general.

import type { Connection, Table } from "@lancedb/lancedb";
import type { Schema } from "apache-arrow";

/**
 * Column names present in the target schema but missing from the table on
 * disk. A non-empty result is the signal to add those columns.
 */
export function missingColumns(
  existing: readonly string[],
  required: readonly string[],
): string[] {
  const present = new Set(existing);
  return required.filter((name) => !present.has(name));
}

/** One column to add, and the SQL expression that fills it for every row. */
export interface ColumnAddition {
  name: string;
  valueSql: string;
}

/**
 * Pairs each absent column with the SQL for its unset sentinel.
 *
 * A column with no declared default THROWS rather than being filled with NULL.
 * These tables hold audit rows describing Gmail mutations that really happened;
 * guessing a value for one is worse than refusing to migrate, and a NULL in a
 * non-nullable Arrow column fails later with a message that names neither the
 * table nor the migration. The set of columns that legitimately have a default
 * is exactly the set added after the table shipped — a table missing `id` or
 * `status` is not a legacy shape, it is a table we do not recognise.
 *
 * Pure, so the refusal rule is testable without a database.
 */
export function buildColumnAdditions(
  absent: readonly string[],
  defaultSql: Readonly<Record<string, string>>,
  tableName = "table",
): ColumnAddition[] {
  return absent.map((name) => {
    const valueSql = defaultSql[name];
    if (valueSql === undefined) {
      throw new Error(
        `Cannot migrate ${tableName}: column "${name}" is absent and has no migration default. Refusing to add it as NULL — add an explicit sentinel matching what a fresh insert writes, or migrate this table by hand.`,
      );
    }
    return { name, valueSql };
  });
}

/**
 * Backoff ladder for the visible-but-uncommitted window, in milliseconds.
 *
 * BOUNDED ON PURPOSE. The measured window is under half a millisecond and
 * closes on the second attempt (see the header), so this ~0.4s total is roughly
 * a thousandfold margin for a loaded machine — not an open-ended "keep trying
 * until it works", which would turn a genuinely half-written table directory
 * into a startup that hangs instead of one that reports.
 */
const COMMIT_VISIBILITY_BACKOFF_MS = [1, 2, 5, 10, 25, 50, 100, 200] as const;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** LanceDB reports both "mid-create" and "never existed" with this one message. */
function isTableNotFound(err: unknown): boolean {
  return err instanceof Error && /was not found/i.test(err.message);
}


/**
 * `conn.openTable`, but tolerant of a table another process is still committing.
 *
 * The distinction this function exists to make — and the only evidence
 * available to make it with, since the two cases share an error message — is
 * whether `tableNames()` still LISTS the name:
 *
 *   * listed, but not openable  -> a concurrent `createEmptyTable` has made the
 *     directory but not yet committed its manifest. TRANSIENT: retry.
 *   * not listed                -> the table is genuinely absent. The original
 *     error is rethrown IMMEDIATELY, unretried.
 *   * any error that is not "not found" -> not ours to interpret. Rethrown
 *     immediately, so a permissions or corruption failure surfaces as itself
 *     rather than as a timeout.
 *
 * Exhausting the ladder while the name is still listed is NOT treated as
 * success and not silently swallowed: a directory exists that no process is
 * committing, and it throws saying so.
 *
 * What that error must NOT do is guess WHY. An interrupted `createEmptyTable`
 * leaves an empty directory — but a table whose `_versions` manifests were lost
 * AFTER rows were written presents identically from here (listed, "was not
 * found") while its directory still holds those rows. `Connection` exposes no
 * path to tell them apart, so the message states both possibilities and tells
 * the user to look, rather than calling the directory empty and sending someone
 * to delete their own audit trail. It carries the original error as `cause`.
 */
async function openCommitted(
  conn: Connection,
  tableName: string,
): Promise<Table> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await conn.openTable(tableName);
    } catch (err) {
      if (!isTableNotFound(err)) throw err;
      if (!(await conn.tableNames()).includes(tableName)) throw err;

      const delay = COMMIT_VISIBILITY_BACKOFF_MS[attempt];
      if (delay === undefined) {
        const waited = COMMIT_VISIBILITY_BACKOFF_MS.reduce((a, b) => a + b, 0);
        throw new Error(
          `Table ${tableName} is listed by the database but still could not be opened after ${waited}ms, so no process is committing it. Nothing was dropped by this run. Inspect the ${tableName}.lance directory before removing it: an interrupted create leaves it empty and it is then safe to delete, but a table whose manifests were lost after rows were written looks identical from here and its data files are still inside.`,
          { cause: err },
        );
      }
      await sleep(delay);
    }
  }
}

async function columnNames(
  conn: Connection,
  tableName: string,
): Promise<string[]> {
  const table = await openCommitted(conn, tableName);
  const schema = await table.schema();
  return schema.fields.map((field: { name: string }) => field.name);
}

/**
 * Brings `tableName` to `schema`, creating it if absent and adding any missing
 * columns in place. Returns the columns that were added.
 *
 * NO ROW IS EVER DROPPED, MOVED OR RE-INSERTED. That is the whole point: the
 * `applied`/`rejected` rows in `pending_operations` and every row in
 * `action_results` record work that cannot be reconstructed, and a migration
 * that rewrites them is a migration that can lose them.
 *
 * Fails closed in both directions it can:
 *   * a missing column with no declared default throws (see
 *     `buildColumnAdditions`) instead of being invented;
 *   * an `addColumns` failure is re-probed against the table's *current*
 *     schema. Only if the columns are genuinely there — i.e. a concurrent
 *     process committed them first — is the failure swallowed. Otherwise it is
 *     rethrown with the table named. "The call failed" is never assumed to mean
 *     "somebody else did it".
 *   * every `openTable` goes through `openCommitted`, which retries a bounded
 *     number of times ONLY while the name is still listed. A table that is
 *     genuinely absent, or an error that is not "not found", is rethrown on the
 *     first attempt.
 *
 * The two race directions are therefore both survivable and both converge on
 * the winner's table rather than on a second copy of it: whichever caller sees
 * the name first skips the create, and whichever calls `createEmptyTable`
 * second gets "already exists" — and both then land on the same `openCommitted`
 * that waits out the winner's manifest.
 *
 * A row count taken before and after asserts rows did not disappear; it is
 * `after < before` rather than `!==` because a concurrent enqueue may
 * legitimately have added rows in between, and claiming to detect that would be
 * overclaiming.
 */
export async function ensureTableColumns(
  conn: Connection,
  tableName: string,
  schema: Schema,
  defaultSql: Readonly<Record<string, string>>,
): Promise<string[]> {
  if (!(await conn.tableNames()).includes(tableName)) {
    try {
      await conn.createEmptyTable(tableName, schema);
      return [];
    } catch (err) {
      // Two processes starting against a brand-new database both see the table
      // as absent and both create it; one gets "Table already exists". Re-probe
      // rather than assume — if it really is there now, fall through to the
      // column check below, which is exactly what the winner also ran.
      if (!(await conn.tableNames()).includes(tableName)) throw err;
      console.warn(
        `Another process created ${tableName} concurrently; using its table.`,
      );
    }
  }

  const required = schema.fields.map((field: { name: string }) => field.name);
  const absent = missingColumns(await columnNames(conn, tableName), required);
  if (absent.length === 0) return [];

  const additions = buildColumnAdditions(absent, defaultSql, tableName);
  const table = await openCommitted(conn, tableName);
  const before = await table.countRows();

  console.warn(
    `Migrating ${tableName}: adding column(s) ${absent.join(", ")} in place, each filled with the value a fresh insert writes. Every existing row is preserved — nothing is dropped, re-inserted or re-fetched.`,
  );

  try {
    await table.addColumns(additions);
  } catch (err) {
    const stillAbsent = missingColumns(
      await columnNames(conn, tableName),
      required,
    );
    if (stillAbsent.length > 0) {
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(
        `Failed to add column(s) ${stillAbsent.join(", ")} to ${tableName}: ${message}. No rows were dropped — the table is still at its previous schema and can be retried.`,
      );
    }
    // Another process committed the same columns first. Its commit is the
    // fact; ours was a duplicate.
    console.warn(
      `Another process migrated ${tableName} concurrently; using its result.`,
    );
    return absent;
  }

  const after = await (await openCommitted(conn, tableName)).countRows();
  if (after < before) {
    throw new Error(
      `Migrating ${tableName} left ${after} rows where ${before} were present before the column(s) ${absent.join(", ")} were added. This should be impossible for an in-place addColumns — do not run further migrations against this table until it is investigated.`,
    );
  }

  return absent;
}
