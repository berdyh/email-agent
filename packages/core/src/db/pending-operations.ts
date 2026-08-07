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

/**
 * `column IN (...)` over string values.
 *
 * `column` is a literal from this module, never user input — only the values
 * are escaped. camelCase columns must be backticked by the caller: LanceDB's
 * DataFusion parser folds unquoted identifiers to lowercase.
 */
export function buildInFilter(column: string, values: string[]): string {
  // `IN ()` is a parse error in DataFusion, so an empty list must never reach
  // the query builder — callers short-circuit before this point.
  if (values.length === 0) {
    throw new Error(`buildInFilter requires at least one value for ${column}`);
  }
  const quoted = values.map((value) => `'${escapeSql(value)}'`);
  return `${column} IN (${quoted.join(", ")})`;
}

export function buildIdListFilter(ids: string[]): string {
  if (ids.length === 0) {
    throw new Error("buildIdListFilter requires at least one id");
  }
  return buildInFilter("id", ids);
}

/**
 * Still-pending rows touching any of `emailIds` — the dedupe lookup for a new
 * enqueue, scoped to the emails in question rather than scanning the whole
 * queue.
 */
export function buildPendingEmailFilter(emailIds: string[]): string {
  return `status = 'pending' AND ${buildInFilter("`emailId`", emailIds)}`;
}

export async function getPendingOperationsForEmails(
  emailIds: string[],
): Promise<PendingOperationRecord[]> {
  if (emailIds.length === 0) return [];
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  const results = await table
    .query()
    .where(buildPendingEmailFilter(emailIds))
    .toArray();
  return results as unknown as PendingOperationRecord[];
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
 * Callers: `GET /api/approvals/stranded` (rendered by `StrandedOperationsPanel`
 * on the web Actions page) and `email-agent approvals stranded`. Both LIST the
 * rows and ask the user to adjudicate them through
 * `resolveStrandedApplyingOperations`; neither re-applies anything.
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

/**
 * Rows a stranded-row adjudication may touch: `applying` and nothing else.
 *
 * Scoping this to `applying` is what stops an adjudication from reaching a
 * healthy row. The ids come from a surface's own stale-list snapshot, and by
 * the time the user answers, an apply that was merely slow may have finished
 * and written the row `applied` or `failed` — overwriting that with the user's
 * guess would destroy a fact with an opinion.
 */
export function buildStrandedClaimFilter(ids: string[]): string {
  return `${buildIdListFilter(ids)} AND status = 'applying'`;
}

/**
 * Records the user's judgement about rows a crash left mid-apply.
 *
 * THIS VERIFIES NOTHING. It contacts neither Gmail nor the mailbox; it writes
 * down what the person told us they saw. `applied` means "the user reports the
 * change is in Gmail"; `pending` means "the user reports it is not, put it back
 * in the approval queue so it can be approved again". Nothing else may be
 * offered here without a real check, and there is no real check — Gmail message
 * state is not a reliable witness to whether *this* operation caused it.
 *
 * Claim-then-write, so it can only ever rewrite rows it personally won: stamp a
 * fresh token onto the still-`applying` rows, read back by that token to learn
 * which they were, then write the final state scoped to the same token. The
 * returned rows are exactly the ones this call changed.
 */
export async function resolveStrandedApplyingOperations(
  ids: string[],
  token: string,
  values: Partial<
    Pick<PendingOperationRecord, "status" | "error" | "resolvedAt" | "claimedAt">
  >,
): Promise<PendingOperationRecord[]> {
  if (ids.length === 0) return [];
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);

  await table.update({
    where: buildStrandedClaimFilter(ids),
    values: { claimToken: token },
  });
  const won = (await table
    .query()
    .where(buildClaimFilter(token, "applying"))
    .toArray()) as unknown as PendingOperationRecord[];
  if (won.length === 0) return [];

  await table.update({
    where: buildClaimFilter(token, "applying"),
    // The token is cleared with the same write that resolves the row: a row
    // that is no longer `applying` has no lease, and leaving one behind would
    // make a later `buildClaimFilter` read match a row it does not own.
    values: { ...values, claimToken: "" },
  });
  return won;
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

/**
 * Statuses a retention sweep may delete.
 *
 * `pending` and `applying` are excluded because they are unresolved: pruning a
 * pending row silently discards a change the user was never asked about, and
 * pruning an `applying` row destroys the only evidence that a Gmail mutation
 * may have landed without being recorded.
 *
 * `failed` is excluded too, deliberately. It looks resolved, but it is the
 * diagnostic record of an attempted mutation whose outcome the user may still
 * be chasing — and failed rows are rare, so keeping them forever costs nothing
 * that pruning `applied`/`rejected` does not already recover.
 */
export const PRUNABLE_STATUSES = ["applied", "rejected"] as const;

/**
 * Rows resolved strictly before `olderThanIso`.
 *
 * `resolvedAt` holds `Date#toISOString()` output — fixed-width UTC with a
 * trailing `Z` — which orders lexicographically exactly as it orders
 * chronologically, so a string comparison is a date comparison here. The
 * explicit `!= ''` guard matters because "" sorts before every real timestamp
 * and would otherwise sweep away any unresolved row that slipped into a
 * prunable status.
 */
export function buildPruneFilter(olderThanIso: string): string {
  const statuses = PRUNABLE_STATUSES.map(
    (status) => `'${escapeSql(status)}'`,
  ).join(", ");
  return [
    `status IN (${statuses})`,
    "`resolvedAt` != ''",
    `\`resolvedAt\` < '${escapeSql(olderThanIso)}'`,
  ].join(" AND ");
}

/**
 * Deletes resolved queue rows older than `olderThanIso`. Without this the table
 * is append-only for the life of the install and every approvals query scans
 * the whole history.
 *
 * The returned count is ADVISORY. It is the count taken BEFORE the delete, so a
 * concurrent sweep or a row resolved between the count and the delete makes it
 * drift from the number of rows this call actually removed. Nothing consumes it
 * for correctness — it exists for logging and tests. Do not build a check on
 * it; re-count if you need a true figure.
 */
export async function prunePendingOperations(
  olderThanIso: string,
): Promise<number> {
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  const filter = buildPruneFilter(olderThanIso);
  // Count first: a LanceDB delete rewrites the table, so a no-op sweep should
  // not pay for one. This runs after every apply/reject, where nothing to
  // prune is the common case.
  const doomed = await table.countRows(filter);
  if (doomed === 0) return 0;
  await table.delete(filter);
  return doomed;
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
