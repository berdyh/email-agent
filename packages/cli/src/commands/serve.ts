import type { Command } from "commander";
import { spawn } from "node:child_process";
import chalk from "chalk";

export function registerServe(program: Command) {
  program
    .command("serve")
    .description("Start the Email Agent web UI")
    .option("-p, --port <port>", "Port to run on", "3847")
    .action((options: { port: string }) => {
      console.log(chalk.bold(`\nStarting Email Agent on port ${options.port}...\n`));

      const child = spawn("npm", ["run", "-w", "@email-agent/web", "dev"], {
        stdio: "inherit",
        env: { ...process.env, PORT: options.port },
        cwd: process.cwd(),
      });

      child.on("error", (err) => {
        console.error(chalk.red(`Failed to start: ${err.message}`));
        process.exit(1);
      });

      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
    });
}
