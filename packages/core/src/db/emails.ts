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

/** One (account, message) pair. Gmail message ids are per-mailbox. */
export interface EmailRef {
  accountId: string;
  id: string;
}

/**
 * Stable Map key for an (accountId, id) pair, separated by NUL because NUL
 * cannot occur in either half.
 *
 * The separator is written as the `\u0000` ESCAPE, never as a literal NUL byte:
 * a literal one makes git classify the file as binary, so `git diff` prints
 * `Bin 0 -> N bytes` instead of a patch and the file reaches review unread.
 * That happened once already, to both surface copies of this code at the same
 * time.
 */
export function emailRefKey(accountId: string, id: string): string {
  return `${accountId}\u0000${id}`;
}

/**
 * One predicate covering every (accountId, id) pair, or `undefined` when there
 * is nothing to look up.
 *
 * Two LanceDB rules are load-bearing:
 *  - DataFusion folds unquoted identifiers to lowercase, so `accountId` must be
 *    backticked or the query dies with `No field named accountid`.
 *  - `.where()` maps to `onlyIf` and REPLACES the previous predicate, so this
 *    has to be one combined string; it can never be chained.
 *
 * Grouped BY ACCOUNT for the same reason `buildEmailReplacementFilter` is:
 * `accountId IN (...) AND id IN (...)` is a cross product that matches pairs
 * the caller never named.
 */
export function buildEmailLookupFilter(
  refs: ReadonlyArray<EmailRef>,
): string | undefined {
  const byAccount = new Map<string, Set<string>>();
  for (const ref of refs) {
    const ids = byAccount.get(ref.accountId);
    if (ids) ids.add(ref.id);
    else byAccount.set(ref.accountId, new Set([ref.id]));
  }
  if (byAccount.size === 0) return undefined;

  const clauses: string[] = [];
  for (const [accountId, ids] of byAccount) {
    const idList = [...ids].map((id) => `'${escapeSql(id)}'`).join(", ");
    clauses.push(
      `(\`accountId\` = '${escapeSql(accountId)}' AND id IN (${idList}))`,
    );
  }
  return clauses.join(" OR ");
}

/**
 * The slice of a LanceDB table this lookup uses. Narrow on purpose: it is the
 * seam the tests open a real temp-directory table through, without the module
 * reaching for the user's actual `~/.email-agent` database. It is also the only
 * way to build the duplicate-`(accountId, id)` case, which `upsertEmails`
 * replaces and therefore cannot produce.
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
 * ONE COPY, IN CORE. This lived in `packages/web/src/modules/api/email-lookup.ts`
 * and `packages/cli/src/email-lookup.ts` at once, hand-copied `escapeSql` and
 * all, because core belonged to another branch when the approval surfaces
 * needed it. Two copies of a LanceDB predicate builder is exactly the shape that
 * drifts, and it went wrong in both copies simultaneously TWICE: once with
 * `limit(refs.length)`, and once with no limit at all behind a comment asserting
 * — falsely, and unchecked — that LanceDB's default limit applies to vector
 * searches only.
 *
 * The approval list routinely holds dozens of operations across a handful of
 * emails; the per-row version walked the emails table once per distinct email.
 * This is a single scan, keyed back to `(accountId, id)` by the caller.
 *
 * Rows no longer in the local DB simply have no Map entry — callers must treat a
 * miss as "not in local DB", exactly as a `null` from `getEmailById` meant.
 *
 * `limit(UNLIMITED_QUERY_ROWS)`, NOT `limit(refs.length)` and NOT no limit.
 * `limit(refs.length)` assumes one row per pair and nothing enforces that: a
 * duplicate eats a slot and the truncated scan drops a DIFFERENT pair's row,
 * which the UI renders as "not in local DB" for an email sitting right there. No
 * limit at all is ten rows (verified on a real 25-row table against
 * `@lancedb/lancedb` 0.15.0, 2026-08-07). So the scan is explicitly unbounded
 * and the predicate is what bounds it. If the table does hold two rows for one
 * pair the last one scanned wins; the property that matters is that neither a
 * duplicate nor a default can displace another pair's row.
 */
export async function getEmailsByIds(
  refs: ReadonlyArray<EmailRef>,
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
