import { getDb } from "./connection.js";
import { emailsTable, type EmailRecord } from "./schema.js";

export async function upsertEmails(emails: EmailRecord[]): Promise<void> {
  if (emails.length === 0) return;
  const db = await getDb();
  const table = await db.openTable(emailsTable);

  // LanceDB add is upsert-like — overwrite mode handles duplicates
  await table.add(emails, { mode: "overwrite" });
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
  if (options?.accountId) {
    const safeAccountId = options.accountId.replace(/'/g, "''");
    query = query.where(`accountId = '${safeAccountId}'`);
  }
  if (options?.unreadOnly) {
    query = query.where("isUnread = true");
  }

  const limit = options?.limit ?? 0;
  const offset = options?.offset ?? 0;

  if (offset > 0) {
    // Fetch all matching records, sort, then slice — prevents limit+offset from
    // truncating before sort, which breaks pagination ordering
    const results = await query.toArray();
    const emails = results as unknown as EmailRecord[];
    emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
    return limit > 0 ? emails.slice(offset, offset + limit) : emails.slice(offset);
  }

  if (limit > 0) {
    query = query.limit(limit);
  }
  const results = await query.toArray();
  const emails = results as unknown as EmailRecord[];
  emails.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
  return emails;
}

export async function getEmailById(id: string): Promise<EmailRecord | null> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  const safeId = id.replace(/'/g, "''");
  const results = await table.query().where(`id = '${safeId}'`).limit(1).toArray();
  return (results[0] as unknown as EmailRecord) ?? null;
}

export async function updateEmailReadStatus(
  id: string,
  isUnread: boolean,
): Promise<void> {
  const email = await getEmailById(id);
  if (!email) return;
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  await table.add([{ ...email, isUnread }], { mode: "overwrite" });
}

export async function searchEmails(
  queryVector: number[],
  limit = 10,
  accountId?: string,
): Promise<EmailRecord[]> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  let query = table.search(queryVector);
  if (accountId) {
    const safeAccountId = accountId.replace(/'/g, "''");
    query = query.where(`accountId = '${safeAccountId}'`);
  }
  const results = await query.limit(limit).toArray();
  return results as unknown as EmailRecord[];
}
