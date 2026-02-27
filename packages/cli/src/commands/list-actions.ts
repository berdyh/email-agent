import type { Command } from "commander";
import chalk from "chalk";
import { ActionRegistry } from "@email-agent/core";

export function registerListActions(program: Command) {
  program
    .command("list-actions")
    .description("List all available actions")
    .action(async () => {
      const registry = new ActionRegistry();
      await registry.loadAll();

      const actions = registry.getAll();

      if (actions.length === 0) {
        console.log(chalk.yellow("No actions found."));
        return;
      }

      console.log(chalk.bold("\nAvailable Actions:\n"));

      for (const action of actions) {
        const tag = action.builtIn ? chalk.dim("[built-in]") : chalk.dim("[user]");
        console.log(`  ${chalk.cyan(action.id)} ${tag}`);
        console.log(`    ${action.name} — ${action.description}`);
        console.log();
      }

      console.log(
        chalk.dim(
          `Run an action: ${chalk.cyan("email-agent run-action <id>")}\n`,
        ),
      );
    });
}
