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
import { missingColumns, projectRowsToSchema } from "./migrations.js";

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

const pendingOperationSchema = new Schema([
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
 * Values for `pending_operations` columns a legacy table predates. Every
 * column is Utf8 and "" is the schema's documented "unset" sentinel, so a
 * migrated row lands in exactly the state a fresh enqueue would produce.
 */
const pendingOperationMigrationDefaults: Record<string, unknown> = {
  claimToken: "",
  claimedAt: "",
  resolvedAt: "",
  error: "",
  labelIds: "[]",
  accountId: "",
};

const clusterSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("name", new Utf8()),
  new Field("description", new Utf8()),
  new Field("emailIds", new Utf8()),
  new Field("method", new Utf8()),
  vectorField("centroid"),
]);

let initPromise: Promise<void> | null = null;

export function initDb(): Promise<void> {
  // Cache the in-flight migration promise (mirroring getDb) so concurrent
  // callers share a single init pass instead of racing the drop/create
  // sequence. Clear on rejection so a later caller can retry.
  if (!initPromise) {
    initPromise = runInit().catch((err) => {
      initPromise = null;
      throw err;
    });
  }
  return initPromise;
}

async function runInit(): Promise<void> {
  const conn = await getDb();
  const tableNames = await conn.tableNames();

  if (!tableNames.includes("emails")) {
    await conn.createEmptyTable("emails", emailSchema);
  } else {
    // Migration: ensure accountId column exists
    const emailsTable = await conn.openTable("emails");
    const existingSchema = await emailsTable.schema();
    const hasAccountId = existingSchema.fields.some(
      (f: { name: string }) => f.name === "accountId",
    );
    if (!hasAccountId) {
      console.warn(
        "Migrating emails table: adding accountId column. Existing emails will need to be re-fetched.",
      );
      await conn.dropTable("emails");
      await conn.createEmptyTable("emails", emailSchema);
    }
  }

  if (!tableNames.includes("action_results")) {
    await conn.createEmptyTable("action_results", actionResultSchema);
  } else {
    // Migration: ensure accountId column exists (LanceDB has no ALTER TABLE)
    const actionResults = await conn.openTable("action_results");
    const existingSchema = await actionResults.schema();
    const hasAccountId = existingSchema.fields.some(
      (f: { name: string }) => f.name === "accountId",
    );
    if (!hasAccountId) {
      console.warn(
        "Migrating action_results table: adding accountId column. Existing action results will be preserved with an empty (legacy/unscoped) accountId.",
      );
      // Unlike emails, action results cannot be re-fetched — preserve every
      // legacy row. Read them before the drop, then re-insert with the
      // unscoped accountId sentinel ("") under the new schema.
      const legacyRows = (await actionResults
        .query()
        .toArray()) as unknown as Array<Record<string, unknown>>;
      await conn.dropTable("action_results");
      const migrated = await conn.createEmptyTable(
        "action_results",
        actionResultSchema,
      );
      if (legacyRows.length > 0) {
        await migrated.add(
          legacyRows.map((row) => ({ ...row, accountId: "" })),
        );
      }
    }
  }

  if (!tableNames.includes("clusters")) {
    await conn.createEmptyTable("clusters", clusterSchema);
  }

  if (!tableNames.includes("pending_operations")) {
    await conn.createEmptyTable("pending_operations", pendingOperationSchema);
  } else {
    // Migration: probe for ANY missing column, not just the one the last
    // schema change added (LanceDB has no ALTER TABLE). This is the same
    // pattern `emails`/`action_results` use, generalized so the next added
    // column is handled by construction.
    const pendingOps = await conn.openTable("pending_operations");
    const existingSchema = await pendingOps.schema();
    const requiredColumns = pendingOperationSchema.fields.map(
      (f: { name: string }) => f.name,
    );
    const absent = missingColumns(
      existingSchema.fields.map((f: { name: string }) => f.name),
      requiredColumns,
    );
    if (absent.length > 0) {
      console.warn(
        `Migrating pending_operations table: adding column(s) ${absent.join(", ")}. Existing rows — including the applied/rejected audit trail — are preserved; queued rows stay queued and unclaimed.`,
      );
      // Preserve every row. The earlier version dropped the table outright,
      // which took the applied/rejected audit trail — the record of Gmail
      // changes that really happened, and the whole point of the feature —
      // with it, while the warning mentioned only "queued (unapproved)"
      // changes. Re-inserting is safe rather than a guess: every new column
      // is filled with its documented unset sentinel, which reproduces the
      // exact state a fresh enqueue produces, and the projection drops any
      // column the current schema no longer declares.
      const legacyRows = (await pendingOps
        .query()
        .toArray()) as unknown as Array<Record<string, unknown>>;
      const preserved = projectRowsToSchema(
        legacyRows,
        requiredColumns,
        pendingOperationMigrationDefaults,
      );
      await conn.dropTable("pending_operations");
      const migrated = await conn.createEmptyTable(
        "pending_operations",
        pendingOperationSchema,
      );
      if (preserved.length > 0) {
        await migrated.add(preserved);
      }
    }
  }
}
