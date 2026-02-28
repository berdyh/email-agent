import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  initDb,
  getEmails,
  ActionRegistry,
  ActionRunner,
  applyOperations,
  summarizeOperations,
} from "@email-agent/core";
import type { GmailOperation } from "@email-agent/core";

export function registerRunAction(program: Command) {
  program
    .command("run-action <actionId>")
    .description("Run an action on unread emails")
    .option("-l, --limit <n>", "Maximum emails to process", "20")
    .action(async (actionId: string, options: { limit: string }) => {
      const limit = parseInt(options.limit, 10);

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
        const emailRecords = await getEmails({ unreadOnly: true, limit });
        const emails = emailRecords.map((e) => ({
          id: e.id,
          threadId: e.threadId,
          from: e.from,
          to: e.to,
          subject: e.subject,
          date: e.date,
          bodyText: e.bodyText,
          bodyHtml: e.bodyHtml,
          labels: JSON.parse(e.labels as string) as string[],
          isUnread: e.isUnread,
          senderDomain: e.senderDomain,
          snippet: e.snippet,
        }));

        const runner = new ActionRunner();
        const result = await runner.run(action, emails);

        if (result.status === "success") {
          spinner.succeed(
            `"${action.name}" completed (${result.durationMs}ms, ${result.tokensUsed} tokens)`,
          );
          console.log(chalk.dim(JSON.stringify(result.output, null, 2)));

          // Show auto-applied results
          if (result.applyResult) {
            const { applied, failed } = result.applyResult;
            console.log(
              chalk.green(`\nAuto-applied: ${applied} operations`) +
                (failed > 0 ? chalk.red(`, ${failed} failed`) : ""),
            );
          }

          // Prompt for pending operations
          if (result.pendingOperations?.length) {
            await promptApplyOperations(result.pendingOperations);
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

async function promptApplyOperations(
  operations: GmailOperation[],
): Promise<void> {
  const summary = summarizeOperations(operations);
  const summaryStr = Object.entries(summary)
    .map(([type, count]) => `${count} ${type}`)
    .join(", ");

  console.log(chalk.yellow(`\nPending Gmail changes: ${summaryStr}`));

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question("Apply changes to Gmail? [y/N] ");
    if (answer.trim().toLowerCase() === "y") {
      const applySpinner = ora("Applying changes to Gmail...").start();
      const result = await applyOperations(operations);
      applySpinner.succeed(
        `Applied ${result.applied} operations` +
          (result.failed > 0 ? chalk.red(`, ${result.failed} failed`) : ""),
      );
      if (result.errors.length > 0) {
        for (const err of result.errors) {
          console.log(chalk.red(`  ${err.emailId}: ${err.error}`));
        }
      }
    } else {
      console.log(chalk.dim("Skipped."));
    }
  } finally {
    rl.close();
  }
}
