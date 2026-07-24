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
}
