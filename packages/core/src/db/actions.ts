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
  accountId?: string;
  limit?: number;
}): Promise<ActionResultRecord[]> {
  const db = await getDb();
  const table = await db.openTable(actionResultsTable);
  let query = table.query();
  if (options?.actionId) {
    query = query.where(`\`actionId\` = '${escapeSql(options.actionId)}'`);
  }
  if (options?.accountId !== undefined) {
    query = query.where(`\`accountId\` = '${escapeSql(options.accountId)}'`);
  }
  // Fetch all matching rows, sort newest-first, then slice. LanceDB applies
  // limit before this JS sort, so limiting in-query would return an arbitrary
  // N rows rather than the most recent N.
  const results = await query.toArray();
  const records = results as unknown as ActionResultRecord[];
  records.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return options?.limit ? records.slice(0, options.limit) : records;
}
