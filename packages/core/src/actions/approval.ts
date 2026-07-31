import { randomUUID } from "node:crypto";
import {
  savePendingOperations,
  getPendingOperationsByIds,
  resolvePendingOperations,
  type PendingOperationOutcome,
} from "../db/pending-operations.js";
import type { PendingOperationRecord } from "../db/schema.js";
import { applyOperations } from "./apply.js";
import type {
  ActionApplyResult,
  GmailOperation,
  GmailOperationType,
} from "./types.js";

export interface EnqueueOperationsInput {
  batchId: string;
  actionId: string;
  actionName: string;
  operations: GmailOperation[];
  createdAt?: string;
}

export function toPendingOperationRecords(
  input: EnqueueOperationsInput,
): PendingOperationRecord[] {
  const createdAt = input.createdAt ?? new Date().toISOString();
  return input.operations.map((op) => ({
    id: randomUUID(),
    batchId: input.batchId,
    actionId: input.actionId,
    actionName: input.actionName,
    // "" is the unscoped/gcloud sentinel; both an explicit "" and a missing
    // accountEmail resolve to the ADC fallback when the row is applied later.
    accountId: op.accountEmail ?? "",
    emailId: op.emailId,
    type: op.type,
    labelIds: JSON.stringify(op.labelIds ?? []),
    status: "pending",
    error: "",
    createdAt,
    resolvedAt: "",
  }));
}

export function recordToGmailOperation(
  record: PendingOperationRecord,
): GmailOperation {
  const labelIds = JSON.parse(record.labelIds) as string[];
  const operation: GmailOperation = {
    emailId: record.emailId,
    type: record.type as GmailOperationType,
    accountEmail: record.accountId,
  };
  if (labelIds.length > 0) operation.labelIds = labelIds;
  return operation;
}

/**
 * Persist a batch of Gmail operations awaiting the user's approval.
 * Returns the queue row ids, in operation order.
 */
export async function enqueueOperations(
  input: EnqueueOperationsInput,
): Promise<string[]> {
  const records = toPendingOperationRecords(input);
  await savePendingOperations(records);
  return records.map((record) => record.id);
}

/**
 * Applies queued operations the user approved, by queue row id.
 * Only rows still in "pending" state are applied; each row is marked
 * applied/failed afterwards. Returns the aggregate apply result.
 */
export async function applyPendingOperationsByIds(
  ids: string[],
): Promise<ActionApplyResult> {
  const rows = (await getPendingOperationsByIds(ids)).filter(
    (row) => row.status === "pending",
  );
  const result = await applyOperations(rows.map(recordToGmailOperation));

  const resolvedAt = new Date().toISOString();
  const outcomes: PendingOperationOutcome[] = rows.map((row, index) => {
    const outcome = result.outcomes[index];
    if (!outcome || outcome.ok) return { id: row.id, status: "applied" };
    return { id: row.id, status: "failed", error: outcome.error ?? "" };
  });
  await resolvePendingOperations(outcomes, resolvedAt);

  return result;
}

/**
 * Marks queued operations rejected (kept as an audit trail, never applied).
 * Returns the number of rows actually rejected.
 */
export async function rejectPendingOperationsByIds(
  ids: string[],
): Promise<number> {
  const rows = (await getPendingOperationsByIds(ids)).filter(
    (row) => row.status === "pending",
  );
  await resolvePendingOperations(
    rows.map((row) => ({ id: row.id, status: "rejected" as const })),
    new Date().toISOString(),
  );
  return rows.length;
}
