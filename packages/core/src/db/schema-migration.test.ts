// These run the REAL `migrateSchema()` — the whole of `initDb()` except which
// directory the database lives in — against a real LanceDB in a temp
// directory, starting from tables in the OLD on-disk shape.
//
// The claim under test is the one the whole approval gate rests on: an upgrade
// that adds a column does not lose the `applied`/`rejected` rows recording
// Gmail mutations that really happened. A pure-helper test cannot make that
// claim, because the helper never touches a table.

import assert from "node:assert/strict";
import { connect, type Connection } from "@lancedb/lancedb";
import {
  Schema,
  Field,
  Utf8,
  Bool,
  Int32,
  Float32,
  FixedSizeList,
} from "apache-arrow";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import { migrateSchema, pendingOperationSchema } from "./connection.js";
import {
  actionResultsTable,
  clustersTable,
  emailsTable,
  pendingOperationsTable,
} from "./schema.js";
import { VECTOR_DIMENSION } from "../shared/vector.js";

let dir = "";
let conn: Connection;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "email-agent-migration-"));
  conn = await connect(dir);
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function rows(
  table: string,
): Promise<Array<Record<string, unknown>>> {
  const opened = await conn.openTable(table);
  const all = (await opened.query().toArray()) as unknown as Array<
    Record<string, unknown>
  >;
  return all.sort((a, b) => String(a["id"]).localeCompare(String(b["id"])));
}

async function columnsOf(table: string): Promise<string[]> {
  const opened = await conn.openTable(table);
  return (await opened.schema()).fields.map((f: { name: string }) => f.name);
}

// --------------------------------------------------------------------------
// pending_operations — the audit trail this whole feature exists to protect
// --------------------------------------------------------------------------

/** The shape before the claim/lease columns were added. */
const legacyPendingSchema = new Schema(
  pendingOperationSchema.fields.filter(
    (field: { name: string }) =>
      !["claimToken", "claimedAt", "resolvedAt"].includes(field.name),
  ),
);

function legacyPendingRow(
  id: string,
  status: string,
): Record<string, unknown> {
  return {
    id,
    batchId: "batch-1",
    actionId: "junk",
    actionName: "Junk",
    accountId: "me@example.com",
    emailId: `msg-${id}`,
    type: "trash",
    labelIds: '["INBOX"]',
    status,
    error: status === "failed" ? "gmail said no" : "",
    createdAt: "2026-08-01T00:00:00.000Z",
  };
}

async function seedLegacyPendingOperations(): Promise<void> {
  const table = await conn.createEmptyTable(
    pendingOperationsTable,
    legacyPendingSchema,
  );
  await table.add([
    legacyPendingRow("op-1", "applied"),
    legacyPendingRow("op-2", "rejected"),
    legacyPendingRow("op-3", "pending"),
    legacyPendingRow("op-4", "failed"),
    legacyPendingRow("op-5", "applying"),
  ]);
}

