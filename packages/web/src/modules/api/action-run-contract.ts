/**
 * What the Actions page tells the user after a run.
 *
 * Pure and free of any `@email-agent/core` import, for the same two reasons as
 * `approvals-contract.ts`: client code outside `modules/api` may not pull core
 * runtime into the browser bundle, and a pure module keeps the sentences under
 * test even though there is no React test harness in this repo. The component
 * only picks `toast[tone](message)`.
 *
 * The strings that describe a failure are NOT composed here. `ActionRunner`
 * builds them in core (`describeAutoApplyFailure`,
 * `describeUnrecordedBatchFailure`) and they arrive on the run result verbatim,
 * so the CLI and the web say the same thing about the same failure.
 */

export type ActionRunTone = "success" | "warning" | "error";

/** The subset of `ActionRunResult` this wording depends on. */
export interface ActionRunOutcomeInput {
  pendingOperations?: unknown[];
  applyResult?: { applied: number; failed: number };
  duplicateOperations?: number;
  queueError?: string;
  applyError?: string;
  persistError?: string;
}

function plural(count: number, one: string, many: string): string {
  return count === 1 ? one : many;
}

/**
 * How many identical proposals the enqueue dropped, phrased for a user who is
 * about to wonder why the queue shows fewer rows than the action proposed.
 *
 * Deliberately says "already awaiting approval" rather than "duplicates": the
 * dedupe is scoped to rows that are still PENDING, so a change that was applied
 * or rejected earlier is re-proposed, not suppressed.
 */
export function describeDuplicateOperations(duplicates: number): string {
  return (
    `${duplicates} ${plural(duplicates, "identical change was", "identical changes were")} ` +
    `already awaiting approval and ${plural(duplicates, "was", "were")} not queued again`
  );
}

/**
 * Wording for the toast after an action run.
 *
 * ORDER MATTERS, and the first branch is the one this whole module exists for.
 * `applyError` means the opt-in auto-apply threw AFTER the queue rows were
 * claimed and Gmail had already been called, so the rows are `applying`, not
 * `pending`. Reporting `pendingOperations` as "awaiting your approval" there —
 * which is what this page used to do, because it only ever read `queueError` —
 * tells the user their mail is untouched when it may really have been trashed.
 * So `applyError` wins over everything, and the pending branch is unreachable
 * while it is set.
 */
export function describeActionRunOutcome(
  actionName: string,
  result: ActionRunOutcomeInput,
): { tone: ActionRunTone; message: string } {
  if (result.applyError) {
    return { tone: "error", message: `“${actionName}”: ${result.applyError}` };
  }

  if (result.queueError) {
    // When the parent `action_results` row is what failed, core's `queueError`
    // IS `describeUnrecordedBatchFailure(...)` — a complete sentence that
    // already says nothing was applied. Prefixing it with our own version of
    // the same claim would just say it twice.
    return {
      tone: "error",
      message: result.persistError
        ? `“${actionName}”: ${result.queueError}`
        : `“${actionName}” ran, but its Gmail changes could not be queued for approval — ` +
          `nothing was applied. (${result.queueError})`,
    };
  }

  if (result.persistError) {
    // Reachable only when the run proposed no Gmail changes at all: with
    // operations in hand, core fails closed and sets `queueError` too.
    return {
      tone: "warning",
      message:
        `“${actionName}” completed, but its result could not be saved to history ` +
        `(${result.persistError}). It proposed no Gmail changes, so nothing was applied.`,
    };
  }

  const duplicates = result.duplicateOperations ?? 0;
  const duplicateNote = duplicates > 0 ? ` ${describeDuplicateOperations(duplicates)}.` : "";

  if (result.applyResult) {
    const { applied, failed } = result.applyResult;
    return {
      tone: "warning",
      message:
        `“${actionName}” auto-applied ${applied} Gmail ${plural(applied, "change", "changes")}` +
        (failed > 0 ? `, ${failed} failed` : "") +
        `.${duplicateNote}`,
    };
  }

  const pending = result.pendingOperations?.length ?? 0;
  if (pending > 0) {
    return {
      tone: "success",
      message:
        `“${actionName}” completed — ${pending} Gmail ${plural(pending, "change awaits", "changes await")} ` +
        `your approval.${duplicateNote}`,
    };
  }

  if (duplicates > 0) {
    // Every proposal collapsed onto a row already in the queue. Without this the
    // page said "completed" and the queue did not grow, which reads as the
    // action having decided nothing.
    return {
      tone: "success",
      message:
        `“${actionName}” completed — no new Gmail changes were queued. ` +
        `${describeDuplicateOperations(duplicates)}.`,
    };
  }

  return { tone: "success", message: `Action “${actionName}” completed` };
}
