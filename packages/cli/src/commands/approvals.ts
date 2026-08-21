import type { Command } from "commander";
import chalk from "chalk";
import ora, { type Ora } from "ora";
import {
  initDb,
  getPendingOperations,
  getStaleApplyingOperations,
  adjudicateStrandedOperations,
  applyPendingOperationsByIds,
  rejectPendingOperationsByIds,
  describeGmailOperation,
  emailRefKey,
  getEmailsByIds,
  loadSettings,
  parseLabelIds,
  prunePendingOperations,
  resolveRetentionCutoff,
  STALE_APPLYING_THRESHOLD_MS,
  verifyStrandedApplyingOperations,
} from "@email-agent/core";
import type {
  ActionApplyResult,
  PendingOperationRecord,
  StrandedDecision,
  StrandedResidual,
  StrandedVerificationResult,
  VerificationResidualReason,
} from "@email-agent/core";

import {
  askOnce,
  usingPrompt,
  SIGINT_EXIT_CODE,
  type PromptSession,
  type PromptStreams,
} from "../prompt.js";

export { SIGINT_EXIT_CODE };

/**
 * How a review loop gets its prompt.
 *
 * `session` is how a caller that has ALREADY asked something threads its own
 * interface through — see `usingPrompt` for the input-loss bug that makes this
 * mandatory rather than an optimisation.
 */
export type ReviewPromptOptions = PromptStreams & { session?: PromptSession };

export function describeOperation(op: PendingOperationRecord): string {
  return describeGmailOperation(op.type, parseLabelIds(op.labelIds));
}

interface OperationDisplay {
  op: PendingOperationRecord;
  subject: string;
  from: string;
  snippet: string;
}

export async function loadOperationDisplays(
  ops: PendingOperationRecord[],
): Promise<OperationDisplay[]> {
  // One batched scan for the whole queue rather than one per operation. The
  // queue routinely holds dozens of rows over a handful of emails, and the
  // per-row version walked the emails table every time.
  const emails = await getEmailsByIds(
    ops.map((op) => ({ accountId: op.accountId, id: op.emailId })),
  );

  return ops.map((op) => {
    const email = emails.get(emailRefKey(op.accountId, op.emailId));
    return {
      op,
      subject: email?.subject ?? `(not in local DB: ${op.emailId})`,
      from: email?.from ?? "",
      snippet: email?.snippet ?? "",
    };
  });
}

export function printOperationList(displays: OperationDisplay[]): void {
  let currentBatch = "";
  for (const [index, display] of displays.entries()) {
    const { op } = display;
    if (op.batchId !== currentBatch) {
      currentBatch = op.batchId;
      console.log(
        chalk.bold(`\n${op.actionName}`) +
          chalk.dim(` — ${op.createdAt} (batch ${op.batchId.slice(0, 8)})`),
      );
    }
    const account = op.accountId ? chalk.dim(` [${op.accountId}]`) : "";
    console.log(
      `  ${chalk.dim(String(index + 1).padStart(3))}. ` +
        `${chalk.yellow(describeOperation(op))} — ${display.subject}` +
        (display.from ? chalk.dim(` (${display.from})`) : "") +
        account,
    );
  }
}

export interface ApplyOutcome {
  requested: number;
  applied: number;
  failed: number;
  /**
   * Ids this run did not claim.
   *
   * NOT "already applied or rejected". Core claims a row before it calls Gmail,
   * so a row this run failed to claim may equally be mid-flight in another
   * apply (`applying`), have failed earlier, or not exist. The one thing that
   * is certain is that THIS run did not touch it.
   */
  unclaimed: number;
}

export interface RejectOutcome {
  requested: number;
  rejected: number;
  /** Same meaning as on the apply outcome: not claimed by this run. */
  unclaimed: number;
}

/** Wording for a finished apply. Pure, so the sentences are under test. */
export function describeApplyOutcome(outcome: ApplyOutcome): {
  tone: "success" | "warn";
  message: string;
} {
  if (outcome.applied === 0 && outcome.failed === 0 && outcome.unclaimed > 0) {
    const plural = outcome.unclaimed === 1 ? "" : "s";
    return {
      tone: "warn",
      message:
        `None of the ${outcome.unclaimed} change${plural} could be claimed — nothing was sent ` +
        `to Gmail by this run. They may already have been applied or rejected elsewhere, or ` +
        `another run may still be applying them. Run \`email-agent approvals list\` to see ` +
        `what is still pending.`,
    };
  }

  const unclaimedNote =
    outcome.unclaimed > 0 ? `, ${outcome.unclaimed} not claimed by this run` : "";
  if (outcome.failed > 0) {
    return {
      tone: "warn",
      message: `Applied ${outcome.applied} changes, ${chalk.red(`${outcome.failed} failed`)}${unclaimedNote}`,
    };
  }
  if (outcome.unclaimed > 0) {
    return {
      tone: "warn",
      message: `Applied ${outcome.applied} changes to Gmail${unclaimedNote}`,
    };
  }
  return { tone: "success", message: `Applied ${outcome.applied} changes to Gmail` };
}