describe("migrating a legacy pending_operations table", () => {
  it("keeps every row, including the applied/rejected audit trail", async () => {
    await seedLegacyPendingOperations();
    assert.equal((await rows(pendingOperationsTable)).length, 5);

    await migrateSchema(conn);

    const migrated = await rows(pendingOperationsTable);
    assert.equal(migrated.length, 5, "no row may be lost by a migration");
    assert.deepEqual(
      migrated.map((row) => `${row["id"]}:${row["status"]}`),
      [
        "op-1:applied",
        "op-2:rejected",
        "op-3:pending",
        "op-4:failed",
        "op-5:applying",
      ],
    );
    // Pre-existing values are untouched, not re-derived.
    assert.equal(migrated[0]?.["emailId"], "msg-op-1");
    assert.equal(migrated[0]?.["accountId"], "me@example.com");
    assert.equal(migrated[0]?.["labelIds"], '["INBOX"]');
    assert.equal(migrated[3]?.["error"], "gmail said no");
    assert.equal(migrated[0]?.["createdAt"], "2026-08-01T00:00:00.000Z");
  });

  it("fills the new columns with exactly what a fresh enqueue writes", async () => {
    await seedLegacyPendingOperations();
    await migrateSchema(conn);

    for (const row of await rows(pendingOperationsTable)) {
      // A queued row must come back queued AND unclaimed. Anything else would
      // be the migration silently approving a change the user never saw.
      assert.equal(row["claimToken"], "", `${String(row["id"])}.claimToken`);
      assert.equal(row["claimedAt"], "", `${String(row["id"])}.claimedAt`);
      assert.equal(row["resolvedAt"], "", `${String(row["id"])}.resolvedAt`);
    }
  });

  it("leaves the table immediately claimable on the new columns", async () => {
    await seedLegacyPendingOperations();
    await migrateSchema(conn);

    // The camelCase-in-backticks convention, on a column that did not exist a
    // moment ago — this is what the claim/lease path does on every apply.
    const table = await conn.openTable(pendingOperationsTable);
    await table.update({
      where: "`status` = 'pending' AND `claimToken` = ''",
      values: { claimToken: "tok-1", claimedAt: "2026-08-07T00:00:00.000Z", status: "applying" },
    });
    const claimed = (await table
      .query()
      .where("`claimToken` = 'tok-1'")
      .toArray()) as unknown as Array<Record<string, unknown>>;
    assert.deepEqual(
      claimed.map((row) => row["id"]),
      ["op-3"],
    );
  });

  it("adds exactly the missing columns and is a no-op on a second run", async () => {
    await seedLegacyPendingOperations();
    await migrateSchema(conn);
    // Set equality, not order: `addColumns` appends, so a migrated table lists
    // the new columns at the end while a fresh one lists them where the schema
    // declares them. Nothing resolves columns positionally.
    assert.deepEqual(
      [...(await columnsOf(pendingOperationsTable))].sort(),
      pendingOperationSchema.fields
        .map((f: { name: string }) => f.name)
        .sort(),
    );

    const before = await rows(pendingOperationsTable);
    await migrateSchema(conn);
    assert.deepEqual(await rows(pendingOperationsTable), before);
  });

  it("accepts a normally-shaped insert afterwards", async () => {
    await seedLegacyPendingOperations();
    await migrateSchema(conn);

    // The append-at-the-end column order must not break the enqueue path,
    // which hands LanceDB plain objects keyed by name.
    const table = await conn.openTable(pendingOperationsTable);
    await table.add([
      {
        ...legacyPendingRow("op-6", "pending"),
        claimToken: "",
        claimedAt: "",
        resolvedAt: "",
      },
    ]);
    const all = await rows(pendingOperationsTable);
    assert.equal(all.length, 6);
    assert.equal(all[5]?.["id"], "op-6");
    assert.equal(all[5]?.["claimToken"], "");
  });
});

// --------------------------------------------------------------------------
// action_results — not reconstructable; the higher-stakes of the two
// --------------------------------------------------------------------------

const legacyActionResultSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("actionId", new Utf8()),
  new Field("status", new Utf8()),
  new Field("emailIds", new Utf8()),
  new Field("resultData", new Utf8()),
  new Field("agentUsed", new Utf8()),
  new Field("tokensUsed", new Int32()),
  new Field("durationMs", new Int32()),
  new Field("createdAt", new Utf8()),
]);

describe("migrating a legacy action_results table", () => {
  it("keeps every past run, with its numeric columns intact", async () => {
    const table = await conn.createEmptyTable(
      actionResultsTable,
      legacyActionResultSchema,
    );
    await table.add([
      {
        id: "res-1",
        actionId: "priority",
        status: "success",
        emailIds: '["m1","m2"]',
        resultData: '{"summary":"two urgent"}',
        agentUsed: "claude",
        tokensUsed: 1234,
        durationMs: 5678,
        createdAt: "2026-07-01T00:00:00.000Z",
      },
      {
        id: "res-2",
        actionId: "junk",
        status: "error",
        emailIds: "[]",
        resultData: "{}",
        agentUsed: "codex",
        tokensUsed: 0,
        durationMs: 12,
        createdAt: "2026-07-02T00:00:00.000Z",
      },
    ]);

    await migrateSchema(conn);

    const migrated = await rows(actionResultsTable);
    assert.equal(migrated.length, 2);
    assert.equal(migrated[0]?.["resultData"], '{"summary":"two urgent"}');
    assert.equal(migrated[0]?.["tokensUsed"], 1234);
    assert.equal(migrated[0]?.["durationMs"], 5678);
    assert.equal(migrated[1]?.["tokensUsed"], 0);
    // "" is the unscoped/legacy sentinel, matching ActionResultRecord.
    assert.equal(migrated[0]?.["accountId"], "");
    assert.equal(migrated[1]?.["accountId"], "");
  });
});

