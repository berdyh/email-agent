import { getDb } from "./connection.js";
import { actionResultsTable, type ActionResultRecord } from "./schema.js";
import { escapeSql, UNLIMITED_QUERY_ROWS } from "./utils.js";

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
  // Unlimited by default is 10 rows in LanceDB — see UNLIMITED_QUERY_ROWS.
  let query = table.query().limit(UNLIMITED_QUERY_ROWS);
  // One combined predicate — chained .where() calls REPLACE rather than AND
  // (see the note in emails.ts), which would drop the actionId filter.
  const filters: string[] = [];
  if (options?.actionId) {
    filters.push(`\`actionId\` = '${escapeSql(options.actionId)}'`);
  }
  if (options?.accountId !== undefined) {
    filters.push(`\`accountId\` = '${escapeSql(options.accountId)}'`);
  }
  if (filters.length > 0) {
    query = query.where(filters.join(" AND "));
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
