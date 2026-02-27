import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  initDb,
  upsertEmails,
  generateEmbeddings,
  fetchUnreadEmails,
  type GmailMessage,
} from "@email-agent/core";

export function registerFetch(program: Command) {
  program
    .command("fetch")
    .description("Fetch unread emails from Gmail and store in the database")
    .option("-l, --limit <n>", "Maximum emails to fetch", "20")
    .action(async (options: { limit: string }) => {
      const limit = parseInt(options.limit, 10);

      await initDb();

      const spinner = ora("Fetching unread emails...").start();

      try {
        const emails: GmailMessage[] = await fetchUnreadEmails(limit);
        spinner.text = `Fetched ${emails.length} emails. Generating embeddings...`;

        // Generate embeddings
        const texts = emails.map(
          (e) => `${e.subject}\n${e.from}\n${e.bodyText.slice(0, 500)}`,
        );
        const vectors = await generateEmbeddings(texts);

        // Convert to DB records and store
        const records = emails.map((e, i) => ({
          id: e.id,
          threadId: e.threadId,
          from: e.from,
          to: e.to,
          subject: e.subject,
          date: e.date,
          bodyText: e.bodyText,
          bodyHtml: e.bodyHtml,
          labels: JSON.stringify(e.labels),
          isUnread: e.isUnread,
          senderDomain: e.senderDomain,
          snippet: e.snippet,
          vector: vectors[i] ?? Array(768).fill(0) as number[],
        }));

        await upsertEmails(records);

        spinner.succeed(
          `Stored ${emails.length} emails with embeddings`,
        );
        console.log(
          chalk.green(`\nRun ${chalk.cyan("email-agent serve")} to view them.\n`),
        );
      } catch (err) {
        spinner.fail("Failed to fetch emails");
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }
    });
}
