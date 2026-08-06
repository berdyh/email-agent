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
import {
  applyOperationIds,
  loadOperationDisplays,
  printOperationList,
  rejectOperationIds,
  reviewOperations,
} from "./approvals.js";

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
          if (result.queueError) {
            console.log(
              chalk.red(
                `\nThe action proposed Gmail changes but they could not be queued for approval — nothing was applied.`,
              ),
            );
            console.log(chalk.dim(`  ${result.queueError}`));
          } else if (result.applyResult) {
            const { applied, failed } = result.applyResult;
            console.log(
              chalk.yellow(
                `\nAuto-apply is ON — applied ${applied} Gmail changes without asking`,
              ) + (failed > 0 ? chalk.red(`, ${failed} failed`) : ""),
            );
            for (const err of result.applyResult.errors) {
              console.log(chalk.red(`  ${err.emailId}: ${err.error}`));
            }
            console.log(
              chalk.dim(
                "Disable it in the web UI under Settings → Gmail to review changes before they apply.",
              ),
            );
          } else if (result.pendingOperations?.length && result.batchId) {
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
    console.log(
      chalk.yellow(
        "\nThe action proposed Gmail changes but they could not be queued for approval — nothing was applied.",
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
    await applyOperationIds(ops.map((op) => op.id));
  } else if (answer === "r") {
    const { approved, rejected } = await reviewOperations(displays);
    await applyOperationIds(approved);
    await rejectOperationIds(rejected);
  } else {
    console.log(
      chalk.dim(
        "Left pending — review later with `email-agent approvals` or in the web UI.",
      ),
    );
  }
}
