import type { Command } from "commander";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chalk from "chalk";

// This file compiles to packages/cli/dist/commands/serve.js — walk up to the
// monorepo root so `serve` works regardless of the caller's cwd.
function resolveRepoRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return join(here, "..", "..", "..", "..");
}

export function registerServe(program: Command) {
  program
    .command("serve")
    .description("Start the Email Agent web UI")
    .option("-p, --port <port>", "Port to run on", "3847")
    .action((options: { port: string }) => {
      console.log(chalk.bold(`\nStarting Email Agent on port ${options.port}...\n`));

      const repoRoot = resolveRepoRoot();
      const webDir = join(repoRoot, "packages", "web");

      // The web package's "dev" script hardcodes `next dev --port 3847`, so
      // passing --port through `npm run dev -- --port <n>` would silently
      // lose to the hardcoded flag. Spawn next directly instead.
      const child = spawn(
        "npx",
        ["next", "dev", "--port", options.port],
        {
          stdio: "inherit",
          env: { ...process.env, PORT: options.port },
          cwd: webDir,
        },
      );

      child.on("error", (err) => {
        console.error(chalk.red(`Failed to start: ${err.message}`));
        process.exit(1);
      });

      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
    });
}
