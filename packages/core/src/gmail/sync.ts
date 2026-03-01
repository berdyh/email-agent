import { initDb, upsertEmails, generateEmbeddings } from "../db/index.js";
import { fetchEmails, type FetchOptions } from "./fetcher.js";
import { resolveAccountEmail } from "./client.js";

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
    vectors = texts.map(() => Array(768).fill(0) as number[]);
  }

  const records = emails.map((e, i) => ({
    id: e.id,
    accountId,
    threadId: e.threadId,
    from: e.from,
    to: e.to,
    subject: e.subject,
    date: e.date,
    bodyText: e.bodyText,
    bodyHtml: e.bodyHtml,
    labels: JSON.stringify(e.labels),
    isUnread: e.isUnread,
    senderDomain: e.senderDomain,
    snippet: e.snippet,
    vector: vectors[i] ?? (Array(768).fill(0) as number[]),
  }));

  await upsertEmails(records);

  return { fetched: emails.length };
}
