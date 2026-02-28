#!/usr/bin/env node
import { Command } from "commander";
import { registerSetup } from "./commands/setup.js";
import { registerFetch } from "./commands/fetch.js";
import { registerRunAction } from "./commands/run-action.js";
import { registerListActions } from "./commands/list-actions.js";
import { registerServe } from "./commands/serve.js";
import { registerCron } from "./commands/cron.js";

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

program.parse();
