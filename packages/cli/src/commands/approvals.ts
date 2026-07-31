import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  initDb,
  getEmailById,
  getPendingOperations,
  applyPendingOperationsByIds,
  rejectPendingOperationsByIds,
} from "@email-agent/core";
import type { PendingOperationRecord } from "@email-agent/core";

export function describeOperation(op: PendingOperationRecord): string {
  const labels = JSON.parse(op.labelIds) as string[];
  switch (op.type) {
    case "trash":
      return "Move to Trash";
    case "spam":
      return "Mark as Spam";
    case "markRead":
      return "Mark as Read";
    case "markUnread":
      return "Mark as Unread";
    case "removeLabels":
      return labels.length === 1 && labels[0] === "INBOX"
        ? "Archive"
        : `Remove labels: ${labels.join(", ")}`;
    case "addLabels":
      return `Add labels: ${labels.join(", ")}`;
    default:
      return op.type;
  }
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
  const displays: OperationDisplay[] = [];
  for (const op of ops) {
    const email = await getEmailById(op.emailId, op.accountId);
    displays.push({
      op,
      subject: email?.subject ?? `(not in local DB: ${op.emailId})`,
      from: email?.from ?? "",
      snippet: email?.snippet ?? "",
    });
  }
  return displays;
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
  if (result.failed > 0) {
    spinner.warn(
      `Applied ${result.applied} changes, ${chalk.red(`${result.failed} failed`)}`,
    );
    for (const err of result.errors) {
      console.log(chalk.red(`  ${err.emailId}: ${err.error}`));
    }
  } else {
    spinner.succeed(`Applied ${result.applied} changes to Gmail`);
  }
}

export async function rejectOperationIds(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  const rejected = await rejectPendingOperationsByIds(ids);
  console.log(chalk.dim(`Rejected ${rejected} pending changes.`));
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
      const { approved, rejected } = await reviewOperations(
        await loadOperationDisplays(ops),
      );
      await applyOperationIds(approved);
      await rejectOperationIds(rejected);
      const remaining = ops.length - approved.length - rejected.length;
      if (remaining > 0) {
        console.log(chalk.dim(`${remaining} changes left pending.`));
      }
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
  return all.filter((op) => op.batchId.startsWith(batchPrefix));
}
