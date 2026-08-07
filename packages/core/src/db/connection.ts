import { connect, type Connection } from "@lancedb/lancedb";
import { mkdir } from "node:fs/promises";
import {
  Schema,
  Field,
  Utf8,
  Bool,
  Float32,
  Int32,
  FixedSizeList,
} from "apache-arrow";
import { LANCEDB_DIR } from "../config/defaults.js";
import { VECTOR_DIMENSION } from "../shared/vector.js";
import { ensureTableColumns } from "./migrations.js";
import {
  actionResultsTable,
  clustersTable,
  emailsTable,
  pendingOperationsTable,
} from "./schema.js";

let dbPromise: Promise<Connection> | null = null;

export function getDb(): Promise<Connection> {
  // Cache the connect() promise, not the resolved connection, so concurrent
  // first callers share a single connect() instead of each racing their own.
  if (!dbPromise) {
    dbPromise = (async () => {
      await mkdir(LANCEDB_DIR, { recursive: true });
      return connect(LANCEDB_DIR);
    })().catch((err) => {
      // Don't cache a rejected promise — allow the next caller to retry.
      dbPromise = null;
      throw err;
    });
  }
  return dbPromise;
}

function vectorField(name: string): Field {
  return new Field(
    name,
    new FixedSizeList(VECTOR_DIMENSION, new Field("item", new Float32())),
  );
}

const emailSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("accountId", new Utf8()),
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
  vectorField("vector"),
]);

const actionResultSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("actionId", new Utf8()),
  new Field("accountId", new Utf8()),
  new Field("status", new Utf8()),
  new Field("emailIds", new Utf8()),
  new Field("resultData", new Utf8()),
  new Field("agentUsed", new Utf8()),
  new Field("tokensUsed", new Int32()),
  new Field("durationMs", new Int32()),
  new Field("createdAt", new Utf8()),
]);

const clusterSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("name", new Utf8()),
  new Field("description", new Utf8()),
  new Field("emailIds", new Utf8()),
  new Field("method", new Utf8()),
  vectorField("centroid"),
]);

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

// ---------------------------------------------------------------------------
// Migration defaults.
//
// One rule for all three maps: the SQL here must produce EXACTLY the value a
// fresh insert writes for that column, so a migrated row is indistinguishable
// from one written today. For `pending_operations` that means a queued row
// comes back queued and unclaimed — `claimToken`/`claimedAt`/`resolvedAt` are
// "" — and is never silently promoted to approved.
//
// Only columns added after their table shipped appear here. A table missing a
// column with no entry is not a legacy shape we recognise, and
// `buildColumnAdditions` refuses it rather than filling NULL.
// ---------------------------------------------------------------------------

/** `""` is the documented legacy/gcloud-ADC account sentinel (see `db/MODULE.md`). */
const emailColumnDefaults: Record<string, string> = {
  accountId: "CAST('' AS STRING)",
};

/** `""` is the unscoped sentinel, matching `ActionResultRecord.accountId`. */
const actionResultColumnDefaults: Record<string, string> = {
  accountId: "CAST('' AS STRING)",
};

const pendingOperationColumnDefaults: Record<string, string> = {
  actionId: "CAST('' AS STRING)",
  actionName: "CAST('' AS STRING)",
  accountId: "CAST('' AS STRING)",
  labelIds: "CAST('[]' AS STRING)",
  error: "CAST('' AS STRING)",
  claimToken: "CAST('' AS STRING)",
  claimedAt: "CAST('' AS STRING)",
  resolvedAt: "CAST('' AS STRING)",
};

let initPromise: Promise<void> | null = null;

export function initDb(): Promise<void> {
  // Cache the in-flight promise (mirroring getDb) so concurrent callers share a
  // single pass. Clear on rejection so a later caller can retry.
  //
  // This is module-local, so it serializes callers within ONE process. Nothing
  // serializes a `serve` against a CLI run — and nothing needs to. Each table's
  // migration is a single `addColumns` MVCC commit: the loser of a race fails
  // with "column already exists" and `ensureTableColumns` re-probes and accepts
  // the winner's commit. No table is ever dropped, so there is no window in
  // which a concurrent write can be lost to one.
  if (!initPromise) {
    initPromise = getDb()
      .then(migrateSchema)
      .catch((err) => {
        initPromise = null;
        throw err;
      });
  }
  return initPromise;
}

/**
 * Brings every table to its current schema, adding missing columns in place.
 *
 * Exported so tests can drive the real sequence against a temp-directory
 * connection — `initDb()` is `getDb()` + this, and the only thing it adds is
 * where the database lives.
 *
 * `emails` migrates in place like the others, deliberately. It is the one table
 * whose rows are re-fetchable from Gmail, so drop-and-recreate would not be
 * *unrecoverable* — but every row also carries an embedding vector that costs a
 * paid API call to regenerate, and "" is already the documented legacy account
 * sentinel, so the in-place path is both cheaper and simpler. It also leaves
 * the codebase with zero drop-and-recreate migrations, which is what keeps the
 * rule from eroding back into one.
 */
export async function migrateSchema(conn: Connection): Promise<void> {
  await ensureTableColumns(conn, emailsTable, emailSchema, emailColumnDefaults);
  await ensureTableColumns(
    conn,
    actionResultsTable,
    actionResultSchema,
    actionResultColumnDefaults,
  );
  await ensureTableColumns(conn, clustersTable, clusterSchema, {});
  await ensureTableColumns(
    conn,
    pendingOperationsTable,
    pendingOperationSchema,
    pendingOperationColumnDefaults,
  );
}
