import type { Command } from "commander";
import { execFileSync } from "node:child_process";
import chalk from "chalk";
import ora from "ora";

const MARKER = "# email-agent-cron";

function getCurrentCrontab(): string {
  try {
    return execFileSync("crontab", ["-l"], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch {
    return "";
  }
}

function setCrontab(content: string): void {
  execFileSync("crontab", ["-"], {
    encoding: "utf-8",
    input: content,
  });
}

function removeAgentEntries(crontab: string): string {
  return crontab
    .split("\n")
    .filter((line) => !line.includes(MARKER))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n");
}

function resolveNpxPath(): string {
  try {
    return execFileSync("which", ["npx"], { encoding: "utf-8" }).trim();
  } catch {
    return "npx";
  }
}

export function registerCron(program: Command) {
  const cron = program
    .command("cron")
    .description("Manage scheduled email fetching via crontab");

  cron
    .command("setup")
    .description("Install a crontab entry for periodic email fetching")
    .option(
      "-i, --interval <minutes>",
      "Fetch interval in minutes (1, 5, 10, 30)",
      "5",
    )
    .option(
      "-s, --scope <scope>",
      'Fetch scope: "unread" or "all"',
      "unread",
    )
    .option("-l, --limit <n>", "Maximum emails per fetch", "20")
    .action(
      (options: { interval: string; scope: string; limit: string }) => {
        const interval = parseInt(options.interval, 10);
        if (![1, 5, 10, 30].includes(interval)) {
          console.error(
            chalk.red("Interval must be one of: 1, 5, 10, 30 (minutes)"),
          );
          process.exit(1);
        }

        const scope = options.scope === "all" ? "all" : "unread";
        const limit = options.limit;
        const npx = resolveNpxPath();

        const spinner = ora("Setting up crontab entry...").start();

        const crontab = getCurrentCrontab();
        const cleaned = removeAgentEntries(crontab);
        const entry = `*/${interval} * * * * ${npx} email-agent fetch --scope ${scope} --limit ${limit} ${MARKER}`;
        const updated = cleaned.trimEnd() + "\n" + entry + "\n";

        setCrontab(updated);

        spinner.succeed(
          `Crontab installed: fetch ${scope} emails every ${interval} minutes`,
        );
        console.log(chalk.dim(`  ${entry}`));
      },
    );

  cron
    .command("remove")
    .description("Remove the email-agent crontab entry")
    .action(() => {
      const spinner = ora("Removing crontab entry...").start();

      const crontab = getCurrentCrontab();
      if (!crontab.includes(MARKER)) {
        spinner.info("No email-agent crontab entry found");
        return;
      }

      const cleaned = removeAgentEntries(crontab);
      setCrontab(cleaned);

      spinner.succeed("Removed email-agent crontab entry");
    });

  cron
    .command("status")
    .description("Show the current email-agent crontab entry")
    .action(() => {
      const crontab = getCurrentCrontab();
      const entries = crontab
        .split("\n")
        .filter((line) => line.includes(MARKER));

      if (entries.length === 0) {
        console.log(chalk.dim("No email-agent crontab entry configured."));
        console.log(
          chalk.dim(`Run ${chalk.cyan("email-agent cron setup")} to add one.`),
        );
        return;
      }

      console.log(chalk.bold("Active email-agent crontab:"));
      for (const entry of entries) {
        console.log(chalk.green(`  ${entry.replace(MARKER, "").trim()}`));
      }
    });
}
