import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  initDb,
  getPendingOperations,
  applyPendingOperationsByIds,
  rejectPendingOperationsByIds,
  describeGmailOperation,
  parseLabelIds,
} from "@email-agent/core";
import type { PendingOperationRecord } from "@email-agent/core";
import { emailRefKey, getEmailsByRefs } from "../email-lookup.js";

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

export async function applyOperationIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const spinner = ora(`Applying ${ids.length} changes to Gmail...`).start();
  const result = await applyPendingOperationsByIds(ids);
  // Core claims each row before touching Gmail and reports one applied-or-failed
  // entry per claimed row, so the remainder was already resolved elsewhere.
  const skipped = Math.max(0, ids.length - (result.applied + result.failed));

  if (result.applied === 0 && result.failed === 0 && skipped > 0) {
    spinner.warn(
      `None of the ${skipped} change${skipped === 1 ? "" : "s"} was still pending — ` +
        `already applied or rejected elsewhere. Nothing was sent to Gmail.`,
    );
    return;
  }

  const skippedNote = skipped > 0 ? `, ${skipped} already resolved elsewhere` : "";
  if (result.failed > 0) {
    spinner.warn(
      `Applied ${result.applied} changes, ${chalk.red(`${result.failed} failed`)}${skippedNote}`,
    );
    for (const err of result.errors) {
      console.log(chalk.red(`  ${err.emailId}: ${err.error}`));
    }
  } else if (skipped > 0) {
    spinner.warn(`Applied ${result.applied} changes to Gmail${skippedNote}`);
  } else {
    spinner.succeed(`Applied ${result.applied} changes to Gmail`);
  }
}

export async function rejectOperationIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rejected = await rejectPendingOperationsByIds(ids);
  const skipped = Math.max(0, ids.length - rejected);
  console.log(
    chalk.dim(
      `Rejected ${rejected} pending changes.` +
        (skipped > 0 ? ` ${skipped} were already resolved elsewhere.` : ""),
    ),
  );
}

export interface ReviewCommitResult {
  approvedIds: string[];
  rejectedIds: string[];
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
    applyIds: (ids: string[]) => Promise<void>;
    rejectIds: (ids: string[]) => Promise<void>;
  } = { applyIds: applyOperationIds, rejectIds: rejectOperationIds },
): Promise<ReviewCommitResult> {
  const result: ReviewCommitResult = {
    approvedIds: decisions.approved,
    rejectedIds: decisions.rejected,
  };

  try {
    await handlers.rejectIds(decisions.rejected);
  } catch (err) {
    result.rejectError = err;
  }

  try {
    await handlers.applyIds(decisions.approved);
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
 */
export function describeReviewCommit(result: ReviewCommitResult): string[] {
  const lines: string[] = [];

  if (result.rejectError) {
    lines.push(
      `Failed to record ${result.rejectedIds.length} rejection${result.rejectedIds.length === 1 ? "" : "s"}: ${errorText(result.rejectError)}`,
    );
    lines.push(
      "Those changes are still pending — nothing was applied to Gmail for them. Re-run `email-agent approvals review` to answer again.",
    );
  }

  if (result.applyError) {
    lines.push(
      `Failed to apply ${result.approvedIds.length} approved change${result.approvedIds.length === 1 ? "" : "s"}: ${errorText(result.applyError)}`,
    );
    if (result.rejectedIds.length > 0 && !result.rejectError) {
      lines.push(
        `Your ${result.rejectedIds.length} rejection${result.rejectedIds.length === 1 ? " was" : "s were"} already recorded and are not affected.`,
      );
    }
    lines.push(
      "Some of the approved changes may have reached Gmail before the failure; the rest stay queued. Run `email-agent approvals list` to see what is left.",
    );
  }

  return lines;
}

/**
 * Steps through operations one by one; each answer is the user's personal
 * decision for that email. Unanswered operations (skip/quit) stay queued.
 */
export async function reviewOperations(
  displays: OperationDisplay[],
): Promise<{ approved: string[]; rejected: string[] }> {
  const approved: string[] = [];
  const rejected: string[] = [];
  const rl = createInterface({ input: process.stdin, output: process.stdout });

  try {
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

      const answer = (
        await rl.question(
          "  Apply? [y]es / [n]o, reject / [s]kip, keep pending / [q]uit: ",
        )
      )
        .trim()
        .toLowerCase();

      if (answer === "y") approved.push(op.id);
      else if (answer === "n") rejected.push(op.id);
      else if (answer === "q") break;
      // anything else (including "s") keeps the operation queued
    }
  } finally {
    rl.close();
  }

  return { approved, rejected };
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
      if (ops.length === 0) {
        console.log(chalk.dim("No Gmail changes awaiting approval."));
        return;
      }
      printOperationList(await loadOperationDisplays(ops));
      console.log(
        chalk.dim(
          "\nRun `email-agent approvals review` to decide per email, or `email-agent approvals apply` for all.",
        ),
      );
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
      const commit = await commitReviewDecisions(decisions);

      for (const line of describeReviewCommit(commit)) {
        console.error(chalk.red(line));
      }

      const remaining =
        ops.length - decisions.approved.length - decisions.rejected.length;
      if (remaining > 0) {
        console.log(chalk.dim(`${remaining} changes left pending.`));
      }

      if (commit.applyError || commit.rejectError) process.exitCode = 1;
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
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = await rl.question(
          `\nApply all ${ops.length} changes to Gmail? [y/N] `,
        );
        if (answer.trim().toLowerCase() !== "y") {
          console.log(chalk.dim("Skipped — changes stay pending."));
          return;
        }
      } finally {
        rl.close();
      }
      await applyOperationIds(ops.map((op) => op.id));
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
