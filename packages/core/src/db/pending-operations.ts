import { getDb } from "./connection.js";
import {
  pendingOperationsTable,
  type PendingOperationRecord,
  type PendingOperationStatus,
} from "./schema.js";
import { escapeSql } from "./utils.js";

export function buildPendingOperationFilters(options?: {
  status?: PendingOperationStatus;
  batchId?: string;
  accountId?: string;
}): string[] {
  const filters: string[] = [];
  if (options?.status) {
    filters.push(`status = '${escapeSql(options.status)}'`);
  }
  if (options?.batchId !== undefined) {
    filters.push(`\`batchId\` = '${escapeSql(options.batchId)}'`);
  }
  if (options?.accountId !== undefined) {
    filters.push(`\`accountId\` = '${escapeSql(options.accountId)}'`);
  }
  return filters;
}

export function buildIdListFilter(ids: string[]): string {
  // `id IN ()` is a parse error in DataFusion, so an empty list must never
  // reach the query builder — callers short-circuit before this point.
  if (ids.length === 0) {
    throw new Error("buildIdListFilter requires at least one id");
  }
  const quoted = ids.map((id) => `'${escapeSql(id)}'`);
  return `id IN (${quoted.join(", ")})`;
}

/**
 * Resolution is only ever valid for a row that is still pending. Carrying the
 * status into the update predicate keeps two concurrent resolvers (two browser
 * tabs, the CLI racing the web UI) from overwriting each other's decision —
 * notably from flipping a row the user just rejected back to "applied".
 */
export function buildPendingResolutionFilter(ids: string[]): string {
  return `${buildIdListFilter(ids)} AND status = 'pending'`;
}

export function buildClaimFilter(token: string, status: string): string {
  return `\`claimToken\` = '${escapeSql(token)}' AND status = '${escapeSql(status)}'`;
}

/**
 * Atomically moves rows from `pending` to `status`, stamping them with this
 * attempt's `token`. LanceDB's update() reports no row count, so the caller
 * MUST read back by token to learn which rows it actually won — a concurrent
 * apply or reject may have taken some of them first.
 */
export async function claimPendingOperations(
  ids: string[],
  token: string,
  status: Exclude<PendingOperationStatus, "pending">,
  resolvedAt = "",
  claimedAt = new Date().toISOString(),
): Promise<PendingOperationRecord[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);

  // `claimedAt` is stamped for every claim, not just `applying`. It records
  // when the row left `pending`, which is the only correct age basis for
  // spotting a row stranded by a crash mid-apply — `createdAt` is when the
  // change was proposed and can be arbitrarily older.
  await table.update({
    where: buildPendingResolutionFilter(ids),
    values: { status, claimToken: token, resolvedAt, claimedAt },
  });

  const results = await table
    .query()
    .where(buildClaimFilter(token, status))
    .toArray();
  return results as unknown as PendingOperationRecord[];
}

export async function savePendingOperations(
  records: PendingOperationRecord[],
): Promise<void> {
  if (records.length === 0) return;
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  await table.add(records);
}

export async function getPendingOperations(options?: {
  status?: PendingOperationStatus;
  batchId?: string;
  accountId?: string;
  limit?: number;
}): Promise<PendingOperationRecord[]> {
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  let query = table.query();
  // One combined predicate — chained .where() calls REPLACE rather than AND
  // (see the same note in emails.ts), which would drop the status filter.
  const filters = buildPendingOperationFilters(options);
  if (filters.length > 0) {
    query = query.where(filters.join(" AND "));
  }
  // Fetch all matching rows, sort newest-batch-first, then slice. LanceDB
  // applies limit before this JS sort, so limiting in-query would return an
  // arbitrary N rows rather than the most recent N.
  const results = await query.toArray();
  const records = results as unknown as PendingOperationRecord[];
  // Every row in a batch shares one createdAt, so tie-break on batchId then id
  // for a total order — otherwise rows from two batches queued in the same
  // millisecond interleave and the grouped display repeats batch headers.
  records.sort((a, b) => {
    const byDate =
      new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime();
    if (byDate !== 0) return byDate;
    if (a.batchId !== b.batchId) return a.batchId < b.batchId ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });
  return options?.limit ? records.slice(0, options.limit) : records;
}

