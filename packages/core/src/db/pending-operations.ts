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
  const quoted = ids.map((id) => `'${escapeSql(id)}'`);
  return `id IN (${quoted.join(", ")})`;
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
  for (const f of buildPendingOperationFilters(options)) {
    query = query.where(f);
  }
  // Fetch all matching rows, sort newest-batch-first, then slice. LanceDB
  // applies limit before this JS sort, so limiting in-query would return an
  // arbitrary N rows rather than the most recent N.
  const results = await query.toArray();
  const records = results as unknown as PendingOperationRecord[];
  records.sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
  );
  return options?.limit ? records.slice(0, options.limit) : records;
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

export async function resolvePendingOperations(
  outcomes: PendingOperationOutcome[],
  resolvedAt: string,
): Promise<void> {
  if (outcomes.length === 0) return;
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);

  // Batch the error-free outcomes per status into one update each; failed
  // outcomes carry distinct error messages and update row-by-row.
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
      where: buildIdListFilter(ids),
      values: { status, error: "", resolvedAt },
    });
  }
  for (const outcome of individual) {
    await table.update({
      where: buildIdListFilter([outcome.id]),
      values: {
        status: outcome.status,
        error: outcome.error ?? "",
        resolvedAt,
      },
    });
  }
}
