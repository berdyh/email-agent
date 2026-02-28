import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { syncEmails } from "@email-agent/core";

export function registerFetch(program: Command) {
  program
    .command("fetch")
    .description("Fetch emails from Gmail and store in the database")
    .option("-l, --limit <n>", "Maximum emails to fetch", "20")
    .option(
      "-s, --scope <scope>",
      'Fetch scope: "unread" or "all"',
      "unread",
    )
    .action(async (options: { limit: string; scope: string }) => {
      const limit = parseInt(options.limit, 10);
      const scope = options.scope === "all" ? "all" as const : "unread" as const;

      const spinner = ora(
        `Fetching ${scope === "all" ? "all" : "unread"} emails...`,
      ).start();

      try {
        const result = await syncEmails({ scope, maxResults: limit });

        spinner.succeed(`Stored ${result.fetched} emails with embeddings`);
        console.log(
          chalk.green(
            `\nRun ${chalk.cyan("email-agent serve")} to view them.\n`,
          ),
        );
      } catch (err) {
        spinner.fail("Failed to fetch emails");
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
    });
}
