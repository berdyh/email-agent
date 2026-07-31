#!/usr/bin/env node
import { Command } from "commander";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { registerSetup } from "./commands/setup.js";
import { registerFetch } from "./commands/fetch.js";
import { registerRunAction } from "./commands/run-action.js";
import { registerListActions } from "./commands/list-actions.js";
import { registerServe } from "./commands/serve.js";
import { registerCron } from "./commands/cron.js";
import { registerConfig } from "./commands/config.js";
import { registerAccounts } from "./commands/accounts.js";

// Load the repo-root .env (written by setup.sh) so API keys land in
// process.env before any command reads them. This file compiles to
// packages/cli/dist/index.js, so walk up dist → cli → packages → repo root.
// process.loadEnvFile mirrors --env-file semantics: it does NOT override
// variables already set in the environment. All command env reads are lazy
// (evaluated at action time), so loading here in the module body is in time.
try {
  const here = dirname(fileURLToPath(import.meta.url));
  process.loadEnvFile(join(here, "..", "..", "..", ".env"));
} catch {
  // No .env present (or unreadable) — fine, env may come from the shell.
}

const program = new Command();

program
  .name("email-agent")
  .description("AI-powered Gmail analysis tool")
  .version("0.1.0");

registerSetup(program);
registerFetch(program);
registerRunAction(program);
registerListActions(program);
registerServe(program);
registerCron(program);
registerConfig(program);
registerAccounts(program);

program.parse();
