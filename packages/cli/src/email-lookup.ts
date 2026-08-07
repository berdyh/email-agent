import { getDb, emailsTable, UNLIMITED_QUERY_ROWS } from "@email-agent/core";
import type { EmailRecord } from "@email-agent/core";

export interface EmailRef {
  accountId: string;
  emailId: string;
}

/**
 * Stable Map key for an (accountId, emailId) pair, separated by NUL because NUL
 * cannot occur in either half.
 *
 * The separator is written as the `\u0000` ESCAPE, never as a literal NUL byte:
 * a literal one makes git treat this file as binary, so `git diff` prints
 * `Bin 0 -> N bytes` instead of a patch and the file goes unreviewed.
 */
export function emailRefKey(accountId: string, emailId: string): string {
  return `${accountId}\u0000${emailId}`;
}

/**
 * Escape single quotes for a LanceDB `.where()` string literal. Core's
 * `escapeSql` is not on the barrel and the CLI may only import the barrel, so
 * this mirrors it. See the TODOS follow-up about hoisting the batched lookup
 * into core once `packages/core` is writable again.
 */
function escapeSqlLiteral(value: string): string {
  return value.replace(/'/g, "''");
}

/**
 * One predicate covering every (accountId, emailId) pair, or `undefined` when
 * there is nothing to look up.
 *
 * `accountId` is backticked because LanceDB's DataFusion parser folds unquoted
 * identifiers to lowercase, and the whole thing is one string because `.where()`
 * maps to `onlyIf`, which replaces rather than ANDs.
 */
export function buildEmailLookupFilter(refs: EmailRef[]): string | undefined {
  const byAccount = new Map<string, Set<string>>();
  for (const ref of refs) {
    const ids = byAccount.get(ref.accountId);
    if (ids) ids.add(ref.emailId);
    else byAccount.set(ref.accountId, new Set([ref.emailId]));
  }
  if (byAccount.size === 0) return undefined;

  const clauses: string[] = [];
  for (const [accountId, ids] of byAccount) {
    const idList = [...ids].map((id) => `'${escapeSqlLiteral(id)}'`).join(", ");
    clauses.push(
      `(\`accountId\` = '${escapeSqlLiteral(accountId)}' AND id IN (${idList}))`,
    );
  }
  return clauses.join(" OR ");
}

/**
 * The slice of a LanceDB table this module uses. Narrow on purpose: it is the
 * seam the tests open a real temp-directory table through, without the module
 * reaching for the user's actual `~/.email-agent` database.
 */
export interface EmailLookupTable {
  query(): {
    where(filter: string): { limit(n: number): { toArray(): Promise<unknown[]> } };
  };
}

async function openEmailsTable(): Promise<EmailLookupTable> {
  const db = await getDb();
  return (await db.openTable(emailsTable)) as unknown as EmailLookupTable;
}

/**
 * Batched replacement for one `getEmailById` per queued row.
 *
 * The approval list routinely holds dozens of operations across a handful of
 * emails; the per-row version walked the emails table once per distinct email.
 * This is a single scan, keyed back to `(accountId, emailId)` by the caller.
 *
 * Rows that are no longer in the local DB simply have no Map entry — callers
 * must treat a miss as "not in local DB", exactly as a `null` from
 * `getEmailById` meant before.
 *
 * `limit(UNLIMITED_QUERY_ROWS)`, NOT `limit(refs.length)` AND NOT NO LIMIT.
 *
 * `limit(refs.length)` was the first version, on the assumption that the table
 * holds at most one row per `(accountId, id)` pair. Nothing enforces that:
 * a duplicate silently eats a slot and the truncated scan then drops a
 * DIFFERENT pair's row, which the UI renders as "not in local DB" for an email
 * sitting right there.
 *
 * Dropping the limit entirely was the second version, and the comment justifying
 * it — that LanceDB's default limit of 10 applies to VECTOR searches only — was
 * FALSE and had never been checked. Verified on a real 25-row table against
 * 0.15.0 (2026-08-07): a plain `query().where(...).toArray()` returns ten rows.
 * That capped this lookup at 10 emails however many the queue referenced.
 *
 * So the scan is explicitly unbounded and the predicate is what bounds it. If
 * the table does hold two rows for one pair, the last one scanned wins; the
 * property that matters is that neither a duplicate nor a default can displace
 * another pair's row.
 */
export async function getEmailsByRefs(
  refs: EmailRef[],
  openTable: () => Promise<EmailLookupTable> = openEmailsTable,
): Promise<Map<string, EmailRecord>> {
  const filter = buildEmailLookupFilter(refs);
  const found = new Map<string, EmailRecord>();
  if (!filter) return found;

  const table = await openTable();
  const rows = (await table
    .query()
    .where(filter)
    .limit(UNLIMITED_QUERY_ROWS)
    .toArray()) as EmailRecord[];

  for (const row of rows) {
    found.set(emailRefKey(row.accountId, row.id), row);
  }
  return found;
}
