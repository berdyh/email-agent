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

/**
 * One action run's worth of queued changes, as the panel groups them.
 *
 * `batchId` is the `action_results` row id, so a batch is exactly "one run of
 * one action" — the unit a user reviews and the unit the header names.
 */
export interface ApprovalBatch {
  batchId: string;
  actionName: string;
  createdAt: string;
  operations: ApprovalOperation[];
}

/**
 * Groups queued changes by their run, preserving the order the operations
 * arrived in — both between batches and inside one.
 *
 * ORDER IS THE WHOLE CONTENT OF THIS FUNCTION, which is why it is out here
 * rather than inlined in a `useMemo` where no test could reach it. The route
 * returns rows already sorted newest-batch-first with a total order inside a
 * millisecond (`getPendingOperations`), and re-sorting or re-keying here would
 * throw that away: a Map keyed by batchId preserves insertion order, so the
 * first row of each batch fixes that batch's position and every later row of it
 * appends. Grouping with an object literal, or sorting the keys, reorders
 * numeric-looking ids and makes the same queue render differently run to run.
 *
 * `actionName` and `createdAt` are taken from the batch's FIRST row and are
 * denormalised onto every row anyway; taking them from the last would be
 * equivalent today and would silently start lying if they ever diverged.
 */
export function groupOperationsByBatch(
  operations: readonly ApprovalOperation[],
): ApprovalBatch[] {
  const byBatch = new Map<string, ApprovalBatch>();
  for (const operation of operations) {
    const batch = byBatch.get(operation.batchId);
    if (batch) {
      batch.operations.push(operation);
    } else {
      byBatch.set(operation.batchId, {
        batchId: operation.batchId,
        actionName: operation.actionName,
        createdAt: operation.createdAt,
        operations: [operation],
      });
    }
  }
  return [...byBatch.values()];
}

export interface ApprovalsResponse {
  operations: ApprovalOperation[];
  pendingCount: number;
}

/**
 * A queue row a crash left claimed: `applying`, older than the staleness
 * threshold, never resolved. It is NOT pending — it does not appear in the
 * approval list and cannot be approved or rejected — and its Gmail mutation may
 * or may not have landed.
 */
export interface StrandedOperation extends ApprovalOperation {
  /** When the row left `pending` and the Gmail call was about to be made. */
  claimedAt: string;
}

export interface StrandedApprovalsResponse {
  operations: StrandedOperation[];
  /** How long a row must sit in `applying` before it is listed here. */
  thresholdMinutes: number;
}

/**
 * How long a row has been stuck, in words.
 *
 * Rounded DOWN and never below "about a minute": the number is the user's cue
 * for how long ago the Gmail call might have happened, so overstating it would
 * push them to look in the wrong part of their mailbox. An unparsable stamp
 * says so rather than rendering "NaN minutes" — core surfaces such a row
 * precisely because it cannot be aged.
 */
