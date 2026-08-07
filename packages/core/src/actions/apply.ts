import {
  markAsRead,
  markAsUnread,
  trashMessage,
  markAsSpam,
  addLabels,
  removeLabels,
} from "../gmail/operations.js";
import type {
  ActionEmailResult,
  GmailOperation,
  ActionApplyResult,
  OperationOutcome,
} from "./types.js";

export type OperationAccountLookup = ReadonlyMap<string, string | null>;

export function buildOperationAccountLookup(
  emails: Array<{ id: string; accountId: string }>,
): OperationAccountLookup {
  const accountByEmailId = new Map<string, string | null>();

  for (const email of emails) {
    const existing = accountByEmailId.get(email.id);
    if (existing === undefined) {
      accountByEmailId.set(email.id, email.accountId);
    } else if (existing !== email.accountId) {
      accountByEmailId.set(email.id, null);
    }
  }

  return accountByEmailId;
}

export function scopeOperationsToAccounts(
  operations: GmailOperation[],
  accountEmail?: string,
  accountEmailByMessageId?: OperationAccountLookup,
): GmailOperation[] {
  return operations.map((op) => {
    if (accountEmailByMessageId) {
      if (!accountEmailByMessageId.has(op.emailId)) {
        throw new Error(
          `Cannot apply Gmail operation for message ${op.emailId}; the message id was not in the action batch`,
        );
      }

      const lookupAccountEmail = accountEmailByMessageId.get(op.emailId);
      if (lookupAccountEmail === null) {
        throw new Error(
          `Cannot apply Gmail operation for message ${op.emailId}; the message id exists in multiple accounts`,
        );
      }

      if (op.accountEmail !== undefined) return op;
      return { ...op, accountEmail: accountEmail ?? lookupAccountEmail };
    }

    if (op.accountEmail !== undefined) return op;
    if (accountEmail !== undefined) return { ...op, accountEmail };
    return op;
  });
}

/**
 * Maps action output results to concrete Gmail operations.
 * Each action type has its own mapping logic based on the AI's output fields.
 */
export function mapResultToOperations(
  actionId: string,
  results: ActionEmailResult[],
): GmailOperation[] {
  const operations: GmailOperation[] = [];

  for (const result of results) {
    const ops = mapSingleResult(actionId, result);
    operations.push(...ops);
  }

  return operations;
}

function mapSingleResult(
  actionId: string,
  result: ActionEmailResult,
): GmailOperation[] {
  switch (actionId) {
    case "junk":
      return mapJunkResult(result);
    case "subscription":
      return mapSubscriptionResult(result);
    default:
      return [];
  }
}

function mapJunkResult(result: ActionEmailResult): GmailOperation[] {
  const recommendation = result["recommendation"] as string | undefined;
  if (!recommendation) return [];

  switch (recommendation) {
    case "delete":
      return [{ emailId: result.emailId, type: "trash" }];
    case "spam":
      return [{ emailId: result.emailId, type: "spam" }];
    case "archive":
      return [
        { emailId: result.emailId, type: "removeLabels", labelIds: ["INBOX"] },
      ];
    default:
      return [];
  }
}

function mapSubscriptionResult(result: ActionEmailResult): GmailOperation[] {
  const isSubscription = result["isSubscription"] as boolean | undefined;
  const category = result["category"] as string | undefined;

  if (!isSubscription) return [];

  // Marketing emails that aren't digest-worthy → archive
  if (category === "marketing" && !result["digestWorthy"]) {
    return [
      { emailId: result.emailId, type: "removeLabels", labelIds: ["INBOX"] },
    ];
  }

  return [];
}

