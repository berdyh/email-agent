// Crash-recoverable schema migration for the `pending_operations` table.
//
// Why this table gets special treatment: its `applied`/`rejected` rows are the
// audit trail of Gmail mutations that really happened. `emails` can be
// re-fetched; these cannot be reconstructed from anything.
//
// LanceDB has no ALTER TABLE, so adding a column is read → drop → create →
// re-insert. Written naively that sequence loses everything on a crash, a full
// disk or a failing `add()` after the drop — and silently, because the retry
// sees a fresh table already at the current schema and concludes there was
// nothing to migrate. Here the projected rows are written to a durable backup
// file BEFORE the drop, and the backup is deleted only after the re-insert is
// read back and verified. A leftover backup on startup is therefore proof of
// an interrupted migration, and recovery replays it instead of proceeding as
// if the table were simply new.

import type { Connection } from "@lancedb/lancedb";
import { Schema, Field, Utf8 } from "apache-arrow";
import { pendingOperationsTable } from "./schema.js";
import { missingColumns, projectRowsToSchema } from "./migrations.js";
import { withMigrationLock } from "./migration-lock.js";
import {
  deleteTableBackup,
  mergeRowsById,
  readTableBackup,
  tableBackupExists,
  writeTableBackup,
  type TableBackup,
} from "./table-backup.js";

export const pendingOperationSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("batchId", new Utf8()),
  new Field("actionId", new Utf8()),
  new Field("actionName", new Utf8()),
  new Field("accountId", new Utf8()),
  new Field("emailId", new Utf8()),
  new Field("type", new Utf8()),
  new Field("labelIds", new Utf8()),
  new Field("status", new Utf8()),
  new Field("error", new Utf8()),
  new Field("claimToken", new Utf8()),
  new Field("createdAt", new Utf8()),
  new Field("claimedAt", new Utf8()),
  new Field("resolvedAt", new Utf8()),
]);

/**
 * Values for columns a legacy table predates. Every column is Utf8 and "" is
 * the schema's documented "unset" sentinel, so a migrated row lands in exactly
 * the state a fresh enqueue would produce — queued rows come back queued and
 * unclaimed, never silently approved.
 */
export const pendingOperationMigrationDefaults: Record<string, unknown> = {
  claimToken: "",
  claimedAt: "",
  resolvedAt: "",
  error: "",
  labelIds: "[]",
  accountId: "",
};

const requiredColumns = pendingOperationSchema.fields.map(
  (field: { name: string }) => field.name,
);

type TableState =
  | { kind: "absent" }
  | { kind: "current" }
  | { kind: "stale"; absentColumns: string[] };

async function inspectTable(conn: Connection): Promise<TableState> {
  const names = await conn.tableNames();
  if (!names.includes(pendingOperationsTable)) return { kind: "absent" };

  const table = await conn.openTable(pendingOperationsTable);
  const existing = await table.schema();
  const absentColumns = missingColumns(
    existing.fields.map((field: { name: string }) => field.name),
    requiredColumns,
  );
  return absentColumns.length === 0
    ? { kind: "current" }
    : { kind: "stale", absentColumns };
}

async function readAllRows(
  conn: Connection,
): Promise<Array<Record<string, unknown>>> {
  const table = await conn.openTable(pendingOperationsTable);
  return (await table.query().toArray()) as unknown as Array<
    Record<string, unknown>
  >;
}

/**
 * Recreates the table from `rows` and verifies the insert before returning.
 *
 * The count check is not ceremony: it is the condition under which the caller
 * is allowed to delete the backup. If `add()` half-succeeded or silently wrote
 * nothing, throwing here leaves the backup on disk and the next start recovers
 * from it, instead of the loss becoming permanent the moment the backup goes.
 */
