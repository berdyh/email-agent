import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import {
  checkGcloudAuth,
  loginGcloud,
  initDb,
  saveSettings,
  loadSettings,
} from "@gmail-reader/core";

export function registerSetup(program: Command) {
  program
    .command("setup")
    .description("Set up Gmail Reader (authenticate, configure project, initialize database)")
    .option("--project <id>", "Google Cloud project ID")
    .action(async (options: { project?: string }) => {
      console.log(chalk.bold("\nGmail Reader Setup\n"));

      // Step 1: Check gcloud
      const spinner = ora("Checking gcloud CLI...").start();
      try {
        const authed = await checkGcloudAuth();
        if (authed) {
          spinner.succeed("gcloud CLI authenticated");
        } else {
          spinner.warn("gcloud CLI not authenticated");
          console.log(
            chalk.yellow("\nRun the following to authenticate:"),
          );
          console.log(
            chalk.cyan(
              "  gcloud auth application-default login --scopes=https://www.googleapis.com/auth/gmail.readonly,https://www.googleapis.com/auth/pubsub\n",
            ),
          );
          await loginGcloud();
          console.log(chalk.green("Authentication complete.\n"));
        }
      } catch {
        spinner.fail("gcloud CLI not found. Install: https://cloud.google.com/sdk/docs/install");
        process.exit(1);
      }

      // Step 2: Set project
      if (options.project) {
        const settings = await loadSettings();
        settings.gcp.projectId = options.project;
        await saveSettings(settings);
        console.log(chalk.green(`Project set to: ${options.project}`));
      }

      // Step 3: Init DB
      const dbSpinner = ora("Initializing database...").start();
      await initDb();
      dbSpinner.succeed("Database initialized");

      console.log(chalk.bold.green("\nSetup complete!"));
      console.log(`  Run ${chalk.cyan("gmail-reader fetch")} to fetch emails`);
      console.log(`  Run ${chalk.cyan("gmail-reader serve")} to start the web UI\n`);
    });
}
