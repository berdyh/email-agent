import { initDb, upsertEmails, generateEmbeddings } from "../db/index.js";
import { createZeroVector } from "../shared/vector.js";
import { fetchEmails, type FetchOptions } from "./fetcher.js";
import { resolveAccountEmail } from "./client.js";
import { buildEmailRecords } from "./sync-records.js";

export interface SyncResult {
  fetched: number;
}

export async function syncEmails(options: FetchOptions): Promise<SyncResult> {
  await initDb();

  const accountId = await resolveAccountEmail(options.accountEmail);

  const emails = await fetchEmails(options);
  if (emails.length === 0) return { fetched: 0 };

  const texts = emails.map(
    (e) => `${e.subject}\n${e.from}\n${e.bodyText.slice(0, 500)}`,
  );

  let vectors: number[][];
  try {
    vectors = await generateEmbeddings(texts);
  } catch {
    // Graceful degradation: store with zero vectors if embedding fails
    vectors = texts.map(() => createZeroVector());
  }

  const records = buildEmailRecords(accountId, emails, vectors);

  await upsertEmails(records);

  return { fetched: emails.length };
}
