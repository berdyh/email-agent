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
  parseLabelIds,
  STALE_APPLYING_THRESHOLD_MS,
} from "@email-agent/core";
import type {
  ActionApplyResult,
  PendingOperationRecord,
  StrandedDecision,
} from "@email-agent/core";
import { emailRefKey, getEmailsByRefs } from "../email-lookup.js";
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
  const emails = await getEmailsByRefs(
    ops.map((op) => ({ accountId: op.accountId, emailId: op.emailId })),
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

  const apply = deps.apply ?? applyPendingOperationsByIds;
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

  const reject = deps.reject ?? rejectPendingOperationsByIds;
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
 * Every claim in it is one we can actually support: the process died mid-apply,
 * we never recorded the outcome, and we have not checked. It must never suggest
 * the CLI can find out, because it cannot.
 */
export function describeStrandedHeader(count: number): string[] {
  const one = count === 1;
  const minutes = Math.round(STALE_APPLYING_THRESHOLD_MS / 60_000);
  return [
    `${count} Gmail ${one ? "change is" : "changes are"} stuck mid-apply — ` +
      `we do not know whether ${one ? "it" : "they"} reached Gmail.`,
    `A run was interrupted after ${one ? "this change was" : "these changes were"} sent to ` +
      `Gmail, or just before; Email Agent could not record which. It has not checked and it ` +
      `cannot. Open Gmail, look, then tell it what you found.`,
    `(Listed after ${minutes} minutes with no recorded result. They are not pending, so ` +
      `\`approvals list\`, \`apply\` and \`reject\` do not see them.)`,
  ];
}

/**
 * Why a row this command listed as stuck was not written.
 *
 * Mirrors the web wording (`approvals-contract.ts`) and follows the precedent
 * `describeApplyOutcome` above already sets: state what is certain, offer the
 * rest as possibilities. The earlier version asserted one cause as fact — that
 * a still-running apply had finished the row and its outcome was kept — when
 * the row could equally have been answered by another adjudication, whose
 * "outcome" is another unverified assertion by a person, or requeued and
 * re-claimed by a fresh apply, which makes it too new to adjudicate at all.
 */
function strandedSkipReasons(one: boolean): string {
  return (
    `An apply that was still running may have finished ${one ? "it" : "them"} and recorded a real ` +
    `outcome; another answer (the web UI, or another shell) may already have been recorded; or ` +
    `${one ? "it" : "they"} may have been requeued and picked up by a fresh apply, which makes ` +
    `${one ? "it" : "them"} too new to adjudicate. Run \`email-agent approvals stranded\` again to ` +
    `see where ${one ? "it stands" : "they stand"}.`
  );
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

function printStrandedList(displays: OperationDisplay[]): void {
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
      const stranded = await getStaleApplyingOperations();
      if (stranded.length > 0) {
        console.log(
          chalk.red(`\n${describeStrandedHeader(stranded.length)[0]}`),
        );
        console.log(
          chalk.dim(
            "Run `email-agent approvals stranded` to see them.",
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
      const ops = await getStaleApplyingOperations();
      if (ops.length === 0) {
        console.log(chalk.dim("No Gmail changes are stuck mid-apply."));
        return;
      }

      const [headline, ...rest] = describeStrandedHeader(ops.length);
      console.log(chalk.red(`\n${headline}`));
      for (const line of rest) console.log(chalk.dim(line));
      console.log("");

      const displays = await loadOperationDisplays(ops);
      printStrandedList(displays);

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

      const decisions = await reviewStrandedOperations(displays);
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