export function describeStrandedAge(claimedAt: string, now: Date = new Date()): string {
  const claimed = new Date(claimedAt).getTime();
  if (Number.isNaN(claimed)) return "stuck for an unknown length of time";

  const minutes = Math.floor((now.getTime() - claimed) / 60_000);
  if (minutes < 1) return "stuck for about a minute";
  if (minutes < 60) return `stuck for ${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `stuck for ${hours} hour${hours === 1 ? "" : "s"}`;
  const days = Math.floor(hours / 24);
  return `stuck for ${days} day${days === 1 ? "" : "s"}`;
}

/**
 * The user's answer about a stranded row. Duplicated from core's
 * `StrandedDecision` rather than imported, because this module stays free of
 * core (see the header) — the two must be kept in step by hand, and the route
 * that bridges them is the one place that sees both.
 */
export type StrandedDecision = "applied" | "notApplied";

/**
 * Why a stranded row is STILL stranded after Email Agent checked Gmail for it.
 *
 * Duplicated from core's `VerificationResidualReason` for the same reason
 * `StrandedDecision` is duplicated above — this module stays free of core, and
 * `app/api/approvals/stranded/verify/route.ts` is the one place that sees both
 * and must be kept in step by hand.
 */
export type VerificationResidualReason =
  | "message-missing"
  | "credentials"
  | "check-failed"
  | "unverifiable-operation"
  | "unscoped-account";

/** One row a verification pass could not resolve, and why. */
export interface StrandedVerificationResidual {
  id: string;
  emailId: string;
  accountId: string;
  reason: VerificationResidualReason;
  /** Gmail's or core's own words about what went wrong — safe to show a user. */
  detail: string;
}

/**
 * What `POST /api/approvals/stranded/verify` reports back.
 *
 * `checked: 0` means there was nothing stale — no Gmail call was made, and
 * nothing changed. `appliedRecorded`/`requeuedRecorded` are what the WRITE
 * actually reached, which can be lower than the number of rows the read
 * classified that way (a row can leave `applying` between the read and the
 * write) — never derive a count from `unresolved.length` being smaller than
 * `checked` instead of reading these two fields.
 */
export interface VerifyStrandedResult {
  checked: number;
  appliedRecorded: number;
  requeuedRecorded: number;
  unresolved: StrandedVerificationResidual[];
}

/**
 * Per-reason sentence for a row Email Agent's own Gmail check could not close
 * out. THE REASON PICKS THE HEADLINE; `detail` (core's own words) carries the
 * specifics, so this never re-authors what core already said — it only frames
 * it. `message-missing` and `unscoped-account` arrive as complete sentences
 * from core already, so they pass through unchanged.
 *
 * `unverifiable-operation` NEVER resolves itself — word it differently from
 * `check-failed`, which may.
 */
export function describeResidualReason(
  reason: VerificationResidualReason,
  detail: string,
): string {
  switch (reason) {
    case "message-missing":
    case "unscoped-account":
      return detail;
    case "credentials":
      return `Email Agent could not use this account's Gmail access to check: ${detail}`;
    case "check-failed":
      return `The check itself failed, not the change: ${detail} This may resolve on its own the next time Email Agent checks.`;
    case "unverifiable-operation":
      return `Email Agent does not know how to check this one automatically — it is ${detail}. This will not resolve on its own; only you can close it out.`;
  }
}

/**
 * Wording for the toast/banner after a verify pass, fired once when the
 * stranded panel mounts.
 *
 * THREE SHAPES, because "nothing happened" and "everything happened" read
 * very differently to a user who is staring at an empty panel either way —
 * this is exactly the distinction the empty state has to make (task
 * requirement: "empty because verification cleared it" vs "empty because
 * nothing was stranded").
 */
export function describeVerifyResolution(result: VerifyStrandedResult): {
  tone: ToastTone;
  message: string;
} | null {
  if (result.checked === 0) return null; // Nothing stale — say nothing, per the notify-line rule.

  const resolved = result.appliedRecorded + result.requeuedRecorded;
  const parts: string[] = [];
  if (result.appliedRecorded > 0) {
    parts.push(
      `${result.appliedRecorded} had landed (recorded applied)`,
    );
  }
  if (result.requeuedRecorded > 0) {
    parts.push(`${result.requeuedRecorded} had not (back in the approval queue)`);
  }

  const checkedLine = `Checked ${result.checked} Gmail ${result.checked === 1 ? "change" : "changes"} that were stuck mid-apply against Gmail's current state.`;
  const resolvedLine =
    parts.length > 0
      ? ` ${parts.join(", ")}.`
      : resolved === 0
        ? " None could be resolved automatically."
        : "";
  const residualLine =
    result.unresolved.length > 0
      ? ` ${result.unresolved.length} still ${result.unresolved.length === 1 ? "needs" : "need"} you to look — see below.`
      : " Nothing left for you to do.";

  return {
    tone: result.unresolved.length > 0 ? "warning" : "success",
    message: `${checkedLine}${resolvedLine}${residualLine}`,
  };
}