// --------------------------------------------------------------------------
// emails — migrated in place too, so the cached embeddings survive
// --------------------------------------------------------------------------

const legacyEmailSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("threadId", new Utf8()),
  new Field("from", new Utf8()),
  new Field("to", new Utf8()),
  new Field("subject", new Utf8()),
  new Field("date", new Utf8()),
  new Field("bodyText", new Utf8()),
  new Field("bodyHtml", new Utf8()),
  new Field("labels", new Utf8()),
  new Field("isUnread", new Bool()),
  new Field("senderDomain", new Utf8()),
  new Field("snippet", new Utf8()),
  new Field(
    "vector",
    new FixedSizeList(VECTOR_DIMENSION, new Field("item", new Float32())),
  ),
]);

describe("migrating a legacy emails table", () => {
  it("keeps the cached rows and their embedding vectors", async () => {
    const vector = Array.from({ length: VECTOR_DIMENSION }, (_, i) =>
      i === 0 ? 0.5 : 0,
    );
    const table = await conn.createEmptyTable(emailsTable, legacyEmailSchema);
    await table.add([
      {
        id: "m1",
        threadId: "t1",
        from: "a@example.com",
        to: "me@example.com",
        subject: "hello",
        date: "2026-07-01T00:00:00.000Z",
        bodyText: "body",
        bodyHtml: "<p>body</p>",
        labels: '["INBOX"]',
        isUnread: true,
        senderDomain: "example.com",
        snippet: "body",
        vector,
      },
    ]);

    await migrateSchema(conn);

    const migrated = await rows(emailsTable);
    assert.equal(migrated.length, 1, "an embedding costs a paid API call to rebuild");
    assert.equal(migrated[0]?.["subject"], "hello");
    assert.equal(migrated[0]?.["isUnread"], true);
    assert.equal(migrated[0]?.["accountId"], "");
    const storedVector = Array.from(migrated[0]?.["vector"] as Iterable<number>);
    assert.equal(storedVector.length, VECTOR_DIMENSION);
    assert.equal(storedVector[0], 0.5);
  });
});

// --------------------------------------------------------------------------
// Fresh database, refusal, and concurrency
// --------------------------------------------------------------------------

describe("migrateSchema on a fresh database", () => {
  it("creates every table at the current schema", async () => {
    await migrateSchema(conn);
    const names = await conn.tableNames();
    for (const table of [
      emailsTable,
      actionResultsTable,
      clustersTable,
      pendingOperationsTable,
    ]) {
      assert.ok(names.includes(table), `missing table ${table}`);
    }
    assert.deepEqual(
      await columnsOf(pendingOperationsTable),
      pendingOperationSchema.fields.map((f: { name: string }) => f.name),
    );
    assert.equal((await rows(pendingOperationsTable)).length, 0);
  });
});

describe("a table shape with no declared default", () => {
  it("refuses to migrate rather than inventing a value, and touches nothing", async () => {
    // `status` has no migration default: a pending_operations table without it
    // is not a legacy shape, it is one we do not recognise.
    const unknownShape = new Schema(
      pendingOperationSchema.fields.filter(
        (field: { name: string }) => field.name !== "status",
      ),
    );
    const table = await conn.createEmptyTable(
      pendingOperationsTable,
      unknownShape,
    );
    const row = legacyPendingRow("op-1", "applied");
    delete row["status"];
    await table.add([{ ...row, claimToken: "", claimedAt: "", resolvedAt: "" }]);

    await assert.rejects(
      migrateSchema(conn),
      /column "status" is absent and has no migration default/,
    );
    // The refusal is not destructive: the row is still there to migrate by hand.
    assert.equal((await rows(pendingOperationsTable)).length, 1);
  });
});

// --------------------------------------------------------------------------
// The create race, driven deterministically.
//
// HOW THE INTERLEAVING IS FORCED — no sleeps, no Promise.all, no luck:
//
// LanceDB's `tableNames()` enumerates the on-disk `*.lance` directories, and a
// table's directory exists before its `_versions/1.manifest` is committed. So
// `mkdir <db>/<table>.lance` puts the database in EXACTLY the state a process
// caught mid-`createEmptyTable` leaves it in: the name is listed, and
// `openTable` rejects it with `Table 'X' was not found` — the same message a
// name that was never created produces. `halfCreated()` asserts both halves of
// that precondition, so these tests fail loudly if a LanceDB upgrade changes
// the state rather than quietly stopping to exercise the race.
//
// That alone gives the never-converges case. For the converges case, the
// winner's commit is placed at a controlled point by `committingAtFirstOpen()`:
// it lets the loser's FIRST `openTable` run against the genuinely uncommitted
// table, keeps the genuine error LanceDB raised, commits the winner's table,
// and only then rethrows. Attempt 1 therefore always fails against real
// uncommitted state and attempt 2 always succeeds against real committed
// state. The test controls only WHEN the winner commits — every error and
// every table in play is LanceDB's own.
// --------------------------------------------------------------------------

