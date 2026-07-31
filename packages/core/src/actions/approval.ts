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

/**
 * Human-readable label for a proposed Gmail change. This is the sentence the
 * user reads before approving an irreversible mutation, so it lives in core and
 * is shared by every approval surface — a CLI/web copy that drifted would
 * describe the same queued row two different ways.
 */
export function describeGmailOperation(
  type: string,
  labelIds: string[] = [],
): string {
  switch (type) {
    case "trash":
      return "Move to Trash";
    case "spam":
      return "Mark as Spam";
    case "markRead":
      return "Mark as Read";
    case "markUnread":
      return "Mark as Unread";
    case "removeLabels":
      return labelIds.length === 1 && labelIds[0] === "INBOX"
        ? "Archive"
        : `Remove labels: ${labelIds.join(", ")}`;
    case "addLabels":
      return `Add labels: ${labelIds.join(", ")}`;
    default:
      return type;
  }
}

/** True for operations that hide or destroy mail, which warrant extra confirmation. */
export function isDestructiveOperation(type: string): boolean {
  return type === "trash" || type === "spam";
}

/**
 * Queue rows are read back from disk and may predate the current build, so a
 * malformed `labelIds` must not take down the whole approval list — a single
 * unparsable row would otherwise 500 the approvals route and hide every other
 * queued change from review.
 */
export function parseLabelIds(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

export function recordToGmailOperation(
  record: PendingOperationRecord,
): GmailOperation {
  const labelIds = parseLabelIds(record.labelIds);
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
    // Fail CLOSED. `applyOperations` returns one outcome per input operation,
    // in order, so a missing entry means that contract broke — never assume
    // the Gmail mutation happened. Recording it "applied" would retire the row
    // from the queue and silently drop a change the user approved.
    if (!outcome) {
      return {
        id: row.id,
        status: "failed",
        error: "No apply outcome was recorded for this operation",
      };
    }
    if (outcome.ok) return { id: row.id, status: "applied" };
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
