// These tests run the REAL read → snapshot → drop → create → add sequence
// against a real LanceDB in a temp directory, including crashes partway
// through. The previous test for this migration mapped three in-memory objects
// through a pure projection helper and never executed the migration at all,
// which is not a test of a code path whose failure mode is the silent,
// irreversible loss of the user's entire approval audit trail.

import assert from "node:assert/strict";
import { connect, type Connection } from "@lancedb/lancedb";
import { Schema, Field, Utf8 } from "apache-arrow";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  ensurePendingOperationsTable,
  pendingOperationSchema,
} from "./pending-operations-migration.js";
import {
  mergeRowsById,
  tableBackupExists,
  tableBackupPath,
  writeTableBackup,
} from "./table-backup.js";
import { isLockStale, migrationLockPath, withMigrationLock } from "./migration-lock.js";
import { pendingOperationsTable } from "./schema.js";

/** The `pending_operations` shape before the claim/lease columns were added. */
const legacySchema = new Schema(
  pendingOperationSchema.fields.filter(
    (field: { name: string }) =>
      !["claimToken", "claimedAt", "resolvedAt"].includes(field.name),
  ),
);

function legacyRow(id: string, status: string): Record<string, unknown> {
  return {
    id,
    batchId: "batch-1",
    actionId: "junk",
    actionName: "Junk",
    accountId: "me@example.com",
    emailId: `msg-${id}`,
    type: "trash",
    labelIds: "[]",
    status,
    error: "",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

function currentRow(
  id: string,
  status: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...legacyRow(id, status),
    claimToken: "",
    claimedAt: "",
    resolvedAt: "",
    ...overrides,
  };
}

async function rowsInTable(
  conn: Connection,
): Promise<Array<Record<string, unknown>>> {
  const table = await conn.openTable(pendingOperationsTable);
  const rows = (await table.query().toArray()) as unknown as Array<
    Record<string, unknown>
  >;
  return rows.sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));
}

/**
 * A Connection that delegates to the real one but can observe or sabotage the
 * migration's own calls. This keeps the failure injection entirely in the test
 * — no test-only seam in production code — while still exercising the real
 * LanceDB operations either side of the injected fault.
 */
function instrument(
  conn: Connection,
  hooks: {
    onDrop?: (name: string) => void | Promise<void>;
    onCreate?: (name: string) => void | Promise<void>;
  },
): Connection {
  return {
    tableNames: (...args: never[]) => conn.tableNames(...args),
    openTable: (name: string, ...args: never[]) => conn.openTable(name, ...args),
    async dropTable(name: string) {
      await hooks.onDrop?.(name);
      return conn.dropTable(name);
    },
    async createEmptyTable(name: string, ...args: never[]) {
      await hooks.onCreate?.(name);
      return conn.createEmptyTable(name, ...(args as [never]));
    },
  } as unknown as Connection;
}