/** Temp dirs holding the reference databases; torn down with the main one. */
let scratchDirs: string[] = [];

afterEach(async () => {
  await Promise.all(
    scratchDirs.map((path) => rm(path, { recursive: true, force: true })),
  );
  scratchDirs = [];
});

/**
 * The Arrow schema a fully-migrated database has for `table`, read back from a
 * pristine one. Lets a test commit a "winner's" table at the current shape
 * without the schemas having to be exported for the test's benefit.
 */
async function currentSchemaOf(table: string): Promise<Schema> {
  const refDir = await mkdtemp(join(tmpdir(), "email-agent-reference-"));
  scratchDirs.push(refDir);
  const ref = await connect(refDir);
  await migrateSchema(ref);
  return (await ref.openTable(table)).schema();
}

/**
 * Leaves `table` in the mid-`createEmptyTable` state: directory present, no
 * committed manifest. Asserts the state is really what it claims to be.
 */
async function halfCreated(table: string): Promise<void> {
  await mkdir(join(dir, `${table}.lance`), { recursive: true });
  assert.ok(
    (await conn.tableNames()).includes(table),
    `precondition: a half-created ${table} must still be LISTED`,
  );
  await assert.rejects(
    conn.openTable(table),
    /was not found/,
    `precondition: a half-created ${table} must NOT be openable`,
  );
}

/**
 * A `Connection` that commits `table` the first time an `openTable` for it
 * fails — i.e. the winner's manifest lands between the loser's first and second
 * attempt. `observed()` returns the real error the first attempt hit.
 */
