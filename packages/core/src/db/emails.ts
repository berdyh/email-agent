import { getDb } from "./connection.js";
import { emailsTable, type EmailRecord } from "./schema.js";
import { escapeSql } from "./utils.js";

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

export async function upsertEmails(emails: EmailRecord[]): Promise<void> {
  if (emails.length === 0) return;
  const db = await getDb();
  const table = await db.openTable(emailsTable);

  await table
    .mergeInsert(["accountId", "id"])
    .whenMatchedUpdateAll()
    .whenNotMatchedInsertAll()
    .execute(emails);
}

export async function getEmails(options?: {
  unreadOnly?: boolean;
  limit?: number;
  offset?: number;
  accountId?: string;
}): Promise<EmailRecord[]> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);

  let query = table.query();
  for (const f of buildEmailFilters(options)) {
    query = query.where(f);
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

export async function searchEmails(
  queryVector: number[],
  limit = 10,
  accountId?: string,
): Promise<EmailRecord[]> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  let query = table.search(queryVector);
  if (accountId !== undefined) {
    query = query.where(`\`accountId\` = '${escapeSql(accountId)}'`);
  }
  const results = await query.limit(limit).toArray();
  return results as unknown as EmailRecord[];
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
