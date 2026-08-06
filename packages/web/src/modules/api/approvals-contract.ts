/**
 * The wire contract for `/api/approvals*`.
 *
 * These types are imported by BOTH the route handlers that produce them and the
 * client hooks that consume them, so a field added on one side fails to compile
 * on the other. Deliberately free of any `@email-agent/core` import: client code
 * outside `modules/api` may not pull core runtime into the browser bundle, and a
 * type-only module keeps this file safe for both sides.
 */

export interface ApprovalEmailSummary {
  subject: string;
  from: string;
  date: string;
  snippet: string;
}

export interface ApprovalOperation {
  id: string;
  batchId: string;
  actionId: string;
  actionName: string;
  accountId: string;
  emailId: string;
  type: string;
  labelIds: string[];
  /** Human-readable description of the change, derived server-side from core. */
  label: string;
  /** True for changes that hide or destroy mail (trash/spam). */
  destructive: boolean;
  createdAt: string;
  email: ApprovalEmailSummary | null;
}

export interface ApprovalsResponse {
  operations: ApprovalOperation[];
  pendingCount: number;
}

export interface ApprovalOperationOutcome {
  emailId: string;
  type: string;
  ok: boolean;
  error?: string;
}

export interface ApplyApprovalsResult {
  applied: number;
  failed: number;
  errors: Array<{ emailId: string; error: string }>;
  /** Per-operation results, in the order the operations were applied. */
  outcomes: ApprovalOperationOutcome[];
  /** How many queue row ids the client submitted. */
  requested: number;
  /**
   * Submitted ids that were no longer `pending` when the apply ran — another
   * tab, the CLI, or an auto-apply run resolved them first. `applied + failed`
   * is the number of rows this call actually claimed, so anything left over was
   * never touched by it. Non-zero means the client's view of the queue is stale.
   */
  skipped: number;
}

export interface RejectApprovalsResult {
  rejected: number;
  requested: number;
  /** Same meaning as on the apply result: submitted ids that were already resolved. */
  skipped: number;
}

/**
 * Derives the "already resolved elsewhere" count from the core apply result
 * without changing core's return shape.
 *
 * `applyPendingOperationsByIds` claims every row it is going to touch before it
 * calls Gmail and reports one applied-or-failed entry per claimed row, so
 * `requested - (applied + failed)` is exactly the set of ids that were not
 * pending any more. Doing the arithmetic on the result (rather than re-reading
 * the table first) keeps it race-free: there is no window between the check and
 * the claim in which the answer could change.
 */
export function summarizeApplyResult(
  requestedIds: string[],
  result: { applied: number; failed: number },
): { requested: number; skipped: number; claimed: number } {
  const claimed = result.applied + result.failed;
  return {
    requested: requestedIds.length,
    skipped: Math.max(0, requestedIds.length - claimed),
    claimed,
  };
}

/** True when every submitted id was already resolved — a 409, not a success. */
export function isFullyStaleApply(
  requestedIds: string[],
  result: { applied: number; failed: number },
): boolean {
  return requestedIds.length > 0 && result.applied + result.failed === 0;
}

/** The message the UI shows for an apply that touched nothing. */
export function staleApplyMessage(requested: number): string {
  return (
    `None of the ${requested} selected change${requested === 1 ? " was" : "s were"} still pending — ` +
    `${requested === 1 ? "it was" : "they were"} already applied or rejected somewhere else ` +
    `(another tab, the CLI, or an auto-apply run). Nothing was sent to Gmail.`
  );
}

export type ToastTone = "success" | "warning" | "error";

/**
 * Wording for the toast after an apply. Pure, so the sentences the user reads
 * are covered by tests even though there is no React test harness here — the
 * component only picks `toast[tone](message)`.
 *
 * The fully-stale case never reaches this: it is a 409, so it lands in the
 * mutation's error path with `staleApplyMessage` already attached.
 */
export function describeApplyOutcome(result: {
  applied: number;
  failed: number;
  skipped: number;
}): { tone: ToastTone; message: string } {
  const parts = [`Applied ${result.applied} change${result.applied === 1 ? "" : "s"} to Gmail`];
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (result.skipped > 0) {
    parts.push(`${result.skipped} were already resolved elsewhere and were skipped`);
  }

  const message = parts.join(", ");
  if (result.failed > 0) return { tone: "error", message };
  if (result.skipped > 0) return { tone: "warning", message };
  return { tone: "success", message };
}

/** Wording for the toast after a reject. Same skipped accounting as the apply. */
export function describeRejectOutcome(result: {
  rejected: number;
  skipped: number;
}): { tone: ToastTone; message: string } {
  if (result.rejected === 0 && result.skipped > 0) {
    return {
      tone: "warning",
      message:
        `None of the ${result.skipped} selected change${result.skipped === 1 ? "" : "s"} was still pending — ` +
        `already applied or rejected somewhere else. Nothing changed.`,
    };
  }

  const base = `Rejected ${result.rejected} pending change${result.rejected === 1 ? "" : "s"}`;
  if (result.skipped > 0) {
    return {
      tone: "warning",
      message: `${base}, ${result.skipped} were already resolved elsewhere and were skipped`,
    };
  }
  return { tone: "success", message: base };
}
