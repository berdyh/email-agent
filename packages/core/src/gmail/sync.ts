import {
  generateEmbeddings,
  initDb,
  markStaleUnreadEmailsRead,
  upsertEmails,
} from "../db/index.js";
import { createLocalEmbeddingVectors } from "../shared/vector.js";
import {
  fetchEmailsWithMetadata,
  type FetchEmailsResult,
  type FetchOptions,
} from "./fetcher.js";
import { resolveAccountEmail } from "./client.js";
import { buildEmailRecords } from "./sync-records.js";

export interface SyncResult {
  fetched: number;
}

export async function syncEmails(options: FetchOptions): Promise<SyncResult> {
  await initDb();

  const accountId = await resolveAccountEmail(options.accountEmail);
  const fetchOptions = resolveSyncFetchOptions(options, accountId);

  const fetchResult = await fetchEmailsWithMetadata(fetchOptions);
  const emails = fetchResult.messages;
  if (emails.length === 0) {
    await reconcileUnreadSync(accountId, emails, fetchOptions, fetchResult);
    return { fetched: 0 };
  }

  const texts = emails.map(
    (e) => `${e.subject}\n${e.from}\n${e.bodyText.slice(0, 500)}`,
  );

  let vectors: number[][];
  try {
    vectors = await generateEmbeddings(texts);
  } catch {
    vectors = createLocalEmbeddingVectors(texts);
  }

  const records = buildEmailRecords(accountId, emails, vectors);

  await upsertEmails(records);
  await reconcileUnreadSync(accountId, emails, fetchOptions, fetchResult);

  return { fetched: emails.length };
}

export function resolveSyncFetchOptions(
  options: FetchOptions,
  accountId: string,
): FetchOptions {
  return { ...options, accountEmail: accountId };
}

export function shouldReconcileUnreadSync(
  options: FetchOptions,
  fetchResult: Pick<FetchEmailsResult, "exhausted" | "failedCount">,
): boolean {
  return (
    options.scope === "unread" &&
    fetchResult.exhausted &&
    fetchResult.failedCount === 0
  );
}

async function reconcileUnreadSync(
  accountId: string,
  emails: Array<{ id: string }>,
  options: FetchOptions,
  fetchResult: Pick<FetchEmailsResult, "exhausted" | "failedCount">,
): Promise<void> {
  if (!shouldReconcileUnreadSync(options, fetchResult)) return;
  await markStaleUnreadEmailsRead(accountId, emails.map((email) => email.id));
}
