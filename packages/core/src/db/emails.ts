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
}): Promise<EmailRecord[]> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);

  let query = table.query();
  if (options?.unreadOnly) {
    query = query.where("isUnread = true");
  }
  if (options?.limit) {
    query = query.limit(options.limit);
  }
  if (options?.offset) {
    query = query.offset(options.offset);
  }
  const results = await query.toArray();
  return results as unknown as EmailRecord[];
}

export async function getEmailById(id: string): Promise<EmailRecord | null> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  const results = await table.query().where(`id = '${id}'`).limit(1).toArray();
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
): Promise<EmailRecord[]> {
  const db = await getDb();
  const table = await db.openTable(emailsTable);
  const results = await table.search(queryVector).limit(limit).toArray();
  return results as unknown as EmailRecord[];
}
