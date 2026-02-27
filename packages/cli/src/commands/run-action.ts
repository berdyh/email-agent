import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  initDb,
  getEmails,
  ActionRegistry,
  ActionRunner,
} from "@email-agent/core";

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
