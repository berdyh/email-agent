import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { syncEmails, verifyStrandedApplyingOperations } from "@email-agent/core";
import { describeStrandedNotifyLines } from "./approvals.js";

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
    .option("-a, --account <email>", "Email account to fetch from")
    .action(async (options: { limit: string; scope: string; account?: string }) => {
      if (!/^[0-9]+$/.test(options.limit) || Number(options.limit) <= 0) {
        console.error(chalk.red(`Invalid --limit "${options.limit}": must be a positive integer`));
        process.exit(1);
      }
      const limit = Number(options.limit);

      if (options.scope !== "all" && options.scope !== "unread") {
        console.error(chalk.red(`Invalid --scope "${options.scope}": must be "all" or "unread"`));
        process.exit(1);
      }
      const scope = options.scope === "all" ? "all" as const : "unread" as const;
      const accountLabel = options.account ? ` for ${options.account}` : "";

      const spinner = ora(
        `Fetching ${scope === "all" ? "all" : "unread"} emails${accountLabel}...`,
      ).start();

      try {
        const result = await syncEmails({ scope, maxResults: limit, accountEmail: options.account });

        spinner.succeed(`Stored ${result.fetched} emails with embeddings`);
        console.log(
          chalk.green(
            `\nRun ${chalk.cyan("email-agent serve")} to view them.\n`,
          ),
        );

        // D1 (owner's decision): verification runs automatically here, GATED
        // ON A CHEAP DB READ FIRST — `verifyStrandedApplyingOperations` returns
        // immediately with zero Gmail calls when nothing is stale, so the
        // happy path (nothing stranded) prints nothing extra at all. A failure
        // here must never break a fetch that otherwise succeeded — it is
        // wrapped in its own try/catch and prints one honest line instead.
        //
        // THE HANG IS BOUNDED TOO, and this command needed it as much as
        // `serve` did even though it is already network-bound: being network-
        // bound is not the same as being bounded. The fetch above has finished
        // and its result is already printed by the time this runs, so an
        // unbounded pass could not corrupt anything — it could only leave the
        // command sitting there forever after saying it was done, which is its
        // own kind of broken. The per-read timeout in `gmail/read.ts` plus the
        // pass budget in `verify-stranded.ts` cap this block at 30s (20s budget
        // + the one 10s read that may start just inside it), and that is all
        // this command needs; nothing here has to be re-ordered.
        try {
          const verified = await verifyStrandedApplyingOperations();
          for (const line of describeStrandedNotifyLines(verified)) {
            console.log(chalk.yellow(line));
          }
        } catch (verifyErr) {
          console.log(
            chalk.yellow(
              `Could not check for Gmail changes stuck mid-apply: ` +
                `${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}. ` +
                `Your fetch still succeeded.`,
            ),
          );
        }
      } catch (err) {
        spinner.fail("Failed to fetch emails");
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
    });
}
