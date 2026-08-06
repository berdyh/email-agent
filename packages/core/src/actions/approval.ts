import { randomUUID } from "node:crypto";
import {
  savePendingOperations,
  claimPendingOperations,
  getPendingOperationsForEmails,
  prunePendingOperations,
  resolveClaimedOperations,
  type PendingOperationOutcome,
} from "../db/pending-operations.js";
import type { PendingOperationRecord } from "../db/schema.js";
import { loadSettings } from "../config/settings.js";
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
 * Identity of a proposed Gmail change, for dedupe purposes.
 *
 * Account, message, operation type and labels all participate: "archive m1"
 * and "add label Work to m1" are different proposals, and the same message id
 * in two accounts is two different messages. Labels are sorted so two
 * orderings of the same set collapse. Built with `JSON.stringify` rather than
 * a delimiter join so a value containing the delimiter cannot forge a
 * collision.
 */
export function operationDedupeKey(record: PendingOperationRecord): string {
  return JSON.stringify([
    record.accountId,
    record.emailId,
    record.type,
    [...parseLabelIds(record.labelIds)].sort(),
  ]);
}

/**
 * Indexes of `records` that are not already awaiting approval.
 *
 * Deduping is deliberately scoped to rows that are still PENDING. A
 * re-proposal after a rejection is legitimate — the user said no to one
 * instance, and suppressing the next one would hide the proposal entirely,
 * leaving them no way to see or act on it. The same argument covers `applied`:
 * the state that justified the change can recur (mail restored from Trash, a
 * label re-added), and a queue row is a proposal, not a mutation. What is
 * never useful is two identical rows sitting in the pending list at once,
 * which is exactly what re-running an action over the same unread mail before
 * approving produced.
 *
 * Duplicates inside the incoming batch are collapsed too, keeping the first.
 */
export function selectNewOperationIndexes(
  records: readonly PendingOperationRecord[],
  existingKeys: ReadonlySet<string>,
): number[] {
  const seen = new Set(existingKeys);
  const kept: number[] = [];
  records.forEach((record, index) => {
    const key = operationDedupeKey(record);
    if (seen.has(key)) return;
    seen.add(key);
    kept.push(index);
  });
  return kept;
}

export interface EnqueueOperationsResult {
  /** Queue row ids actually written, in operation order. */
  ids: string[];
  /** The subset of the input operations those rows represent. */
  operations: GmailOperation[];
  /** How many proposals were dropped as already awaiting approval. */
  duplicates: number;
}

/**
 * Persist a batch of Gmail operations awaiting the user's approval, skipping
 * proposals identical to one already queued and unapproved.
 */
export async function enqueueOperationsDetailed(
  input: EnqueueOperationsInput,
): Promise<EnqueueOperationsResult> {
  const records = toPendingOperationRecords(input);
  if (records.length === 0) return { ids: [], operations: [], duplicates: 0 };

  // Scoped to the emails in this batch rather than reading the whole queue.
  const existing = await getPendingOperationsForEmails([
    ...new Set(records.map((record) => record.emailId)),
  ]);
  const existingKeys = new Set(existing.map(operationDedupeKey));
  const keep = selectNewOperationIndexes(records, existingKeys);

  const kept = keep.map((index) => records[index] as PendingOperationRecord);
  await savePendingOperations(kept);
  return {
    ids: kept.map((record) => record.id),
    operations: keep.map((index) => input.operations[index] as GmailOperation),
    duplicates: records.length - kept.length,
  };
}

/**
 * Persist a batch of Gmail operations awaiting the user's approval.
 * Returns the queue row ids, in operation order. Proposals identical to a row
 * already pending are skipped, so this can be shorter than `input.operations`.
 */