/** Wording for a finished reject. Pure for the same reason. */
export function describeRejectOutcome(outcome: RejectOutcome): string {
  const base = `Rejected ${outcome.rejected} pending change${outcome.rejected === 1 ? "" : "s"}.`;
  if (outcome.unclaimed === 0) return base;
  return (
    `${base} ${outcome.unclaimed} could not be claimed — they were not pending any more, so ` +
    `another run had already claimed or resolved them.`
  );
}

/**
 * What the CLI can honestly say after an apply threw.
 *
 * It cannot say "the rest stay queued". `applyPendingOperationsByIds` moves
 * rows out of `pending` and stamps them `applying` BEFORE it calls Gmail, and
 * the finalization that writes them back to applied/failed can itself throw —
 * so a failed apply can leave rows in a state `approvals list` (which lists
 * `pending`) does not show at all.
 */
export function describeApplyFailure(ids: string[], error: unknown): string[] {
  return [
    `Failed to apply ${ids.length} approved change${ids.length === 1 ? "" : "s"}: ${errorText(error)}`,
    "Their state could not be confirmed. Some may have reached Gmail before the failure, and " +
      "rows this run had already claimed can be left mid-apply, where `email-agent approvals " +
      "list` will not show them. Check Gmail, then re-run `email-agent approvals list`.",
  ];
}

export interface ApplyDeps {
  apply?: (ids: string[]) => Promise<ActionApplyResult>;
  /**
   * Test seam: build the spinner. Tests hand back a REAL ora pointed at a fake
   * TTY, so the lifecycle under test is ora's own, not a stand-in for it.
   */
  createSpinner?: (text: string) => Ora;
}

export async function applyOperationIds(
  ids: string[],
  deps: ApplyDeps = {},
): Promise<ApplyOutcome> {
  if (ids.length === 0) {
    return { requested: 0, applied: 0, failed: 0, unclaimed: 0 };
  }

  // The surface is bound here rather than widened into `ApplyDeps`: the CLI
  // is always "cli", and the injected test doubles have nothing to say about
  // attribution.
  const apply =
    deps.apply ?? ((ids: string[]) => applyPendingOperationsByIds(ids, "cli"));
  const createSpinner = deps.createSpinner ?? ((text: string) => ora(text));
  const spinner = createSpinner(`Applying ${ids.length} changes to Gmail...`).start();

  try {
    const result = await apply(ids);
    const outcome: ApplyOutcome = {
      requested: ids.length,
      applied: result.applied,
      failed: result.failed,
      unclaimed: Math.max(0, ids.length - (result.applied + result.failed)),
    };

    const { tone, message } = describeApplyOutcome(outcome);
    if (tone === "warn") spinner.warn(message);
    else spinner.succeed(message);

    if (result.failed > 0) {
      for (const err of result.errors) {
        console.log(chalk.red(`  ${err.emailId}: ${err.error}`));
      }
    }
    return outcome;
  } catch (err) {
    spinner.fail(`Apply failed: ${errorText(err)}`);
    throw err;
  } finally {
    // TEAR THE SPINNER DOWN ON EVERY PATH. Ora holds a referenced interval and
    // puts stdin into a discard mode while it spins, so an apply that threw used
    // to leave the process alive forever — the CLI printed its failure message
    // and then span with the cursor hidden until the user killed it. `stop()`
    // clears the line and restores the cursor.
    if (spinner.isSpinning) spinner.stop();
  }
}

export interface RejectDeps {
  reject?: (ids: string[]) => Promise<number>;
}

export async function rejectOperationIds(
  ids: string[],
  deps: RejectDeps = {},
): Promise<RejectOutcome> {
  if (ids.length === 0) return { requested: 0, rejected: 0, unclaimed: 0 };

  const reject =
    deps.reject ?? ((ids: string[]) => rejectPendingOperationsByIds(ids, "cli"));
  const rejected = await reject(ids);
  const outcome: RejectOutcome = {
    requested: ids.length,
    rejected,
    unclaimed: Math.max(0, ids.length - rejected),
  };
  console.log(chalk.dim(describeRejectOutcome(outcome)));
  return outcome;
}

export interface ReviewCommitResult {
  approvedIds: string[];
  rejectedIds: string[];
  /** Present only when the handler returned; absent when it threw. */
  applyOutcome?: ApplyOutcome;
  rejectOutcome?: RejectOutcome;
  rejectError?: unknown;
  applyError?: unknown;
}

/**
 * Commits the answers from `reviewOperations`.
 *
 * REJECT FIRST. Rejecting only rewrites queue rows and never calls Gmail, so it
 * is the half that cannot fail halfway through a mailbox mutation. Applying
 * first meant a network failure mid-batch threw before any rejection was
 * written, silently discarding every explicit "no" the user had just typed.
 *
 * Both halves run even if the other throws — the approved and rejected id sets
 * are disjoint, so neither failure makes the other unsafe — and the errors are
 * returned rather than propagated so the caller can say exactly what was and
 * was not recorded.
 */
