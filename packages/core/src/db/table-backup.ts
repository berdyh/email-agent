// Durable snapshots for LanceDB drop-and-recreate migrations.
//
// LanceDB has no ALTER TABLE, so adding a column means read → drop → create →
// re-insert. That sequence has no atomicity of its own: a crash, a full disk or
// a failing `add()` AFTER the drop destroys every row, and — worse — a retry
// then sees a fresh table already at the current schema and skips recovery, so
// the loss is silent AND unrecoverable. For `pending_operations` those rows are
// the audit trail of Gmail mutations that really happened; nothing can
// reconstruct them.
//
// The fix is a write-ahead snapshot on disk: persist the projected rows
// durably BEFORE the drop, and delete the snapshot only once the re-insert is
// confirmed. A leftover snapshot on startup is therefore proof that a
// migration was interrupted, and is what recovery replays.

import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";

export interface TableBackup {
  /** Table the snapshot was taken from. */
  table: string;
  /** When the snapshot was written (ISO-8601). */
  createdAt: string;
  /** Rows as projected onto the schema the migration was targeting. */
  rows: Array<Record<string, unknown>>;
}

export function tableBackupPath(dir: string, table: string): string {
  return join(dir, `${table}.migration-backup.json`);
}

/** fsync a directory entry so a rename is durable. Best-effort: some platforms refuse to open a directory. */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Not fatal — the file itself was already fsynced.
  }
}

/**
 * Writes a snapshot durably: temp file → fsync → atomic rename → fsync dir.
 *
 * Every step matters. Writing in place would leave a truncated snapshot if the
 * process died mid-write, which is worse than none — recovery would restore a
 * partial audit trail while believing it restored everything. `rename` within
 * one directory is atomic, so the snapshot either exists complete or does not
 * exist at all. Resolves once the bytes are guaranteed to survive a power loss,
 * which is the whole point of calling this before a `dropTable`.
 */
export async function writeTableBackup(
  dir: string,
  table: string,
  rows: ReadonlyArray<Record<string, unknown>>,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const finalPath = tableBackupPath(dir, table);
  const tempPath = `${finalPath}.tmp`;
  const payload: TableBackup = {
    table,
    createdAt: new Date().toISOString(),
    rows: rows as Array<Record<string, unknown>>,
  };

  const handle = await open(tempPath, "w");
  try {
    await handle.writeFile(JSON.stringify(payload), "utf-8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(tempPath, finalPath);
  await syncDirectory(dir);
  return finalPath;
}

/** True when a migration snapshot is sitting on disk — i.e. one was interrupted. */
export async function tableBackupExists(
  dir: string,
  table: string,
): Promise<boolean> {
  try {
    await stat(tableBackupPath(dir, table));
    return true;
  } catch {
    return false;
  }
}

/**
 * Reads a leftover snapshot, or null when there is none.
 *
 * Throws on a snapshot that exists but cannot be parsed. That is deliberate:
 * the alternative is to treat unreadable evidence of an interrupted migration
 * as "no interruption happened" and carry on over the top of it, which is the
 * silent-loss behaviour this module exists to remove. A loud failure leaves the
 * file in place for a human.
 */
export async function readTableBackup(
  dir: string,
  table: string,
): Promise<TableBackup | null> {
  const path = tableBackupPath(dir, table);
  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Migration backup at ${path} is unreadable (${message}). It is the only copy of interrupted-migration rows — do not delete it; move it aside only after recovering its contents.`,
    );
  }

  const record = parsed as Partial<TableBackup> | null;
  if (!record || typeof record !== "object" || !Array.isArray(record.rows)) {
    throw new Error(
      `Migration backup at ${path} has no "rows" array. It is the only copy of interrupted-migration rows — do not delete it.`,
    );
  }

  return {
    table: typeof record.table === "string" ? record.table : table,
    createdAt: typeof record.createdAt === "string" ? record.createdAt : "",
    rows: record.rows as Array<Record<string, unknown>>,
  };
}

/** Retires a snapshot. Only ever called after the re-insert has been verified. */
export async function deleteTableBackup(
  dir: string,
  table: string,
): Promise<void> {
  await rm(tableBackupPath(dir, table), { force: true });
  await syncDirectory(dir);
}

/**
 * Unions snapshot rows with whatever the table currently holds, keyed on `id`.
 *
 * Recovery cannot know where the interrupted migration died, so it must be
 * correct for every stopping point: table untouched, table gone, table
 * recreated empty, table recreated and refilled. A plain "restore the
 * snapshot" is wrong for the last case — a concurrent process may have
 * resolved or enqueued a row after the snapshot was taken, and replacing the
 * table wholesale would erase that write.
 *
 * On-disk rows win ties, because they are by construction at least as new as
 * the snapshot: the snapshot is a point-in-time copy, and any row that also
 * exists in the table either equals it or has been updated since.
 */
export function mergeRowsById(
  backupRows: ReadonlyArray<Record<string, unknown>>,
  currentRows: ReadonlyArray<Record<string, unknown>>,
): Array<Record<string, unknown>> {
  const merged = new Map<string, Record<string, unknown>>();
  for (const row of backupRows) {
    merged.set(String(row["id"]), row);
  }
  for (const row of currentRows) {
    merged.set(String(row["id"]), row);
  }
  return [...merged.values()];
}