describe("pending_operations migration against a real LanceDB", () => {
  let dir = "";
  let dbDir = "";
  let backupDir = "";
  let conn: Connection;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "email-agent-migration-"));
    dbDir = join(dir, "lancedb");
    backupDir = join(dir, "migrations");
    conn = await connect(dbDir);
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the table when it does not exist yet", async () => {
    await ensurePendingOperationsTable(conn, backupDir);
    assert.deepEqual(await conn.tableNames(), [pendingOperationsTable]);
    assert.deepEqual(await rowsInTable(conn), []);
  });

  it("round-trips the audit trail through the real drop/recreate", async () => {
    const legacy = await conn.createEmptyTable(
      pendingOperationsTable,
      legacySchema,
    );
    await legacy.add([
      legacyRow("a", "applied"),
      legacyRow("b", "rejected"),
      legacyRow("c", "pending"),
      legacyRow("d", "failed"),
    ]);

    await ensurePendingOperationsTable(conn, backupDir);

    const rows = await rowsInTable(conn);
    assert.deepEqual(
      rows.map((row) => [row["id"], row["status"]]),
      [
        ["a", "applied"],
        ["b", "rejected"],
        ["c", "pending"],
        ["d", "failed"],
      ],
    );
    // New columns land on their documented unset sentinel, so a queued row
    // comes back exactly as a fresh enqueue writes it — nothing is silently
    // approved or claimed by the migration.
    for (const row of rows) {
      assert.equal(row["claimToken"], "");
      assert.equal(row["claimedAt"], "");
      assert.equal(row["resolvedAt"], "");
      assert.equal(row["accountId"], "me@example.com");
    }
    // The backup is retired only after the re-insert is verified.
    assert.equal(await tableBackupExists(backupDir, pendingOperationsTable), false);
  });

  it("is a no-op — and leaves no backup — for a table already at the current schema", async () => {
    const table = await conn.createEmptyTable(
      pendingOperationsTable,
      pendingOperationSchema,
    );
    await table.add([currentRow("a", "applied")]);

    await ensurePendingOperationsTable(conn, backupDir);

    assert.deepEqual(
      (await rowsInTable(conn)).map((row) => row["id"]),
      ["a"],
    );
    assert.equal(await tableBackupExists(backupDir, pendingOperationsTable), false);
    // The fast path must not even create the lock directory.
    await assert.rejects(stat(migrationLockPath(backupDir, pendingOperationsTable)));
  });

  it("writes the durable backup BEFORE dropping the table", async () => {
    const legacy = await conn.createEmptyTable(
      pendingOperationsTable,
      legacySchema,
    );
    await legacy.add([legacyRow("a", "applied")]);

    let backupPresentAtDrop: boolean | null = null;
    const watched = instrument(conn, {
      onDrop: async () => {
        backupPresentAtDrop = await tableBackupExists(
          backupDir,
          pendingOperationsTable,
        );
      },
    });

    await ensurePendingOperationsTable(watched, backupDir);
    assert.equal(
      backupPresentAtDrop,
      true,
      "the snapshot must be durable before the only copy of the rows is dropped",
    );
  });

  it("keeps the backup when the migration dies after the drop, and the next start recovers every row", async () => {
    const legacy = await conn.createEmptyTable(
      pendingOperationsTable,
      legacySchema,
    );
    await legacy.add([
      legacyRow("a", "applied"),
      legacyRow("b", "rejected"),
      legacyRow("c", "pending"),
    ]);

    // Crash at the worst possible moment: the table is gone and nothing has
    // been re-inserted. Before the backup existed this destroyed every row,
    // and a retry saw a fresh current-schema table and skipped recovery, so
    // the loss was both silent and permanent.
    const doomed = instrument(conn, {
      onCreate: () => {
        throw new Error("disk full");
      },
    });
    await assert.rejects(
      ensurePendingOperationsTable(doomed, backupDir),
      /disk full/,
    );

    assert.equal(await conn.tableNames().then((n) => n.includes(pendingOperationsTable)), false);
    assert.equal(
      await tableBackupExists(backupDir, pendingOperationsTable),
      true,
      "the backup must survive the failure — it is the only copy left",
    );

    // Next start.
    await ensurePendingOperationsTable(conn, backupDir);
    assert.deepEqual(
      (await rowsInTable(conn)).map((row) => [row["id"], row["status"]]),
      [
        ["a", "applied"],
        ["b", "rejected"],
        ["c", "pending"],
      ],
    );
    assert.equal(await tableBackupExists(backupDir, pendingOperationsTable), false);
  });

  it("recovers from a leftover backup when the crash left the old table untouched", async () => {
    const legacy = await conn.createEmptyTable(
      pendingOperationsTable,
      legacySchema,
    );
    await legacy.add([legacyRow("a", "applied")]);
    await writeTableBackup(backupDir, pendingOperationsTable, [
      currentRow("a", "applied"),
    ]);

    await ensurePendingOperationsTable(conn, backupDir);

    const rows = await rowsInTable(conn);
    assert.deepEqual(rows.map((row) => row["id"]), ["a"]);
    assert.equal(rows[0]?.["claimToken"], "");
    assert.equal(await tableBackupExists(backupDir, pendingOperationsTable), false);
  });

  it("recovers from a leftover backup when the crash left an empty recreated table", async () => {
    await conn.createEmptyTable(pendingOperationsTable, pendingOperationSchema);
    await writeTableBackup(backupDir, pendingOperationsTable, [
      currentRow("a", "applied"),
      currentRow("b", "rejected"),
    ]);

    await ensurePendingOperationsTable(conn, backupDir);

    assert.deepEqual(
      (await rowsInTable(conn)).map((row) => row["id"]),
      ["a", "b"],
    );
  });

  it("does not erase writes another process made after the snapshot was taken", async () => {
    // The migration is not cross-process write-safe (see TODOS.md), so recovery
    // must not compound the problem by replacing the table wholesale.
    const table = await conn.createEmptyTable(
      pendingOperationsTable,
      pendingOperationSchema,
    );
    await table.add([
      currentRow("b", "applied", { resolvedAt: "2026-08-07T10:00:00.000Z" }),
      currentRow("c", "pending"),
    ]);
    await writeTableBackup(backupDir, pendingOperationsTable, [
      currentRow("a", "applied"),
      currentRow("b", "pending"),
    ]);

    await ensurePendingOperationsTable(conn, backupDir);

    const rows = await rowsInTable(conn);
    assert.deepEqual(rows.map((row) => row["id"]), ["a", "b", "c"]);
    // "b" is in both: the on-disk copy is at least as new as the snapshot.
    assert.equal(rows[1]?.["status"], "applied");
    assert.equal(rows[1]?.["resolvedAt"], "2026-08-07T10:00:00.000Z");
  });

  it("refuses to proceed over an unreadable backup instead of assuming there was none", async () => {
    const table = await conn.createEmptyTable(
      pendingOperationsTable,
      pendingOperationSchema,
    );
    await table.add([currentRow("a", "applied")]);
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(backupDir, { recursive: true });
    await writeFile(
      tableBackupPath(backupDir, pendingOperationsTable),
      "{ truncated",
    );

    await assert.rejects(
      ensurePendingOperationsTable(conn, backupDir),
      /unreadable/,
    );
    // The evidence is left in place for a human.
    assert.equal(await tableBackupExists(backupDir, pendingOperationsTable), true);
  });
});

