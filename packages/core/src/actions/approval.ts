import { randomUUID } from "node:crypto";
import {
  savePendingOperations,
  claimPendingOperations,
  resolveClaimedOperations,
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
    claimToken: "",
    createdAt,
    claimedAt: "",
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
  // CLAIM BEFORE MUTATING. Rows are moved out of `pending` and stamped with
  // this attempt's token *before* any Gmail call, and only the rows we actually
  // won come back. Without this, a Reject issued while an apply was in flight
  // would succeed against still-pending rows, be reported to the user as
  // honored, and then be silently overwritten as the apply completed — mail
  // destroyed after the user personally refused it, which is the exact failure
  // this whole feature exists to prevent.
  const token = randomUUID();
  const rows = await claimPendingOperations(ids, token, "applying");
  if (rows.length === 0) {
    return { applied: 0, failed: 0, errors: [], outcomes: [] };
  }

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
  await resolveClaimedOperations(outcomes, token, resolvedAt);

  return result;
}

/**
 * Marks queued operations rejected (kept as an audit trail, never applied).
 * Returns the number of rows actually rejected.
 */
export async function rejectPendingOperationsByIds(
  ids: string[],
): Promise<number> {
  // Same claim discipline: only rows still `pending` are rejected, and the
  // count is the number actually won — never a pre-read count that might
  // include rows an in-flight apply already claimed. Telling a user their
  // rejection covered a change that was concurrently being applied would be
  // the same lie from the other direction.
  const claimed = await claimPendingOperations(
    ids,
    randomUUID(),
    "rejected",
    new Date().toISOString(),
  );
  return claimed.length;
}