/**
 * Executes Gmail operations, collecting successes and failures.
 *
 * Never throws: every operation is attempted and each failure is recorded as an
 * outcome. `outcomes` has exactly one entry per input operation, IN THE SAME
 * ORDER — `toOperationOutcomes` in `actions/approval.ts` pairs it positionally
 * with the claimed queue rows, so mispairing would write one message's result
 * onto another message's row. Any change here must keep that alignment.
 *
 * ONE ROUND TRIP PER OPERATION, SERIALLY. That is a known cost — approving a
 * large batch is N awaited network calls with the approval surface blocked —
 * and it is left that way for now. Both faster shapes were examined:
 *
 * `messages.batchModify` is REJECTED, not deferred. It returns an empty
 * success with **no per-message result**, so N rows would have to collapse onto
 * one all-or-nothing status: on a partial failure we would either retire rows
 * as applied without evidence, or mark rows failed that really were mutated.
 * That is precisely the ambiguity `toOperationOutcomes` fails closed on. It
 * also does not cover `trash` — `messages.batchDelete` is PERMANENT deletion,
 * a different and far more destructive operation, and must never be
 * substituted — and only operations sharing an identical (account,
 * addLabelIds, removeLabelIds) tuple can share a call, so the typical junk
 * batch (trash + spam + archive interleaved) fragments into single-operation
 * calls anyway.
 *
 * A bounded concurrency pool is DEFERRED, and the shape it must take is already
 * clear. Ordering is the easy part (fill a pre-sized outcome array by index).
 * Three things gate it, none of them in this branch's scope:
 * - **Same-message ordering.** The queue can hold several pending operations
 *   for one message; dedupe only collapses identical ones. Serial execution
 *   applies them in queue order — the order the user reviewed — while a pool
 *   would race, say, `addLabels X` against `removeLabels X` and leave a
 *   nondeterministic final state. A pool must therefore partition by
 *   (account, message) and stay serial inside a partition.
 * - **A failure is terminal here.** There is no retry and no backoff: an error
 *   becomes a `failed` queue row, which is not `pending` and so can never be
 *   approved again — the user must re-run the action to re-propose the change.
 *   Concurrency raises the rate of transient rate-limit and 5xx responses, so
 *   without backoff it trades latency for a higher chance of permanently
 *   dropping a change the user explicitly approved. Wrong direction for a
 *   feature whose whole point is that approved means approved.
 * - **No test seam and no measurement.** This function imports the write
 *   operations directly, so a pool cannot be tested without injecting them, and
 *   no live Gmail timing has ever been taken here — the ~100-300ms per round
 *   trip quoted at `APPLY_RESOLUTION_CHUNK_SIZE` is an estimate.
 *
 * How a pool would interact with the chunked apply, since that is the part
 * easiest to get wrong: it must live strictly INSIDE one chunk. Chunk rows are
 * claimed, applied and resolved as a unit, and this function returns an outcome
 * per operation instead of throwing, so parallelism within the chunk leaves
 * that unit intact — a mid-chunk failure still resolves the whole chunk and
 * strands nothing extra. A pool spanning chunks would put more than one chunk
 * in flight at once and reinstate exactly the "claimed set is larger than the
 * in-flight set" problem that moving the claim inside the loop was introduced
 * to fix.
 */
export async function applyOperations(
  operations: GmailOperation[],
  accountEmail?: string,
): Promise<ActionApplyResult> {
  let applied = 0;
  let failed = 0;
  const errors: Array<{ emailId: string; error: string }> = [];
  const outcomes: OperationOutcome[] = [];

  for (const op of operations) {
    const operationAccountEmail = op.accountEmail ?? accountEmail;
    try {
      switch (op.type) {
        case "trash":
          await trashMessage(op.emailId, operationAccountEmail);
          break;
        case "spam":
          await markAsSpam(op.emailId, operationAccountEmail);
          break;
        case "markRead":
          await markAsRead(op.emailId, operationAccountEmail);
          break;
        case "markUnread":
          await markAsUnread(op.emailId, operationAccountEmail);
          break;
        // A label operation with no labels, or an operation type this build
        // does not know, must NOT count as applied: the queue would retire the
        // row as a completed Gmail mutation that never happened. Approved
        // instructions are only ever discarded loudly.
        case "addLabels":
          if (!op.labelIds?.length) {
            throw new Error("addLabels operation carries no label ids");
          }
          await addLabels(op.emailId, op.labelIds, operationAccountEmail);
          break;
        case "removeLabels":
          if (!op.labelIds?.length) {
            throw new Error("removeLabels operation carries no label ids");
          }
          await removeLabels(op.emailId, op.labelIds, operationAccountEmail);
          break;
        default:
          throw new Error(`Unsupported Gmail operation type "${op.type}"`);
      }
      applied++;
      outcomes.push({ emailId: op.emailId, type: op.type, ok: true });
    } catch (err) {
      failed++;
      const error = err instanceof Error ? err.message : String(err);
      errors.push({ emailId: op.emailId, error });
      outcomes.push({ emailId: op.emailId, type: op.type, ok: false, error });
    }
  }

  return { applied, failed, errors, outcomes };
}

