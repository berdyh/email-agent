import type { Command } from "commander";
import chalk from "chalk";
import { isUnlockGateEnabled, mintUnlockToken } from "@email-agent/core";
import { buildUnlockUrl, describeUnlockLines } from "../unlock-url.js";

/**
 * `email-agent unlock` — print a fresh unlock link. Mint only; no server.
 *
 * WHY THIS COMMAND EXISTS AT ALL (owner's decision D1, 2026-08-22), since it is
 * deliberately more than the milestone's literal scope. Two gaps close with one
 * ~30-line command:
 *
 *  1. RECOVERY. The link is one-time and expires in ten minutes, and a session
 *     lapses after a day idle. Without this, the only way back in is restarting
 *     `email-agent serve` — which means killing a server that is working fine
 *     because a browser forgot who it was.
 *  2. `npm run dev` / `npm run start`. Neither goes through `commands/serve.ts`,
 *     so neither ever prints a link. The gate is a property of the web process,
 *     not of `serve`, so a contributor on those scripts meets the unlock screen
 *     with no token in existence. This is how they get one.
 *
 * IT NEEDS NO RUNNING SERVER, AND WORKS ON ONE THAT IS ALREADY UP. That is the
 * whole reason the store is a file rather than a pair of environment variables
 * handed to the child at spawn time: no process can inject an environment
 * variable into a running child, but both processes can read
 * `~/.email-agent/session.json`, and the web process re-reads it per request.
 *
 * It never refuses. If `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` is set in THIS
 * shell the gate is off here — but that says nothing about the environment the
 * server was started in, so the link is printed anyway with a note, rather than
 * leaving a locked-out user holding an explanation instead of a way in.
 */
export function registerUnlock(program: Command) {
  program
    .command("unlock")
    .description(
      "Print a fresh one-time link that unlocks the web UI in a browser " +
        "(works whether or not a server is running)",
    )
    .option("-p, --port <port>", "Port the web UI is served on", "3847")
    .option(
      "-H, --host <host>",
      "Hostname to put in the link. The session cookie is host-only, so this " +
        "must match the address you open in the browser",
      "127.0.0.1",
    )
    .action((options: { port: string; host: string }) => {
      const { token } = mintUnlockToken();
      for (const line of describeUnlockLines(
        buildUnlockUrl(options.host, options.port, token),
      )) {
        console.log(chalk.cyan(line));
      }

      if (!isUnlockGateEnabled(process.env)) {
        console.log(
          chalk.yellow(
            `Note: EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1 is set in THIS shell, which turns\n` +
              `the unlock gate off. If the server was started the same way it will let you\n` +
              `in without this link; if it was not, the link above is what you need.\n`,
          ),
        );
      }
    });
}
