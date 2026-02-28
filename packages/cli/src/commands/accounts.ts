import type { Command } from "commander";
import chalk from "chalk";
import ora from "ora";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import {
  listAccounts,
  addAccount,
  removeAccount,
  setDefaultAccount,
  getOAuthCredentials,
  generateAuthUrl,
  exchangeCode,
} from "@email-agent/core";

const REDIRECT_URI = "http://localhost:9876/callback";

function waitForAuthCode(port: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = createServer((req: IncomingMessage, res: ServerResponse) => {
      const url = new URL(req.url ?? "/", `http://localhost:${String(port)}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end("Not found");
        return;
      }

      const code = url.searchParams.get("code");
      const error = url.searchParams.get("error");

      if (error) {
        res.writeHead(200, { "Content-Type": "text/html" });
        res.end("<h1>Authorization failed</h1><p>You can close this tab.</p>");
        server.close();
        reject(new Error(`OAuth error: ${error}`));
        return;
      }

      if (!code) {
        res.writeHead(400, { "Content-Type": "text/html" });
        res.end("<h1>Missing code</h1><p>No authorization code received.</p>");
        server.close();
        reject(new Error("No authorization code in callback"));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html" });
      res.end(
        "<h1>Authorization successful!</h1><p>You can close this tab and return to the terminal.</p>",
      );
      server.close();
      resolve(code);
    });

    server.on("error", (err) => {
      reject(new Error(`Failed to start callback server: ${err.message}`));
    });

    server.listen(port, () => {
      // Server is ready
    });
  });
}

export function registerAccounts(program: Command) {
  const accounts = program
    .command("accounts")
    .description("Manage email accounts");

  // --- accounts list ---
  accounts
    .command("list")
    .description("List all configured email accounts")
    .action(async () => {
      const spinner = ora("Loading accounts...").start();
      try {
        const accts = await listAccounts();
        spinner.stop();

        if (accts.length === 0) {
          console.log(chalk.yellow("No accounts configured."));
          console.log(
            `Run ${chalk.cyan("email-agent accounts add <email>")} to add one.\n`,
          );
          return;
        }

        console.log(chalk.bold("\nConfigured accounts:\n"));
        for (const acct of accts) {
          const defaultTag = acct.isDefault
            ? chalk.green(" (default)")
            : "";
          const name = acct.name ? ` — ${acct.name}` : "";
          console.log(`  ${chalk.cyan(acct.email)}${name}${defaultTag}`);
        }
        console.log();
      } catch (err) {
        spinner.fail("Failed to list accounts");
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
    });

  // --- accounts add ---
  accounts
    .command("add <email>")
    .description("Add a new email account via OAuth2")
    .action(async (email: string) => {
      try {
        const creds = await getOAuthCredentials();
        if (!creds) {
          console.error(
            chalk.red(
              "OAuth credentials not found. Run setup first or place oauth.json in ~/.email-agent/",
            ),
          );
          process.exit(1);
        }

        const authUrl = generateAuthUrl(creds, REDIRECT_URI);

        console.log(chalk.bold("\nOpen this URL in your browser to authorize:\n"));
        console.log(chalk.cyan(authUrl));
        console.log(chalk.dim("\nWaiting for authorization callback on port 9876...\n"));

        const code = await waitForAuthCode(9876);

        const spinner = ora("Exchanging authorization code...").start();
        const result = await exchangeCode(creds, code, REDIRECT_URI);

        await addAccount({
          email: result.email,
          isDefault: false,
        });

        spinner.succeed(
          `Account ${chalk.cyan(result.email)} added successfully`,
        );

        if (result.email !== email) {
          console.log(
            chalk.yellow(
              `\nNote: The authenticated account (${result.email}) differs from the requested email (${email}).`,
            ),
          );
        }

        console.log(
          chalk.green(
            `\nRun ${chalk.cyan("email-agent fetch --account " + result.email)} to fetch emails.\n`,
          ),
        );
      } catch (err) {
        console.error(
          chalk.red(
            `\nFailed to add account: ${err instanceof Error ? err.message : String(err)}`,
          ),
        );
        process.exit(1);
      }
    });

  // --- accounts remove ---
  accounts
    .command("remove <email>")
    .description("Remove an email account")
    .action(async (email: string) => {
      const spinner = ora(`Removing account ${email}...`).start();
      try {
        await removeAccount(email);
        spinner.succeed(`Account ${chalk.cyan(email)} removed`);
      } catch (err) {
        spinner.fail("Failed to remove account");
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
    });

  // --- accounts default ---
  accounts
    .command("default <email>")
    .description("Set the default email account")
    .action(async (email: string) => {
      const spinner = ora(`Setting ${email} as default...`).start();
      try {
        await setDefaultAccount(email);
        spinner.succeed(`${chalk.cyan(email)} is now the default account`);
      } catch (err) {
        spinner.fail("Failed to set default account");
        console.error(
          chalk.red(err instanceof Error ? err.message : String(err)),
        );
        process.exit(1);
      }
    });
}
