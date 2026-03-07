import { getDb } from "./connection.js";
import { actionResultsTable, type ActionResultRecord } from "./schema.js";
import { escapeSql } from "./utils.js";

export async function saveActionResult(
  result: ActionResultRecord,
): Promise<void> {
  const db = await getDb();
  const table = await db.openTable(actionResultsTable);
  await table.add([result]);
}

export async function getActionResults(options?: {
  actionId?: string;
  limit?: number;
}): Promise<ActionResultRecord[]> {
  const db = await getDb();
  const table = await db.openTable(actionResultsTable);
  let query = table.query();
  if (options?.actionId) {
    query = query.where(`actionId = '${escapeSql(options.actionId)}'`);
  }
  if (options?.limit) {
    query = query.limit(options.limit);
  }
  const results = await query.toArray();
  return results as unknown as ActionResultRecord[];
}