export async function enqueueOperations(
  input: EnqueueOperationsInput,
): Promise<string[]> {
  const result = await enqueueOperationsDetailed(input);
  return result.ids;
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Cutoff timestamp for a retention sweep, or null when retention is disabled.
 *
 * A non-finite or non-positive window disables pruning rather than pruning
 * everything — the failure direction for a misconfigured retention value must
 * be "keep too much", because the rows are the audit trail of real Gmail
 * mutations and cannot be reconstructed.
 */
export function resolveRetentionCutoff(
  days: number | undefined,
  now: Date = new Date(),
): string | null {
  if (days === undefined || !Number.isFinite(days) || days <= 0) return null;
  return new Date(now.getTime() - days * MS_PER_DAY).toISOString();
}

/**
 * Opportunistic retention sweep, run after a batch is resolved — the moment
 * the table just grew, and the only routine point where the queue is already
 * being written.
 *
 * Never throws: a housekeeping failure must not turn a successful approval
 * into a reported failure, which would tell the user their Gmail changes did
 * not happen when they did.
 */
async function pruneResolvedOperationsQuietly(): Promise<void> {
  try {
    const settings = await loadSettings();
    const cutoff = resolveRetentionCutoff(settings.retention?.approvalQueueDays);
    if (cutoff === null) return;
    await prunePendingOperations(cutoff);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`Failed to prune resolved approval-queue rows: ${message}`);
  }
}

/**
 * How many claimed rows are applied before their outcomes are written back.
 *
 * Status used to be written once, after every Gmail call in the batch had
 * completed, so a crash anywhere in a 200-operation batch left all 200 rows
 * saying "applying" while up to 200 mailbox changes had really happened. The
 * other extreme — one status write per operation — closes that window
 * completely but costs one LanceDB update per row, and a LanceDB update
 * rewrites the table.
 *
 * 10 is the compromise. `applyOperations` awaits one Gmail round trip per
 * operation (~100-300ms each), so a chunk is roughly 1-3s of exposure
 * regardless of how large the batch is, while the number of table rewrites
 * stays at batch/10 instead of batch. Approval batches in practice are tens
 * of rows, so this is usually 1-3 rewrites total.
 */
export const APPLY_RESOLUTION_CHUNK_SIZE = 10;

/** Splits a list into fixed-size chunks, preserving order. */
export function chunkList<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunkList requires a chunk size of at least 1");
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

/**
 * Maps one chunk's Gmail outcomes onto queue-row resolutions.
 *
 * Fails CLOSED. `applyOperations` returns one outcome per input operation, in
 * order, so a missing entry means that contract broke — never assume the Gmail
 * mutation happened. Recording it "applied" would retire the row from the
 * queue and silently drop a change the user approved.
 */
export function toOperationOutcomes(
  rows: readonly PendingOperationRecord[],
  result: ActionApplyResult,
): PendingOperationOutcome[] {
  return rows.map((row, index) => {
    const outcome = result.outcomes[index];
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
}

/**
 * Concatenates per-chunk apply results back into one batch result. Chunks are
 * processed in order, so concatenating outcomes preserves the caller's input
 * ordering, which `toOperationOutcomes` and every surface rely on.
 */
export function mergeApplyResults(
  results: readonly ActionApplyResult[],
): ActionApplyResult {
  const merged: ActionApplyResult = {
    applied: 0,
    failed: 0,
    errors: [],
    outcomes: [],
  };
  for (const result of results) {
    merged.applied += result.applied;
    merged.failed += result.failed;
    merged.errors.push(...result.errors);
    merged.outcomes.push(...result.outcomes);
  }
  return merged;
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

  // Apply and resolve in chunks rather than mutating the whole batch and then
  // writing every status at the end. A crash (or a LanceDB failure) can now
  // strand at most one chunk in `applying`, instead of the entire batch.
  const results: ActionApplyResult[] = [];
  for (const rowChunk of chunkList(rows, APPLY_RESOLUTION_CHUNK_SIZE)) {
    const chunkResult = await applyOperations(
      rowChunk.map(recordToGmailOperation),
    );
    results.push(chunkResult);
    // Deliberately NOT wrapped: if outcomes cannot be recorded, stop rather
    // than keep mutating mail whose fate we are unable to write down. The
    // unprocessed rows stay claimed and surface via
    // `getStaleApplyingOperations()`.
    await resolveClaimedOperations(
      toOperationOutcomes(rowChunk, chunkResult),
      token,
      new Date().toISOString(),
    );
  }

  await pruneResolvedOperationsQuietly();
  return mergeApplyResults(results);
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
  await pruneResolvedOperationsQuietly();
  return claimed.length;
}