export interface ResolveStrandedResult {
  decision: StrandedDecision;
  /** How many ids the client submitted. */
  requested: number;
  /** How many rows this call actually wrote. */
  resolved: number;
  /**
   * `requested - resolved`: rows this call did not write.
   *
   * READ THIS AS "not written by this call", NOT "an apply finished them". Core
   * writes a row only while it is `applying` AND older than the staleness
   * threshold, so a shortfall means any of: an apply resolved it, another
   * adjudication answered it, or it was requeued and re-claimed and is no
   * longer stale. See `strandedSkipReasons`.
   */
  skipped: number;
}

/**
 * Why a row a surface listed as stuck was not written by this call.
 *
 * STATES WHAT IS CERTAIN, OFFERS THE REST AS POSSIBILITIES — the precedent set
 * by `unclaimedApplyMessage` below. The earlier wording asserted one cause as
 * fact ("an apply that was still running has since finished it, and the outcome
 * it recorded was kept"), and there are now FOUR, only one of which involves a
 * real apply. A row can equally have been answered by another person (another
 * tab, or the CLI), or by Email Agent's own automatic Gmail check running in
 * the background — these are offered SEPARATELY, not folded into one "another
 * answer" line, because a user who pressed nothing themselves cannot guess the
 * second exists. Or it can have been requeued and re-claimed, in which case it
 * is not stale and no answer about it is meaningful yet.
 */
function strandedSkipReasons(one: boolean): string {
  return (
    `An apply that was still running may have finished ${one ? "it" : "them"} and recorded a real ` +
    `outcome; another person may have answered ${one ? "it" : "them"} first (another tab, or the ` +
    `CLI); Email Agent's own automatic check against Gmail may have answered ${one ? "it" : "them"} ` +
    `in the meantime; or ${one ? "it may have been" : "they may have been"} requeued and picked up ` +
    `by a fresh apply, which makes ${one ? "it" : "them"} too new to adjudicate. Reload to see where ` +
    `${one ? "it stands" : "they stand"}.`
  );
}

/**
 * Wording for the toast after adjudicating stranded rows.
 *
 * Every sentence here has to keep one line straight: the app recorded what the
 * USER said, and checked nothing itself. "Marked as applied" is a claim about
 * our records, never about the mailbox.
 */
export function describeStrandedResolution(result: ResolveStrandedResult): {
  tone: ToastTone;
  message: string;
} {
  const one = result.resolved === 1;
  const skippedNote =
    result.skipped > 0
      ? ` ${result.skipped} ${result.skipped === 1 ? "row was" : "rows were"} not written — ` +
        `${result.skipped === 1 ? "it was" : "they were"} no longer stuck mid-apply, so whatever ` +
        `${result.skipped === 1 ? "was" : "were"} already recorded stayed. ` +
        strandedSkipReasons(result.skipped === 1)
      : "";

  if (result.resolved === 0) {
    const requestedOne = result.requested === 1;
    return {
      tone: "warning",
      message:
        `Nothing was recorded — ${requestedOne ? "that row is" : "those rows are"} no longer stuck ` +
        `mid-apply, so your answer was not written and whatever was already recorded stayed. ` +
        strandedSkipReasons(requestedOne),
    };
  }

  // "Email Agent did not check Gmail" stays true here specifically: this
  // sentence describes only the human-adjudicated branch (a person clicked one
  // of the two buttons). It does not describe the row's whole life — most rows
  // never reach a human at all, because Email Agent's own verification pass
  // resolves them first; the ones that DO land here are exactly the residual
  // that check could not answer, and for THIS branch a human really is the only
  // one who looked.
  const message =
    result.decision === "applied"
      ? `Recorded ${result.resolved} ${one ? "change" : "changes"} as applied, on your word — ` +
        `Email Agent did not check Gmail.${skippedNote}`
      : `Put ${result.resolved} ${one ? "change" : "changes"} back in the approval queue, on your ` +
        `word that ${one ? "it" : "they"} never reached Gmail.${skippedNote}`;

  return { tone: result.skipped > 0 ? "warning" : "success", message };
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
   * Submitted ids this call did not claim: `requested - (applied + failed)`.
   *
   * READ THIS AS "not claimed by this call", NOT "already applied or rejected".
   * Core moves a row to `applying` before it calls Gmail, so a row this call
   * could not claim may be mid-flight in another apply, may have failed in an
   * earlier run, or may not exist at all. The only fact the arithmetic
   * establishes is that this call did not touch it. (The CLI calls the same
   * quantity `unclaimed`.)
   *
   * Non-zero does mean the client's view of the queue is out of date.
   */
  skipped: number;
}