/**
 * How long a row may sit in `applying` before it is treated as stranded.
 *
 * A healthy apply moves a row out of `applying` within one Gmail round trip
 * (chunked resolution keeps that to a handful of operations), so anything
 * still claimed after this long means the process died between the Gmail call
 * and the status write.
 */
export const STALE_APPLYING_THRESHOLD_MS = 15 * 60 * 1000;

/**
 * Rows claimed before `cutoffIso` and never resolved. Pure, so the age rule is
 * testable without a DB.
 *
 * Age is measured from `claimedAt`, falling back to `createdAt` for rows
 * migrated in from a table that predates the column — those have no recorded
 * claim time, and `createdAt` is necessarily older, so they surface rather
 * than hide.
 */
export function selectStaleApplyingOperations(
  rows: readonly PendingOperationRecord[],
  cutoffIso: string,
): PendingOperationRecord[] {
  const cutoff = new Date(cutoffIso).getTime();
  return rows.filter((row) => {
    if (row.status !== "applying") return false;
    const stamp = row.claimedAt || row.createdAt;
    const claimed = new Date(stamp).getTime();
    // An unparsable timestamp must surface, not hide: a row we cannot age is
    // exactly the row a crash left behind.
    if (Number.isNaN(claimed)) return true;
    return claimed <= cutoff;
  });
}

/**
 * Rows a crash left stranded mid-apply.
 *
 * The claim/lease means such a row is `applying`, not `pending`, so it can
 * never be silently re-applied — but it is also invisible to every surface,
 * which all list `status: "pending"`. Its Gmail mutation may or may not have
 * landed, so this is deliberately a *report*, not an auto-retry: only the user
 * can decide whether the change went through.
 *
 * Approval surfaces should call this and offer the rows for review; see
 * TODOS.md ("Recover rows stranded in `applying`").
 */
export async function getStaleApplyingOperations(options?: {
  olderThanMs?: number;
  now?: Date;
  accountId?: string;
}): Promise<PendingOperationRecord[]> {
  const olderThanMs = options?.olderThanMs ?? STALE_APPLYING_THRESHOLD_MS;
  const now = options?.now ?? new Date();
  const cutoffIso = new Date(now.getTime() - olderThanMs).toISOString();
  const rows = await getPendingOperations({
    status: "applying",
    ...(options?.accountId !== undefined
      ? { accountId: options.accountId }
      : {}),
  });
  return selectStaleApplyingOperations(rows, cutoffIso);
}

export async function getPendingOperationsByIds(
  ids: string[],
): Promise<PendingOperationRecord[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  const results = await table.query().where(buildIdListFilter(ids)).toArray();
  return results as unknown as PendingOperationRecord[];
}

export async function countPendingOperations(
  status: PendingOperationStatus = "pending",
): Promise<number> {
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  return table.countRows(`status = '${escapeSql(status)}'`);
}

export interface PendingOperationOutcome {
  id: string;
  status: Exclude<PendingOperationStatus, "pending">;
  error?: string;
}

/**
 * Finalizes rows this attempt claimed. Every predicate is scoped to the claim
 * token, so a resolver can only ever write rows it owns.
 */
export async function resolveClaimedOperations(
  outcomes: PendingOperationOutcome[],
  token: string,
  resolvedAt: string,
): Promise<void> {
  if (outcomes.length === 0) return;
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);

  const claimScope = buildClaimFilter(token, "applying");
  const idsByStatus = new Map<string, string[]>();
  const individual: PendingOperationOutcome[] = [];
  for (const outcome of outcomes) {
    if (outcome.error) {
      individual.push(outcome);
    } else {
      const ids = idsByStatus.get(outcome.status) ?? [];
      ids.push(outcome.id);
      idsByStatus.set(outcome.status, ids);
    }
  }

  for (const [status, ids] of idsByStatus) {
    await table.update({
      where: `${buildIdListFilter(ids)} AND ${claimScope}`,
      values: { status, error: "", resolvedAt },
    });
  }
  for (const outcome of individual) {
    await table.update({
      where: `${buildIdListFilter([outcome.id])} AND ${claimScope}`,
      values: {
        status: outcome.status,
        error: outcome.error ?? "",
        resolvedAt,
      },
    });
  }
}
