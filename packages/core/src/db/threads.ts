import { getDb } from "./connection.js";
import { threadsTable, type ThreadRecord } from "./schema.js";
import { escapeSql } from "./utils.js";

export async function upsertThread(thread: ThreadRecord): Promise<void> {
  const db = await getDb();
  const table = await db.openTable(threadsTable);
  await table.add([thread], { mode: "overwrite" });
}

export async function getThreads(options?: {
  limit?: number;
  offset?: number;
}): Promise<ThreadRecord[]> {
  const db = await getDb();
  const table = await db.openTable(threadsTable);
  let query = table.query();
  if (options?.limit) query = query.limit(options.limit);
  if (options?.offset) query = query.offset(options.offset);
  const results = await query.toArray();
  return results as unknown as ThreadRecord[];
}

export async function getThreadById(
  id: string,
): Promise<ThreadRecord | null> {
  const db = await getDb();
  const table = await db.openTable(threadsTable);
  const results = await table.query().where(`id = '${escapeSql(id)}'`).limit(1).toArray();
  return (results[0] as unknown as ThreadRecord) ?? null;
}