function committingAtFirstOpen(
  base: Connection,
  table: string,
  schema: Schema,
): { conn: Connection; observed: () => Error | null } {
  let fired = false;
  let seen: Error | null = null;

  const proxy = new Proxy(base, {
    get(target, prop) {
      if (prop === "openTable") {
        return async (name: string): Promise<unknown> => {
          if (name !== table || fired) return target.openTable(name);
          fired = true;
          try {
            return await target.openTable(name);
          } catch (err) {
            seen = err as Error;
          }
          // The winner's createEmptyTable commits right here.
          await target.createEmptyTable(name, schema);
          throw seen;
        };
      }
      const value = Reflect.get(target, prop) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  }) as Connection;

  return { conn: proxy, observed: () => seen };
}

describe("a table another process is mid-way through creating", () => {
  // One code path (`ensureTableColumns`) serves all four tables, which is why
  // the failing name used to vary run to run. Covered as one path, four cases.
  for (const table of [
    emailsTable,
    actionResultsTable,
    clustersTable,
    pendingOperationsTable,
  ]) {
    it(`converges on the winner's ${table} instead of throwing "not found"`, async () => {
      const schema = await currentSchemaOf(table);
      await halfCreated(table);

      const winner = committingAtFirstOpen(conn, table, schema);
      await migrateSchema(winner.conn);

      const failure = winner.observed();
      assert.ok(
        failure !== null,
        "the interleaving did not fire: no openTable failed, so the race was never exercised",
      );
      assert.match(
        failure.message,
        /was not found/,
        "the forced failure must be LanceDB's own, not a fabricated one",
      );

      // Converged on the winner's table, at the current schema, and usable.
      const names = await conn.tableNames();
      assert.ok(names.includes(table));
      assert.deepEqual(
        [...(await columnsOf(table))].sort(),
        schema.fields.map((f: { name: string }) => f.name).sort(),
      );
    });
  }

  it("keeps the rows when the loser retries a table that already had them", async () => {
    // The other race direction, on a table with an audit trail to lose: the
    // legacy pending_operations rows are already on disk, and the migration
    // that adds the claim columns must still see all five after riding out a
    // transient not-found.
    await seedLegacyPendingOperations();
    const schema = await conn
      .openTable(pendingOperationsTable)
      .then((t) => t.schema());

    let fired = false;
    const flaky = new Proxy(conn, {
      get(target, prop) {
        if (prop === "openTable") {
          return async (name: string): Promise<unknown> => {
            if (name === pendingOperationsTable && !fired) {
              fired = true;
              // Exactly the transient LanceDB raises mid-create, injected on a
              // table that genuinely exists and is genuinely still listed.
              throw new Error(`Table '${name}' was not found`);
            }
            return target.openTable(name);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Connection;

    await migrateSchema(flaky);
    assert.ok(fired, "the transient was never injected");

    const migrated = await rows(pendingOperationsTable);
    assert.equal(migrated.length, 5, "no row may be lost to a retried open");
    assert.deepEqual(
      migrated.map((row) => `${row["id"]}:${row["status"]}`),
      ["op-1:applied", "op-2:rejected", "op-3:pending", "op-4:failed", "op-5:applying"],
    );
    assert.ok(schema.fields.length < (await columnsOf(pendingOperationsTable)).length);
  });

  it("still fails loudly when nothing ever commits the table", async () => {
    // A create that died half-way leaves a directory no process will finish.
    // The bounded retry must run out and say so — not hang, and not pretend the
    // table is fine.
    await halfCreated(clustersTable);
    await assert.rejects(
      migrateSchema(conn),
      /Table clusters is listed by the database but still could not be opened after \d+ms/,
    );
  });

  it("rethrows a non-\"not found\" open failure immediately, unretried", async () => {
    // A permissions or corruption failure is not a visibility race. Retrying it
    // would turn a precise error into a timeout.
    await seedLegacyPendingOperations();
    let opens = 0;
    const denied = new Proxy(conn, {
      get(target, prop) {
        if (prop === "openTable") {
          return async (name: string): Promise<unknown> => {
            if (name === pendingOperationsTable) {
              opens++;
              throw new Error("Permission denied reading pending_operations");
            }
            return target.openTable(name);
          };
        }
        const value = Reflect.get(target, prop) as unknown;
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Connection;

    await assert.rejects(migrateSchema(denied), /Permission denied/);
    assert.equal(opens, 1, "a non-transient failure must not be retried");
  });
});

describe("two migrations racing over one table", () => {
  // End-to-end smoke over two real connections. These hit the race by luck, so
  // the deterministic suite above is what actually guards the regression; these
  // exist to confirm the fix holds when the interleaving is not forced at all.
  it("loses no rows, and the loser accepts the winner's commit", async () => {
    await seedLegacyPendingOperations();

    // Two independent connections, as two processes would have. In-process
    // this only approximates the cross-process case; the cross-process
    // behaviour was verified separately by forking two node processes (one
    // commits, the other fails with "Column already exists", zero rows lost in
    // every interleaving over five runs).
    const [a, b] = await Promise.all([
      connect(dir).then(migrateSchema).then(
        () => "ok",
        (err: unknown) => `threw: ${String(err)}`,
      ),
      connect(dir).then(migrateSchema).then(
        () => "ok",
        (err: unknown) => `threw: ${String(err)}`,
      ),
    ]);

    assert.equal(a, "ok", `first migration: ${a}`);
    assert.equal(b, "ok", `second migration: ${b}`);

    const migrated = await rows(pendingOperationsTable);
    assert.equal(migrated.length, 5);
    assert.deepEqual(
      [...(await columnsOf(pendingOperationsTable))].sort(),
      pendingOperationSchema.fields
        .map((f: { name: string }) => f.name)
        .sort(),
    );
  });

  it("survives a race to create the tables on a brand-new database", async () => {
    // The other half of the race: nothing exists yet, so both callers see every
    // table as absent and both call createEmptyTable.
    const [a, b] = await Promise.all([
      connect(dir).then(migrateSchema).then(
        () => "ok",
        (err: unknown) => `threw: ${String(err)}`,
      ),
      connect(dir).then(migrateSchema).then(
        () => "ok",
        (err: unknown) => `threw: ${String(err)}`,
      ),
    ]);
    assert.equal(a, "ok", `first init: ${a}`);
    assert.equal(b, "ok", `second init: ${b}`);

    const names = await conn.tableNames();
    for (const table of [
      emailsTable,
      actionResultsTable,
      clustersTable,
      pendingOperationsTable,
    ]) {
      assert.ok(names.includes(table), `missing table ${table}`);
    }
  });
});
