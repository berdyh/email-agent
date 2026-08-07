import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  initDb,
  getEmails,
  getPendingOperations,
  recordToGmailMessage,
  ActionRegistry,
  ActionRunner,
  buildOperationAccountLookup,
} from "@email-agent/core";
import type { ActionRunResult } from "@email-agent/core";
import {
  applyOperationIds,
  commitFailed,
  commitReviewDecisions,
  describeApplyFailure,
  describeReviewCommit,
  loadOperationDisplays,
  printOperationList,
  reviewOperations,
} from "./approvals.js";

export interface RunOutcomeLine {
  tone: "error" | "warn" | "info";
  text: string;
}

/** "3 identical changes were already awaiting approval" — see the web twin. */
function describeDuplicates(duplicates: number): string {
  const one = duplicates === 1;
  return (
    `${duplicates} identical ${one ? "change was" : "changes were"} already awaiting ` +
    `approval and ${one ? "was" : "were"} not queued again.`
  );
}

/**
 * What the CLI prints after a run, and — by omission — what it must NOT print.
 *
 * Pure, so the honesty of these sentences is under test rather than read off
 * the code. The branch that matters is `applyError`: the opt-in auto-apply threw
 * AFTER `applyPendingOperationsByIds` had claimed rows and called Gmail, so mail
 * may really have been trashed. The CLI used to miss that entirely — it read
 * only `queueError`, which is unset on this path, and then prompted on whatever
 * was still `status: "pending"` for the batch. With a single-chunk abort nothing
 * was left pending and it printed "nothing was applied"; with a multi-chunk
 * abort it cheerfully offered to apply the remaining ids and never mentioned the
 * chunk that may already have hit Gmail. Both answers were false about the same
 * mailbox.
 *
 * So `applyError` outranks everything, prints core's own wording verbatim, and
 * the caller does not prompt when it is set.
 */
export function describeRunOutcome(result: ActionRunResult): RunOutcomeLine[] {
  if (result.applyError) {
    return [
      { tone: "error", text: `\n${result.applyError}` },
      {
        tone: "warn",
        text:
          "Run `email-agent approvals stranded` to see the changes whose outcome was never " +
          "recorded, check them in Gmail, and tell it what you found.",
      },
    ];
  }

  if (result.queueError) {
    // When the parent history row is what failed, core's `queueError` is
    // already a complete sentence saying nothing was applied; do not say it
    // twice.
    return result.persistError
      ? [{ tone: "error", text: `\n${result.queueError}` }]
      : [
          {
            tone: "error",
            text:
              "\nThe action proposed Gmail changes but they could not be queued for approval — " +
              "nothing was applied.",
          },
          { tone: "info", text: `  ${result.queueError}` },
        ];
  }

  const lines: RunOutcomeLine[] = [];

  if (result.persistError) {
    // Reachable only with no proposed operations: with operations in hand core
    // fails closed and sets `queueError` too.
    lines.push({
      tone: "warn",
      text:
        `\nThe run finished but its result could not be saved to history ` +
        `(${result.persistError}). It proposed no Gmail changes, so nothing was applied.`,
    });
  }

  if (result.applyResult) {
    const { applied, failed } = result.applyResult;
    lines.push({
      tone: "warn",
      text:
        `\nAuto-apply is ON — applied ${applied} Gmail changes without asking` +
        (failed > 0 ? `, ${failed} failed` : ""),
    });
    lines.push({
      tone: "info",
      text: "Disable it in the web UI under Settings → Gmail to review changes before they apply.",
    });
  }

  if (result.duplicateOperations && result.duplicateOperations > 0) {
    lines.push({ tone: "info", text: describeDuplicates(result.duplicateOperations) });
  }

  return lines;
}

