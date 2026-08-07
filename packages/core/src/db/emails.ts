import { getDb } from "./connection.js";
import { emailsTable, type EmailRecord } from "./schema.js";
import { escapeSql, UNLIMITED_QUERY_ROWS } from "./utils.js";

export function buildEmailFilters(options?: {
  accountId?: string;
  unreadOnly?: boolean;
}): string[] {
  const filters: string[] = [];
  if (options?.accountId !== undefined) {
    filters.push(`\`accountId\` = '${escapeSql(options.accountId)}'`);
  }
  if (options?.unreadOnly) {
    filters.push("`isUnread` = true");
  }
  return filters;
}

/**
 * Predicate matching exactly the rows `emails` is about to replace.
 *
 * Grouped by account rather than emitted as `accountId IN (...) AND id IN (...)`,
 * which is a cross product: two accounts that happen to share a Gmail message id
 * would each match the other's row. `accountId` is backticked (DataFusion folds
 * unquoted identifiers to lowercase); `id` is already lowercase.
 *
 * Pure, so the identity rule is testable without a table.
 */
export function buildEmailReplacementFilter(
  emails: ReadonlyArray<Pick<EmailRecord, "accountId" | "id">>,
): string {
  const idsByAccount = new Map<string, Set<string>>();
  for (const email of emails) {
    const ids = idsByAccount.get(email.accountId) ?? new Set<string>();
    ids.add(email.id);
    idsByAccount.set(email.accountId, ids);
  }

  return [...idsByAccount.entries()]
    .map(([accountId, ids]) => {
      const list = [...ids].map((id) => `'${escapeSql(id)}'`).join(", ");
      return `(\`accountId\` = '${escapeSql(accountId)}' AND id IN (${list}))`;
    })
    .join(" OR ");
}

/**
 * Stores fetched mail, replacing any row already held for the same
 * (accountId, id).
 *
 * DELETE-THEN-APPEND, NOT `mergeInsert`. This used to be
 * `mergeInsert(["accountId", "id"]).whenMatchedUpdateAll().whenNotMatchedInsertAll()`,
 * which could not write a single row. Both halves of that failure were
 * reproduced on a real temp-directory table against `@lancedb/lancedb` 0.15.0
 * (2026-08-07) and neither is fixable from this side:
 *
 *   1. NULLABILITY. `createEmptyTable(name, schema)` builds the table from the
 *      Arrow schema in `connection.ts`, and `new Field(name, type)` defaults to
 *      `nullable = false`. LanceDB infers `nullable = true` from the plain JS
 *      objects handed to `execute()`, and `mergeInsert` rejects the mismatch —
 *      `Append with different schema: 'id' should have nullable=false but
 *      nullable=true`, once per column. `table.add()` coerces instead, which is
 *      why every other writer in this package works.
 *   2. THE JOIN KEY. `mergeInsert` composes the probe column as
 *      `target_<key>` and parses it as an UNQUOTED SQL identifier, so DataFusion
 *      folds `target_accountId` to `target_accountid` and the merge fails with
 *      `No field named target_accountid`. This is the same camelCase rule this
 *      module already documents for `.where()`, in a place with no escape hatch:
 *      backticking the key yields ``target_`accountId` `` and fails differently.
 *      A single lowercase key (`["id"]`) would parse — and would be wrong, since
 *      row identity is (accountId, id) and two accounts can hold the same Gmail
 *      message id.
 *
 * WHAT THIS COSTS, stated rather than hidden. Two commits instead of one, so
 * there is a window in which the replaced rows are absent: a concurrent reader
 * sees them missing, and a crash between the two loses them. Both are bounded by
 * "rows this call already has fresher copies of in memory" — the deleted set is
 * exactly the set being re-added, from records built before the delete — so the
 * loss is re-fetchable and costs only the embeddings for that batch, which this
 * call was about to overwrite anyway. `mergeInsert` was the atomic option and it
 * does not work; a per-row `update()` would be atomic per row but costs one full
 * table rewrite per email, and a fetch is routinely hundreds.
 */
export async function upsertEmails(emails: EmailRecord[]): Promise<void> {
  if (emails.length === 0) return;
  const db = await getDb();
  const table = await db.openTable(emailsTable);

  await table.delete(buildEmailReplacementFilter(emails));
  await table.add(emails);
}

export async function getEmails(options?: {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  accountId?: string;
}): Promise<EmailRecord[]> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);

  // LanceDB caps an unlimited query at 10 rows (see UNLIMITED_QUERY_ROWS).
  // The paging below is done in JS over the full match set, so the scan must
  // not be truncated before it starts.
  let query = table.query().limit(UNLIMITED_QUERY_ROWS);
  // One combined predicate, never chained .where() calls: LanceDB's where()
  // maps to `onlyIf`, which REPLACES the previous filter instead of ANDing it,
  // so chaining silently drops every filter but the last.
  const filters = buildEmailFilters(options);
  if (filters.length > 0) {
    query = query.where(filters.join(" AND "));
  }

  const limit = options?.limit ?? 0;
  const offset = options?.offset ?? 0;

  // Fetch all matching records, sort by date desc, then slice. LanceDB applies
  // limit before this JS date-sort, so limiting in-query would return an
  // arbitrary N rows rather than the newest N. The table is local, so paging
  // in memory keeps ordering correct for every limit/offset combination.
  const results = await query.toArray();
  const emails = results as unknown as EmailRecord[];
  emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  if (offset > 0) {
    return limit > 0 ? emails.slice(offset, offset + limit) : emails.slice(offset);
  }
  return limit > 0 ? emails.slice(0, limit) : emails;
}

export async function countEmails(options?: {
  unreadOnly?: boolean;
  accountId?: string;
}): Promise<number> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  const filters = buildEmailFilters(options);
  const filter = filters.length > 0 ? filters.join(" AND ") : undefined;
  return table.countRows(filter);
}

export async function getEmailById(
  id: string,
  accountId: string,
): Promise<EmailRecord | null> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  const results = await table
    .query()
    .where(buildEmailIdentityFilter(id, accountId))
    .limit(1)
    .toArray();
  return (results[0] as unknown as EmailRecord) ?? null;
}

export async function updateEmailReadStatus(
  id: string,
  isUnread: boolean,
  accountId: string,
): Promise<void> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  await table.update({
    where: buildEmailIdentityFilter(id, accountId),
    values: { isUnread },
  });
}

export async function updateEmailVector(
  id: string,
  vector: number[],
  accountId: string,
): Promise<void> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  await table.update({
    where: buildEmailIdentityFilter(id, accountId),
    values: { vector },
  });
}

export async function markStaleUnreadEmailsRead(
  accountId: string,
  currentUnreadIds: string[],
): Promise<void> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  await table.update({
    where: buildStaleUnreadFilter(accountId, currentUnreadIds),
    values: { isUnread: false },
  });
}

export function buildStaleUnreadFilter(
  accountId: string,
  currentUnreadIds: string[],
): string {
  const filters = [
    `\`accountId\` = '${escapeSql(accountId)}'`,
    "`isUnread` = true",
    ...currentUnreadIds.map((id) => `id != '${escapeSql(id)}'`),
  ];
  return filters.join(" AND ");
}

function buildEmailIdentityFilter(id: string, accountId: string): string {
  const idFilter = `id = '${escapeSql(id)}'`;
  return `\`accountId\` = '${escapeSql(accountId)}' AND ${idFilter}`;
}
