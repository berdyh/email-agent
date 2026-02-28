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

let db: Connection | null = null;

export async function getDb(): Promise<Connection> {
  if (db) return db;
  await mkdir(LANCEDB_DIR, { recursive: true });
  db = await connect(LANCEDB_DIR);
  return db;
}

const VECTOR_DIM = 768;

function vectorField(name: string): Field {
  return new Field(
    name,
    new FixedSizeList(VECTOR_DIM, new Field("item", new Float32())),
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

const threadSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("subject", new Utf8()),
  new Field("messageCount", new Int32()),
  new Field("lastMessageDate", new Utf8()),
  new Field("summary", new Utf8()),
  new Field("summaryData", new Utf8()),
  new Field("priority", new Utf8()),
  new Field("category", new Utf8()),
  vectorField("vector"),
]);

const actionResultSchema = new Schema([
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

const clusterSchema = new Schema([
  new Field("id", new Utf8()),
  new Field("name", new Utf8()),
  new Field("description", new Utf8()),
  new Field("emailIds", new Utf8()),
  new Field("method", new Utf8()),
  vectorField("centroid"),
]);

const settingsSchema = new Schema([
  new Field("key", new Utf8()),
  new Field("value", new Utf8()),
  new Field("updatedAt", new Utf8()),
]);

export async function initDb(): Promise<void> {
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

  if (!tableNames.includes("threads")) {
    await conn.createEmptyTable("threads", threadSchema);
  }

  if (!tableNames.includes("action_results")) {
    await conn.createEmptyTable("action_results", actionResultSchema);
  }

  if (!tableNames.includes("clusters")) {
    await conn.createEmptyTable("clusters", clusterSchema);
  }

  if (!tableNames.includes("settings")) {
    await conn.createEmptyTable("settings", settingsSchema);
  }
}