export async function commitReviewDecisions(
  decisions: { approved: string[]; rejected: string[] },
  handlers: {
    applyIds: (ids: string[]) => Promise<ApplyOutcome>;
    rejectIds: (ids: string[]) => Promise<RejectOutcome>;
  } = { applyIds: applyOperationIds, rejectIds: rejectOperationIds },
): Promise<ReviewCommitResult> {
  const result: ReviewCommitResult = {
    approvedIds: decisions.approved,
    rejectedIds: decisions.rejected,
  };

  try {
    // Keep what the reject actually recorded. Reporting off the REQUESTED ids
    // was how the CLI came to tell a user "your 1 rejection was already
    // recorded" for a row another tab had claimed a moment earlier.
    result.rejectOutcome = await handlers.rejectIds(decisions.rejected);
  } catch (err) {
    result.rejectError = err;
  }

  try {
    result.applyOutcome = await handlers.applyIds(decisions.approved);
  } catch (err) {
    result.applyError = err;
  }

  return result;
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Turns a commit result into the lines the user sees. Pure so the honesty of
 * the failure wording — which decisions were recorded and which were not — is
 * covered by tests rather than by reading the code.
 *
 * The rule every line here follows: say only what the handler observed. When a
 * handler threw, the CLI knows nothing about the rows it was given, so it says
 * so instead of picking the comfortable answer.
 */
export function describeReviewCommit(result: ReviewCommitResult): string[] {
  const lines: string[] = [];
  const rejectedCount = result.rejectedIds.length;

  if (result.rejectError) {
    lines.push(
      `Failed to record ${rejectedCount} rejection${rejectedCount === 1 ? "" : "s"}: ${errorText(result.rejectError)}`,
    );
    lines.push(
      "Their state could not be confirmed — the reject claims rows one at a time, so some may " +
        "have been recorded before it failed. Nothing was applied to Gmail for them. Run " +
        "`email-agent approvals list` to see which are still pending.",
    );
  }

  if (result.applyError) {
    lines.push(...describeApplyFailure(result.approvedIds, result.applyError));

    if (rejectedCount > 0 && result.rejectOutcome) {
      const { rejected, unclaimed } = result.rejectOutcome;
      if (rejected === rejectedCount) {
        lines.push(
          `Your ${rejected} rejection${rejected === 1 ? " was" : "s were"} recorded before the apply ran and ${rejected === 1 ? "is" : "are"} not affected.`,
        );
      } else if (rejected === 0) {
        lines.push(
          `None of your ${rejectedCount} rejection${rejectedCount === 1 ? "" : "s"} could be recorded: ` +
            `${unclaimed === 1 ? "that row was" : "those rows were"} not pending any more, so another ` +
            `run had already claimed or resolved ${unclaimed === 1 ? "it" : "them"}. Their final state is whatever that run decided.`,
        );
      } else {
        lines.push(
          `${rejected} of your ${rejectedCount} rejections were recorded; the other ${unclaimed} ` +
            `could not be claimed and were left to whatever run had already taken them.`,
        );
      }
    }
  }

  return lines;
}

/**
 * Did the run leave anything the caller should treat as a failure?
 *
 * A thrown handler is one case. The other — the one that used to exit 0 — is a
 * per-operation Gmail failure: core catches those and returns them as `failed`
 * rather than throwing, so `applyError` stays unset while mail the user
 * approved was never changed.
 */
export function commitFailed(result: ReviewCommitResult): boolean {
  if (result.applyError !== undefined || result.rejectError !== undefined) return true;
  return (result.applyOutcome?.failed ?? 0) > 0;
}

/**
 * What a keystroke at the approve/reject prompt means.
 *
 * `null` is EOF, not a keystroke — see `createAnswerReader`. It is classified
 * here so the loop has one place that decides, and so the DEFAULT is stated
 * once: ANYTHING UNRECOGNISED KEEPS THE CHANGE QUEUED. A typo must never
 * approve a Gmail mutation, and it must never reject one either — leaving the
 * proposal for the user to answer again is the only outcome that discards
 * nothing.
 */
export type ReviewAnswer = "approve" | "reject" | "skip" | "stop";

export function classifyReviewAnswer(raw: string | null): ReviewAnswer {
  // EOF ends the walk and keeps every decision already made, which is exactly
  // what `q` has always meant.
  if (raw === null) return "stop";
  const answer = raw.trim().toLowerCase();
  if (answer === "y") return "approve";
  if (answer === "n") return "reject";
  if (answer === "q") return "stop";
  return "skip";
}

/**
 * What a keystroke at the stranded-row prompt means.
 *
 * Two answers and a skip, because there are only two things a person can
 * actually check: whether the change is visible in Gmail or not. There is
 * deliberately no retry — core claimed the row before it mutated, so
 * re-applying could be a second trash of an already-trashed message.
 *
 * The default is `skip`, and skipping leaves the row EXACTLY as it is. That is
 * the right answer for a user who has not looked yet, so it is also what an
 * unrecognised key and EOF do.
 */
export type StrandedAnswer = "applied" | "notApplied" | "skip";

export function classifyStrandedAnswer(raw: string | null): StrandedAnswer {
  if (raw === null) return "skip";
  const answer = raw.trim().toLowerCase();
  if (answer === "y") return "applied";
  if (answer === "n") return "notApplied";
  return "skip";
}

/**
 * Whether a `[y/N]` confirmation was actually given.
 *
 * EOF is not consent, and neither is anything but `y`: the prompt already
 * promises No as the default.
 */
export function confirmedYes(raw: string | null): boolean {
  return raw !== null && raw.trim().toLowerCase() === "y";
}

/**
 * What the user is told when Ctrl-C ended a review.
 *
 * Pure, because the promise it makes — that nothing was written — is the whole
 * point of aborting, and a wording that hedged it would undo the guarantee.
 * See `prompt.ts` for why SIGINT and EOF deliberately mean different things.
 */
export function describeAbortedReview(queuedCount: number): string {
  const one = queuedCount === 1;
  return (
    `Aborted — nothing was applied to Gmail and nothing was rejected. ` +
    `${one ? "The change is" : `All ${queuedCount} changes are`} still queued; ` +
    `run \`email-agent approvals review\` again when you are ready.`
  );
}

export interface ReviewDecisions {
  approved: string[];
  rejected: string[];
  /**
   * The user pressed Ctrl-C. The caller MUST NOT commit anything: `approved`
   * and `rejected` are whatever had been typed before the interrupt, and the
   * point of an abort is that they are discarded.
   */
  aborted: boolean;
}

/**
 * Steps through operations one by one; each answer is the user's personal
 * decision for that email. Unanswered operations (skip/quit) stay queued.
 *
 * Ctrl-C sets `aborted` and stops asking. It is NOT "stop and keep what I
 * said" — that is `q` and EOF. See `prompt.ts`.
 */
export async function reviewOperations(
  displays: OperationDisplay[],
  options: ReviewPromptOptions = {},
): Promise<ReviewDecisions> {
  const approved: string[] = [];
  const rejected: string[] = [];

  return usingPrompt(options.session, async (session) => {
    for (const [index, display] of displays.entries()) {
      const { op } = display;
      console.log(
        `\n${chalk.dim(`[${index + 1}/${displays.length}]`)} ` +
          `${chalk.yellow(describeOperation(op))} ${chalk.dim(`(${op.actionName})`)}`,
      );
      console.log(`  ${chalk.bold(display.subject)}`);
      if (display.from) console.log(chalk.dim(`  From: ${display.from}`));
      if (op.accountId) console.log(chalk.dim(`  Account: ${op.accountId}`));
      if (display.snippet) console.log(chalk.dim(`  ${display.snippet}`));

      const raw = await session.ask(
        "  Apply? [y]es / [n]o, reject / [s]kip, keep pending / [q]uit: ",
      );
      // Checked BEFORE classifying: an abort delivers `null`, which the
      // classifier reads as `stop` — i.e. "keep what was decided" — and
      // committing on Ctrl-C is exactly the bug this guard exists for.
      if (session.aborted) {
        return { approved: [], rejected: [], aborted: true };
      }
      const answer = classifyReviewAnswer(raw);
      if (answer === "approve") approved.push(op.id);
      else if (answer === "reject") rejected.push(op.id);
      else if (answer === "stop") break;
      // "skip" keeps the operation queued
    }

    return { approved, rejected, aborted: false };
  }, options);
}

/**
 * How long a row has been stuck, in words. Rounded DOWN and floored at "about a
 * minute", because the number is the user's cue for where in their mailbox to
 * look; an unparsable stamp says so rather than printing NaN — core surfaces
 * such a row precisely because it cannot be aged.
 */
export function describeStrandedAge(
  claimedAt: string,
  now: Date = new Date(),
): string {
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
 * The header a user reads before adjudicating stranded rows.
 *
 * `approvals list`'s teaser (a plain DB count, no Gmail call) is the only
 * caller left after M1 — `approvals stranded` builds its own header from a
 * `StrandedVerificationResult` instead, because by the time that command has
 * anything to show a human, it has already checked. So this one must not claim
 * either "we checked" (it did not) or "we cannot check" (elsewhere, we can) —
 * it names the count and points at the command that resolves it.
 */
export function describeStrandedHeader(count: number): string[] {
  const one = count === 1;
  const minutes = Math.round(STALE_APPLYING_THRESHOLD_MS / 60_000);
  return [
    `${count} Gmail ${one ? "change is" : "changes are"} stuck mid-apply.`,
    `A run was interrupted after ${one ? "this change was" : "these changes were"} sent to ` +
      `Gmail, or just before, and the outcome was never recorded. Run ` +
      `\`email-agent approvals stranded\` to check Gmail and resolve what it can automatically.`,
    `(Listed after ${minutes} minutes with no recorded result. ${one ? "It is" : "They are"} ` +
      `not pending, so \`approvals list\`, \`apply\` and \`reject\` do not see ` +
      `${one ? "it" : "them"}.)`,
  ];
}

/**
 * Per-reason sentence for a row Email Agent's own Gmail check could not close
 * out. THE REASON PICKS THE HEADLINE; `detail` (core's own words, from
 * `verifyStrandedApplyingOperations`) carries the specifics, so this never
 * re-authors what core already said. `message-missing` and `unscoped-account`
 * arrive as complete sentences already — pass through unchanged.
 *
 * `unverifiable-operation` NEVER resolves itself on a later pass; word it
 * differently from `check-failed`, which may.
 */
export function describeStrandedReason(
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
 * Why a row this command listed as stuck was not written.
 *
 * Mirrors the web wording (`approvals-contract.ts`) and follows the precedent
 * `describeApplyOutcome` above already sets: state what is certain, offer the
 * rest as possibilities. There are now FOUR causes, only one of which involves
 * a real apply. A row can equally have been answered by another PERSON (the
 * web UI, or another shell), or by Email Agent's own automatic Gmail check
 * running elsewhere — these are offered SEPARATELY, because a user who pressed
 * nothing themselves cannot guess the second exists. Or it can have been
 * requeued and re-claimed by a fresh apply, which makes it too new to
 * adjudicate at all.
 */
function strandedSkipReasons(one: boolean): string {
  return (
    `An apply that was still running may have finished ${one ? "it" : "them"} and recorded a real ` +
    `outcome; another person may have answered ${one ? "it" : "them"} first (the web UI, or ` +
    `another shell); Email Agent's own automatic check against Gmail may have answered ` +
    `${one ? "it" : "them"} in the meantime; or ${one ? "it" : "they"} may have been requeued ` +
    `and picked up by a fresh apply, which makes ${one ? "it" : "them"} too new to adjudicate. ` +
    `Run \`email-agent approvals stranded\` again to see where ${one ? "it stands" : "they stand"}.`
  );
}

/**
 * What a verify pass just did, for `fetch`/`serve`'s notify line AND
 * `approvals stranded`'s own summary — ONE function, so the wording cannot
 * drift into a third hand-copied string the way `describeStrandedHeader` used
 * to.
 *
 * `checked: 0` returns an EMPTY array: no stale rows, no Gmail call, nothing to
 * say — this is what makes fetch/serve's happy path silent, per the owner's
 * decision. `appliedRecorded`/`requeuedRecorded` are what the WRITE actually
 * reached, never `checked` or the id-array lengths — core mutation-tested this
 * distinction (a shortfall between the read and the write is real information,
 * not a rounding error to hide).
 */
export function describeStrandedNotifyLines(
  result: StrandedVerificationResult,
): string[] {
  if (result.checked === 0) return [];

  const resolved = result.appliedRecorded + result.requeuedRecorded;
  const parts: string[] = [];
  if (result.appliedRecorded > 0) {
    parts.push(`${result.appliedRecorded} had landed (recorded applied)`);
  }
  if (result.requeuedRecorded > 0) {
    parts.push(`${result.requeuedRecorded} had not (back in the queue)`);
  }

  const lines = [
    `${result.checked} Gmail ${result.checked === 1 ? "change was" : "changes were"} stuck mid-apply. Checked Gmail:`,
    parts.length > 0
      ? `  ${parts.join(", ")}.`
      : resolved === 0
        ? "  None could be resolved automatically."
        : "",
  ].filter((line) => line !== "");

  if (result.unresolved.length > 0) {
    lines.push(
      `  ${result.unresolved.length} still ${result.unresolved.length === 1 ? "needs" : "need"} you to look — ` +
        "run `email-agent approvals stranded --review`.",
    );
  }
  return lines;
}

/** Wording for a finished adjudication. Pure for the same reason as the rest. */
export function describeStrandedResolution(
  decision: StrandedDecision,
  requested: number,
  resolved: number,
): string {
  if (resolved === 0) {
    const requestedOne = requested === 1;
    return (
      `Nothing was recorded — ${requestedOne ? "that row is" : "those rows are"} no longer stuck ` +
      `mid-apply, so your answer was not written and whatever was already recorded stayed. ` +
      strandedSkipReasons(requestedOne)
    );
  }

  const one = resolved === 1;
  const skipped = requested - resolved;
  const skippedNote =
    skipped > 0
      ? ` ${skipped} ${skipped === 1 ? "row was" : "rows were"} not written — ` +
        `${skipped === 1 ? "it was" : "they were"} no longer stuck mid-apply, so whatever ` +
        `${skipped === 1 ? "was" : "were"} already recorded stayed. ` +
        strandedSkipReasons(skipped === 1)
      : "";

  return decision === "applied"
    ? `Recorded ${resolved} ${one ? "change" : "changes"} as applied, on your word — ` +
        `Email Agent did not check Gmail.${skippedNote}`
    : `Put ${resolved} ${one ? "change" : "changes"} back in the approval queue, on your word ` +
        `that ${one ? "it" : "they"} never reached Gmail.${skippedNote}`;
}

/**
 * `reasonById` is keyed by queue row id, from the verify pass that ran
 * immediately before this — every row here SHOULD have an entry, since verify
 * resolves everything else. A missing entry (a fresh crash racing the check
 * itself) prints the honest fallback rather than inventing a reason.
 */
function printStrandedList(
  displays: OperationDisplay[],
  reasonById: Map<string, StrandedResidual>,
): void {
  for (const [index, display] of displays.entries()) {
    const { op } = display;
    const account = op.accountId ? chalk.dim(` [${op.accountId}]`) : "";
    console.log(
      `  ${chalk.dim(String(index + 1).padStart(3))}. ` +
        `${chalk.red(describeOperation(op))} — ${display.subject}` +
        (display.from ? chalk.dim(` (${display.from})`) : "") +
        account,
    );
    console.log(
      chalk.dim(
        `       ${describeStrandedAge(op.claimedAt || op.createdAt)} · ${op.actionName}`,
      ),
    );
    const residual = reasonById.get(op.id);
    console.log(
      chalk.yellow(
        `       ${
          residual
            ? describeStrandedReason(residual.reason, residual.detail)
            : "Not checked this run — it may be newly stuck since the check above ran."
        }`,
      ),
    );
  }
}

/**
 * Steps through stranded rows one at a time.
 *
 * Only two answers, and neither is a retry: core claimed the row before it
 * mutated, so re-applying could be a second trash of an already-trashed
 * message. "Skip" leaves the row exactly as it is, which is the right default
 * for a user who has not looked yet — so it is what anything unrecognised does.
 */
export async function reviewStrandedOperations(
  displays: OperationDisplay[],
  options: ReviewPromptOptions = {},
  reasonById: Map<string, StrandedResidual> = new Map(),
): Promise<{ applied: string[]; notApplied: string[]; aborted: boolean }> {
  const applied: string[] = [];
  const notApplied: string[] = [];

  return usingPrompt(options.session, async (session) => {
    for (const [index, display] of displays.entries()) {
      const { op } = display;
      console.log(
        `\n${chalk.dim(`[${index + 1}/${displays.length}]`)} ` +
          `${chalk.red(describeOperation(op))} ${chalk.dim(`(${op.actionName})`)}`,
      );
      console.log(`  ${chalk.bold(display.subject)}`);
      if (display.from) console.log(chalk.dim(`  From: ${display.from}`));
      if (op.accountId) console.log(chalk.dim(`  Account: ${op.accountId}`));
      console.log(chalk.dim(`  ${describeStrandedAge(op.claimedAt || op.createdAt)}`));
      const residual = reasonById.get(op.id);
      if (residual) {
        console.log(chalk.yellow(`  ${describeStrandedReason(residual.reason, residual.detail)}`));
      }

      const raw = await session.ask(
        "  Look in Gmail: did this change happen? [y]es / [n]o, requeue it / [s]kip: ",
      );
      // An adjudication is a write, so Ctrl-C must discard the answers already
      // given here for the same reason it does in `reviewOperations`.
      if (session.aborted) {
        return { applied: [], notApplied: [], aborted: true };
      }
      const answer = classifyStrandedAnswer(raw);
      if (answer === "applied") applied.push(op.id);
      else if (answer === "notApplied") notApplied.push(op.id);
      // "skip" leaves the row stuck, which is the honest default.
    }

    return { applied, notApplied, aborted: false };
  }, options);
}

async function loadPending(batchId?: string): Promise<PendingOperationRecord[]> {
  await initDb();
  return getPendingOperations({ status: "pending", batchId });
}

export interface PruneReport {
  /** The window used, in whole days. */
  days: number;
  /** Cutoff timestamp, or null when retention is disabled. */
  cutoff: string | null;
  /** Rows that were eligible, per `PRUNABLE_STATUSES`. */
  deleted: number;
  /**
   * True when nothing was actually deleted and `deleted` is only a count of
   * what WOULD go. The wording has to change with it: every sentence here is a
   * claim about destroyed audit rows, and a dry run reporting "Deleted 2 rows"
   * tells the user something untrue about their own history.
   */
  dryRun?: boolean;
}

/**
 * What a retention sweep did, in words.
 *
 * Pure, because every sentence here is a promise about deleted audit rows and
 * the promises have to be exact: which statuses are eligible, that the count is
 * advisory, and that 0 days means keep forever rather than delete everything.
 */
export function describePrune(report: PruneReport): string[] {
  if (report.cutoff === null) {
    return [
      `Retention is disabled (retention.approvalQueueDays = ${report.days}), so nothing was deleted.`,
      "Every resolved approval-queue row is kept forever. Set a positive number of days in the " +
        "web UI under Settings → Gmail to enable the sweep.",
    ];
  }

  if (report.deleted === 0) {
    return [
      `Nothing to prune: no applied or rejected change was resolved before ${report.cutoff} ` +
        `(${report.days} days ago).`,
    ];
  }

  const one = report.deleted === 1;
  const rows = `resolved approval-queue ${one ? "row" : "rows"}`;
  const headline = report.dryRun
    ? `Would delete ${report.deleted} ${rows} resolved before ${report.cutoff} ` +
      `(${report.days} days ago). Nothing was deleted.`
    : `Deleted ${report.deleted} ${rows} resolved before ${report.cutoff} ` +
      `(${report.days} days ago).`;

  return [
    headline,
    "Only applied and rejected rows are ever eligible — pending, applying and failed rows are " +
      "never pruned. " +
      (report.dryRun
        ? "The count is what is eligible right now; a row resolved before you run the real " +
          "sweep can make it differ."
        : "The count is what was eligible when the sweep started; a row resolved " +
          "between the count and the delete can make it drift by one or two."),
  ];
}

export function registerApprovals(program: Command) {
  const approvals = program
    .command("approvals")
    .description("Review and apply Gmail changes queued by actions");

  approvals
    .command("list", { isDefault: true })
    .description("List Gmail changes awaiting approval")
    .action(async () => {
      const ops = await loadPending();
      if (ops.length > 0) {
        printOperationList(await loadOperationDisplays(ops));
        console.log(
          chalk.dim(
            "\nRun `email-agent approvals review` to decide per email, or `email-agent approvals apply` for all.",
          ),
        );
      } else {
        console.log(chalk.dim("No Gmail changes awaiting approval."));
      }

      // Stranded rows are `applying`, not `pending`, so they are absent from
      // everything above. Saying "no changes awaiting approval" and stopping
      // there, while a change with an unknown effect on the mailbox sits in the
      // table, is the silence this command family existed inside until now.
      // A PLAIN DB COUNT, deliberately not a verify pass — `approvals stranded`
      // is the command that checks Gmail; this is only a pointer to it.
      const stranded = await getStaleApplyingOperations();
      if (stranded.length > 0) {
        console.log(
          chalk.red(`\n${describeStrandedHeader(stranded.length)[0]}`),
        );
        console.log(
          chalk.dim(
            "Run `email-agent approvals stranded` to check them against Gmail.",
          ),
        );
      }
    });

  approvals
    .command("review")
    .description("Review each queued change and approve or reject it")
    .option("-b, --batch <id>", "Only review one batch (id prefix allowed)")
    .action(async (options: { batch?: string }) => {
      const ops = await loadPendingBatch(options.batch);
      if (ops.length === 0) {
        console.log(chalk.dim("No Gmail changes awaiting approval."));
        return;
      }
      const decisions = await reviewOperations(await loadOperationDisplays(ops));
      if (decisions.aborted) {
        console.log(chalk.yellow(`\n${describeAbortedReview(ops.length)}`));
        process.exitCode = SIGINT_EXIT_CODE;
        return;
      }
      const commit = await commitReviewDecisions(decisions);

      for (const line of describeReviewCommit(commit)) {
        console.error(chalk.red(line));
      }

      const remaining =
        ops.length - decisions.approved.length - decisions.rejected.length;
      if (remaining > 0) {
        console.log(chalk.dim(`${remaining} changes left pending.`));
      }

      if (commitFailed(commit)) process.exitCode = 1;
    });

  approvals
    .command("apply")
    .description("Approve and apply queued changes in bulk")
    .option("-b, --batch <id>", "Only apply one batch (id prefix allowed)")
    .action(async (options: { batch?: string }) => {
      const ops = await loadPendingBatch(options.batch);
      if (ops.length === 0) {
        console.log(chalk.dim("No Gmail changes awaiting approval."));
        return;
      }
      printOperationList(await loadOperationDisplays(ops));
      const { answer, aborted } = await askOnce(
        `\nApply all ${ops.length} changes to Gmail? [y/N] `,
      );
      if (aborted) {
        console.log(chalk.yellow(`\n${describeAbortedReview(ops.length)}`));
        process.exitCode = SIGINT_EXIT_CODE;
        return;
      }
      if (!confirmedYes(answer)) {
        console.log(chalk.dim("Skipped — changes stay pending."));
        return;
      }

      try {
        const outcome = await applyOperationIds(ops.map((op) => op.id));
        // A Gmail 403 on the only approved mutation is a failure, not a
        // success with a note. Core catches per-operation Gmail errors and
        // reports them as `failed`, so an exit code taken only from a thrown
        // exception told shell automation everything worked.
        if (outcome.failed > 0) process.exitCode = 1;
      } catch (err) {
        for (const line of describeApplyFailure(ops.map((op) => op.id), err)) {
          console.error(chalk.red(line));
        }
        process.exitCode = 1;
      }
    });

  approvals
    .command("stranded")
    .description(
      "List Gmail changes stuck mid-apply, whose outcome was never recorded",
    )
    .option("-r, --review", "Decide each one after checking Gmail yourself")
    .action(async (options: { review?: boolean }) => {
      await initDb();

      // CHECKS GMAIL FIRST. This is the command whose entire job is showing
      // stranded rows, so checking them now — rather than only at `fetch`/
      // `serve` startup — is what makes it correct to say "most of these
      // resolve themselves before you ever see them" (task requirement). It is
      // still an ON-DEMAND check, fired by one explicit invocation, not a
      // timer: `verifyStrandedApplyingOperations` is gated on a cheap DB read
      // and makes zero Gmail calls when nothing is stale.
      const verified = await verifyStrandedApplyingOperations();
      for (const line of describeStrandedNotifyLines(verified)) {
        console.log(chalk.dim(line));
      }

      if (verified.unresolved.length === 0) {
        if (verified.checked === 0) {
          console.log(chalk.dim("No Gmail changes are stuck mid-apply."));
        }
        // checked > 0 && unresolved === 0: describeStrandedNotifyLines already
        // said what happened — nothing further to print, and nothing left
        // stuck, so this run succeeds.
        return;
      }

      // Only the RESIDUAL — what the check above could not resolve — ever
      // reaches a human. Re-reading rather than trusting `verified.unresolved`
      // for the row DATA (subject, batch, labels): that array carries only
      // enough to explain WHY, not enough to display or adjudicate a row.
      const ops = await getStaleApplyingOperations();
      const reasonById = new Map(verified.unresolved.map((row) => [row.id, row]));

      console.log(
        chalk.red(
          `\n${ops.length} Gmail ${ops.length === 1 ? "change" : "changes"} Email Agent checked and could not resolve automatically:`,
        ),
      );
      console.log("");

      const displays = await loadOperationDisplays(ops);
      printStrandedList(displays, reasonById);

      if (!options.review) {
        console.log(
          chalk.dim(
            "\nRun `email-agent approvals stranded --review` to record what you find in Gmail.",
          ),
        );
        // Unresolved changes to the user's mailbox are a non-zero condition:
        // shell automation that runs this should notice, not scroll past it.
        process.exitCode = 1;
        return;
      }

      const decisions = await reviewStrandedOperations(displays, {}, reasonById);
      if (decisions.aborted) {
        console.log(
          chalk.yellow(
            `\nAborted — no outcome was recorded for any of the ${ops.length} stuck ` +
              `${ops.length === 1 ? "change" : "changes"}. They are exactly as they were.`,
          ),
        );
        process.exitCode = SIGINT_EXIT_CODE;
        return;
      }
      for (const [decision, ids] of [
        ["applied", decisions.applied],
        ["notApplied", decisions.notApplied],
      ] as const) {
        if (ids.length === 0) continue;
        const resolved = await adjudicateStrandedOperations(ids, decision);
        console.log(
          chalk.dim(describeStrandedResolution(decision, ids.length, resolved)),
        );
      }

      const left = ops.length - decisions.applied.length - decisions.notApplied.length;
      if (left > 0) {
        console.log(chalk.yellow(`${left} left stuck — nothing was changed for them.`));
        process.exitCode = 1;
      }
    });

  approvals
    .command("prune")
    .description(
      "Delete resolved (applied/rejected) queue rows past the retention window",
    )
    .option(
      "-d, --older-than-days <n>",
      "Override retention.approvalQueueDays for this run",
    )
    .option("--dry-run", "Report what would be deleted without deleting it")
    .action(async (options: { olderThanDays?: string; dryRun?: boolean }) => {
      // WHY THIS COMMAND EXISTS. The sweep was opportunistic — it ran after
      // every apply/reject and reported to nobody — so a user could not answer
      // "what has been deleted from my audit trail, and when will the rest
      // go?". A retention policy nothing can inspect is indistinguishable from
      // data loss.
      let days: number;
      if (options.olderThanDays === undefined) {
        days = (await loadSettings()).retention.approvalQueueDays;
      } else {
        if (!/^[0-9]+$/.test(options.olderThanDays)) {
          console.error(
            chalk.red(
              `Invalid --older-than-days "${options.olderThanDays}": must be a whole number of days (0 disables pruning).`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        days = Number(options.olderThanDays);
      }

      const cutoff = resolveRetentionCutoff(days);
      await initDb();

      // Counted only for a dry run, and be honest about what this count is: it
      // is a SECOND predicate written to match `buildPruneFilter`, not the same
      // one. `prunePendingOperations` deletes through SQL and LanceDB's
      // `delete()` reports no row count, so there is nothing to reuse here.
      // Equivalent today; it can drift, so `approvals-prune.e2e.test.ts` pins
      // the preview count against what the real sweep deletes.
      const eligible =
        cutoff === null || !options.dryRun
          ? 0
          : (await getPendingOperations({ status: "applied" }))
              .concat(await getPendingOperations({ status: "rejected" }))
              .filter((op) => op.resolvedAt !== "" && op.resolvedAt < cutoff)
              .length;

      const deleted =
        cutoff === null
          ? 0
          : options.dryRun
            ? eligible
            : await prunePendingOperations(cutoff);

      const lines = describePrune({
        days,
        cutoff,
        deleted,
        dryRun: Boolean(options.dryRun),
      });
      if (options.dryRun && cutoff !== null) {
        console.log(
          chalk.yellow(
            `Dry run — the queue was not touched.`,
          ),
        );
      }
      const [headline, ...rest] = lines;
      console.log(headline);
      for (const line of rest) console.log(chalk.dim(line));
    });

  approvals
    .command("reject")
    .description("Reject queued changes in bulk (never applied)")
    .option("-b, --batch <id>", "Only reject one batch (id prefix allowed)")
    .action(async (options: { batch?: string }) => {
      const ops = await loadPendingBatch(options.batch);
      if (ops.length === 0) {
        console.log(chalk.dim("No Gmail changes awaiting approval."));
        return;
      }
      await rejectOperationIds(ops.map((op) => op.id));
    });
}

async function loadPendingBatch(
  batchPrefix?: string,
): Promise<PendingOperationRecord[]> {
  if (!batchPrefix) return loadPending();
  // Allow the short batch prefix shown by `approvals list`.
  const all = await loadPending();
  const matched = all.filter((op) => op.batchId.startsWith(batchPrefix));

  // An ambiguous prefix on a bulk apply/reject would silently act on more
  // batches than the user named, so refuse rather than guess.
  const batchIds = new Set(matched.map((op) => op.batchId));
  if (batchIds.size > 1) {
    console.error(
      chalk.red(
        `Batch prefix "${batchPrefix}" matches ${batchIds.size} batches:`,
      ),
    );
    for (const id of batchIds) console.error(chalk.dim(`  ${id}`));
    console.error(chalk.yellow("Re-run with a longer prefix."));
    process.exit(1);
  }
  return matched;
}