export function registerRunAction(program: Command) {
  program
    .command("run-action <actionId>")
    .description("Run an action on unread emails")
    .option("-l, --limit <n>", "Maximum emails to process", "20")
    .option("-a, --account <email>", "Account to run action on")
    .action(async (actionId: string, options: { limit: string; account?: string }) => {
      if (!/^[0-9]+$/.test(options.limit) || Number(options.limit) <= 0) {
        console.error(chalk.red(`Invalid --limit "${options.limit}": must be a positive integer`));
        process.exit(1);
      }
      const limit = Number(options.limit);

      await initDb();

      const registry = new ActionRegistry();
      await registry.loadAll();

      const action = registry.get(actionId);
      if (!action) {
        console.error(chalk.red(`Action "${actionId}" not found.`));
        console.log(chalk.yellow("\nAvailable actions:"));
        for (const a of registry.getAll()) {
          console.log(`  ${chalk.cyan(a.id)} — ${a.name}`);
        }
        process.exit(1);
      }

      const spinner = ora(`Running "${action.name}"...`).start();

      try {
        const emailRecords = await getEmails({ unreadOnly: true, limit, accountId: options.account });
        const emails = emailRecords.map(recordToGmailMessage);

        const runner = new ActionRunner();
        const result = await runner.run(
          action,
          emails,
          options.account,
          buildOperationAccountLookup(emailRecords),
        );

        if (result.status === "success") {
          spinner.succeed(
            `"${action.name}" completed (${result.durationMs}ms, ${result.tokensUsed} tokens)`,
          );
          console.log(chalk.dim(JSON.stringify(result.output, null, 2)));

          // Gmail changes are queued first. They are only applied without a
          // prompt when the user turned on auto-apply and accepted its
          // warnings in Settings; otherwise ask for approval here.
          const paint = { error: chalk.red, warn: chalk.yellow, info: chalk.dim };
          for (const line of describeRunOutcome(result)) {
            console.log(paint[line.tone](line.text));
          }

          if (result.applyError) {
            // NOT a prompt. The rows this batch queued were claimed and Gmail
            // may already have been called, so offering to "apply the rest"
            // here is how the CLI came to invite a second trash of mail it had
            // very likely already trashed. Adjudication is a separate,
            // deliberate step.
            process.exitCode = 1;
          } else if (result.applyResult) {
            for (const err of result.applyResult.errors) {
              console.log(chalk.red(`  ${err.emailId}: ${err.error}`));
            }
          } else if (!result.queueError && result.pendingOperations?.length && result.batchId) {
            await promptApproval(result.batchId);
          }
        } else {
          spinner.fail(`"${action.name}" failed: ${result.error}`);
        }
      } catch (err) {
        spinner.fail("Action failed");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}

async function promptApproval(batchId: string): Promise<void> {
  const ops = await getPendingOperations({ status: "pending", batchId });
  if (ops.length === 0) {
    // The rows WERE queued — the caller only reaches this function when the
    // enqueue returned ids and `queueError`/`applyError` are both unset. So an
    // empty pending list means something else resolved them between the run and
    // this prompt (another shell, the web panel, a concurrent auto-apply).
    // Claiming "they could not be queued — nothing was applied", which is what
    // this used to say, asserts the mailbox is untouched when we have no idea.
    console.log(
      chalk.yellow(
        "\nThis run's Gmail changes are no longer awaiting approval — something else " +
          "claimed or resolved them while the action was running.",
      ),
    );
    console.log(
      chalk.dim(
        "Run `email-agent approvals list` to see what is still pending, and " +
          "`email-agent approvals stranded` for any change whose outcome was never recorded.",
      ),
    );
    return;
  }

  console.log(chalk.yellow(`\nGmail changes awaiting your approval:`));
  const displays = await loadOperationDisplays(ops);
  printOperationList(displays);

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let answer: string;
  try {
    answer = (
      await rl.question(
        "\nApply? [a]ll / [r]eview each / [s]kip for later [a/r/S] ",
      )
    )
      .trim()
      .toLowerCase();
  } finally {
    rl.close();
  }

  if (answer === "a") {
    const ids = ops.map((op) => op.id);
    try {
      const outcome = await applyOperationIds(ids);
      if (outcome.failed > 0) process.exitCode = 1;
    } catch (err) {
      for (const line of describeApplyFailure(ids, err)) {
        console.error(chalk.red(line));
      }
      process.exitCode = 1;
    }
  } else if (answer === "r") {
    // Route through `commitReviewDecisions` rather than calling the two halves
    // directly: it rejects FIRST, so a Gmail failure part-way through the apply
    // cannot discard the "no" answers the user just typed — the bug that was
    // fixed in `approvals review` and left in place here — and it reports what
    // was actually recorded rather than what was requested.
    const commit = await commitReviewDecisions(await reviewOperations(displays));
    for (const line of describeReviewCommit(commit)) {
      console.error(chalk.red(line));
    }
    if (commitFailed(commit)) process.exitCode = 1;
  } else {
    console.log(
      chalk.dim(
        "Left pending — review later with `email-agent approvals` or in the web UI.",
      ),
    );
  }
}