export interface RejectApprovalsResult {
  rejected: number;
  requested: number;
  /** Same meaning as on the apply result: ids this call did not claim. */
  skipped: number;
}

/**
 * Derives the "not claimed by this call" count from the core apply result
 * without changing core's return shape.
 *
 * `applyPendingOperationsByIds` claims every row it is going to touch before it
 * calls Gmail and reports one applied-or-failed entry per claimed row, so
 * `requested - (applied + failed)` is exactly the set of ids this call did not
 * claim. Doing the arithmetic on the result (rather than re-reading the table
 * first) keeps it race-free: there is no window between the check and the claim
 * in which the answer could change.
 *
 * What it does NOT tell you is WHY a row was not claimed. It may have been
 * applied or rejected elsewhere; it may equally be `applying` in a request that
 * is still running, have failed earlier, or never have existed. Anything built
 * on this number has to stop at "this call did not touch it".
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

/**
 * True when the call claimed none of the submitted ids — a 409, not a success.
 *
 * Named for what is known (nothing was claimed) rather than for a guess about
 * why. The client's view is definitely out of date; the rows' actual state is
 * not knowable from here.
 */
export function claimedNothing(
  requestedIds: string[],
  result: { applied: number; failed: number },
): boolean {
  return requestedIds.length > 0 && result.applied + result.failed === 0;
}

/**
 * The message the UI shows for an apply that claimed nothing.
 *
 * It used to assert that the rows "were already applied or rejected somewhere
 * else". That is one possibility among several — the row may be mid-apply in
 * another tab right now — so the sentence says what is certain (this run sent
 * nothing to Gmail) and offers the rest as possibilities.
 */
export function unclaimedApplyMessage(requested: number): string {
  const one = requested === 1;
  return (
    `None of the ${requested} selected change${one ? "" : "s"} could be claimed, so nothing was ` +
    `sent to Gmail. ${one ? "It may" : "They may"} already have been applied or rejected somewhere ` +
    `else (another tab, the CLI, or an auto-apply run), or another apply may still be working on ` +
    `${one ? "it" : "them"}. Reload to see where ${one ? "it" : "they"} stood.`
  );
}

export type ToastTone = "success" | "warning" | "error";

/**
 * Wording for the toast after an apply. Pure, so the sentences the user reads
 * are covered by tests even though there is no React test harness here — the
 * component only picks `toast[tone](message)`.
 *
 * The claimed-nothing case never reaches this: it is a 409, so it lands in the
 * mutation's error path with `unclaimedApplyMessage` already attached.
 */
export function describeApplyOutcome(result: {
  applied: number;
  failed: number;
  skipped: number;
}): { tone: ToastTone; message: string } {
  const parts = [`Applied ${result.applied} change${result.applied === 1 ? "" : "s"} to Gmail`];
  if (result.failed > 0) parts.push(`${result.failed} failed`);
  if (result.skipped > 0) {
    parts.push(`${result.skipped} could not be claimed and were not touched by this run`);
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
        `None of the ${result.skipped} selected change${result.skipped === 1 ? "" : "s"} could be claimed — ` +
        `${result.skipped === 1 ? "it was" : "they were"} not pending any more, so another run had ` +
        `already claimed or resolved ${result.skipped === 1 ? "it" : "them"}. Nothing was rejected here.`,
    };
  }

  const base = `Rejected ${result.rejected} pending change${result.rejected === 1 ? "" : "s"}`;
  if (result.skipped > 0) {
    return {
      tone: "warning",
      message: `${base}, ${result.skipped} could not be claimed — another run had already claimed or resolved them`,
    };
  }
  return { tone: "success", message: base };
}