describe("merging a recovered snapshot with the live table", () => {
  it("prefers the on-disk row and keeps backup-only rows", () => {
    const merged = mergeRowsById(
      [
        { id: "a", status: "pending" },
        { id: "b", status: "pending" },
      ],
      [{ id: "b", status: "applied" }, { id: "c", status: "rejected" }],
    );
    assert.deepEqual(merged, [
      { id: "a", status: "pending" },
      { id: "b", status: "applied" },
      { id: "c", status: "rejected" },
    ]);
  });

  it("handles either side being empty", () => {
    assert.deepEqual(mergeRowsById([], [{ id: "a" }]), [{ id: "a" }]);
    assert.deepEqual(mergeRowsById([{ id: "a" }], []), [{ id: "a" }]);
    assert.deepEqual(mergeRowsById([], []), []);
  });
});

describe("cross-process migration lock", () => {
  let dir = "";

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "email-agent-lock-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("serializes two concurrent holders", async () => {
    const events: string[] = [];
    const hold = (name: string) =>
      withMigrationLock(dir, "t", async () => {
        events.push(`${name}:enter`);
        await new Promise((resolve) => setTimeout(resolve, 30));
        events.push(`${name}:exit`);
      });

    await Promise.all([hold("one"), hold("two")]);

    // Whoever went first must have exited before the other entered.
    assert.equal(events.length, 4);
    assert.equal(events[1]?.endsWith(":exit"), true);
    assert.equal(events[0]?.split(":")[0], events[1]?.split(":")[0]);
  });

  it("releases the lock even when the body throws", async () => {
    await assert.rejects(
      withMigrationLock(dir, "t", async () => {
        throw new Error("boom");
      }),
      /boom/,
    );
    await assert.rejects(stat(migrationLockPath(dir, "t")));
    // Still acquirable.
    assert.equal(await withMigrationLock(dir, "t", async () => "ok"), "ok");
  });

  it("reclaims a lock abandoned by a killed process", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(migrationLockPath(dir, "t"), { recursive: true });
    // staleAfterMs of 0 makes any existing lock immediately reclaimable.
    assert.equal(
      await withMigrationLock(dir, "t", async () => "recovered", {
        staleAfterMs: 0,
      }),
      "recovered",
    );
  });

  it("throws rather than migrating unlocked when the wait expires", async () => {
    const { mkdir } = await import("node:fs/promises");
    await mkdir(migrationLockPath(dir, "t"), { recursive: true });
    await assert.rejects(
      withMigrationLock(dir, "t", async () => "never", { waitMs: 0 }),
      /Timed out .* waiting for the t migration lock/,
    );
  });

  it("ages a lock from its mtime, and never from a backwards clock", () => {
    // Stale exactly at the threshold, not before it.
    assert.equal(isLockStale(1_000, 61_000, 60_000), true);
    assert.equal(isLockStale(1_000, 60_999, 60_000), false);
    assert.equal(isLockStale(1_000, 1_000, 60_000), false);
    // Clock jumped backwards: a fresh lock must not read as abandoned.
    assert.equal(isLockStale(10_000, 1_000, 60_000), false);
  });
});