async function recreateWithRows(
  conn: Connection,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<void> {
  const names = await conn.tableNames();
  if (names.includes(pendingOperationsTable)) {
    await conn.dropTable(pendingOperationsTable);
  }
  const table = await conn.createEmptyTable(
    pendingOperationsTable,
    pendingOperationSchema,
  );
  if (rows.length > 0) {
    await table.add(rows as Array<Record<string, unknown>>);
  }

  const written = await table.countRows();
  if (written !== rows.length) {
    throw new Error(
      `Migration of ${pendingOperationsTable} re-inserted ${written} of ${rows.length} rows. The backup has been kept; re-run to retry recovery.`,
    );
  }
}

/**
 * Replays an interrupted migration from its backup.
 *
 * Correct for every point the previous attempt could have died at — table
 * untouched, table dropped, table recreated empty, table recreated and
 * refilled — because it merges rather than replaces. Rows the table currently
 * holds win over their backup copies (a concurrent process may have resolved
 * one since the snapshot), and rows only the backup has are restored. Both
 * sides are re-projected onto the *current* schema, so a backup written by an
 * older build that was then upgraded again still lands correctly.
 */
export async function recoverFromBackup(
  conn: Connection,
  backup: TableBackup,
  backupDir: string,
): Promise<number> {
  const names = await conn.tableNames();
  const currentRows = names.includes(pendingOperationsTable)
    ? await readAllRows(conn)
    : [];

  const merged = mergeRowsById(
    projectRowsToSchema(
      backup.rows,
      requiredColumns,
      pendingOperationMigrationDefaults,
    ),
    projectRowsToSchema(
      currentRows,
      requiredColumns,
      pendingOperationMigrationDefaults,
    ),
  );

  console.warn(
    `Recovering ${pendingOperationsTable}: a previous migration was interrupted (backup taken ${backup.createdAt || "at an unrecorded time"}). Restoring ${merged.length} row(s) — ${backup.rows.length} from the backup, merged with ${currentRows.length} currently in the table.`,
  );

  await recreateWithRows(conn, merged);
  // Only now. Deleting earlier would make a failure between drop and insert
  // permanent, which is the exact bug this whole path exists to remove.
  await deleteTableBackup(backupDir, pendingOperationsTable);
  return merged.length;
}

async function migrate(
  conn: Connection,
  absentColumns: string[],
  backupDir: string,
): Promise<void> {
  console.warn(
    `Migrating ${pendingOperationsTable} table: adding column(s) ${absentColumns.join(", ")}. Every existing row — including the applied/rejected audit trail — is snapshotted to a backup file first and restored after the table is recreated; queued rows stay queued and unclaimed. If this process dies mid-migration the backup is left in place and the next start replays it.`,
  );

  const preserved = projectRowsToSchema(
    await readAllRows(conn),
    requiredColumns,
    pendingOperationMigrationDefaults,
  );

  // DURABLE SNAPSHOT BEFORE THE DROP. Everything after this point is
  // recoverable; nothing before it needed to be.
  await writeTableBackup(backupDir, pendingOperationsTable, preserved);
  await recreateWithRows(conn, preserved);
  await deleteTableBackup(backupDir, pendingOperationsTable);
}

/**
 * Brings `pending_operations` to the current schema, recovering first if a
 * previous migration was interrupted.
 *
 * The common case — no leftover backup, table already current — takes no lock
 * and costs one `tableNames()` + one `schema()` + one `stat()`. Anything that
 * writes takes the cross-process migration lock and then RE-CHECKS, because
 * another process may have completed the work while this one waited.
 */
export async function ensurePendingOperationsTable(
  conn: Connection,
  backupDir: string,
  lockOptions?: { waitMs?: number; staleAfterMs?: number },
): Promise<void> {
  if (!(await tableBackupExists(backupDir, pendingOperationsTable))) {
    const state = await inspectTable(conn);
    if (state.kind === "current") return;
  }

  await withMigrationLock(
    backupDir,
    pendingOperationsTable,
    async () => {
      const backup = await readTableBackup(backupDir, pendingOperationsTable);
      if (backup !== null) {
        await recoverFromBackup(conn, backup, backupDir);
        return;
      }

      const state = await inspectTable(conn);
      if (state.kind === "current") return;
      if (state.kind === "absent") {
        await conn.createEmptyTable(
          pendingOperationsTable,
          pendingOperationSchema,
        );
        return;
      }
      await migrate(conn, state.absentColumns, backupDir);
    },
    lockOptions,
  );
}
