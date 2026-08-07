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

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

/**
 * Where the listener binds. This is the one part of the local-only story that a
 * request header cannot argue with: the API's `Host`/`Origin`/`Sec-Fetch-*`
 * checks are all caller-controlled, so on a `0.0.0.0` bind anything on the
 * network can send `Host: localhost` and satisfy them. Binding to loopback means
 * the connection is refused by the kernel before any handler runs.
 *
 * `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` — already the documented escape hatch
 * for non-local browser writes — also opens the bind, and `--host` with a
 * non-loopback address sets that flag for the child (see `resolveServeEnv`), so
 * the two halves of "I meant to expose this" stay one switch whichever end you
 * pull. `--host` wins over the flag when it names a loopback address, which is
 * how you get "reachable by a headless local client, still not on the network".
 *
 * What this does NOT stop: another process on this machine. It can reach
 * loopback, and if it runs as this user it can also read the OAuth tokens under
 * `~/.email-agent/accounts/` and skip the app entirely.
 */
export function resolveServeHost(
  explicitHost: string | undefined,
  env: NodeJS.ProcessEnv,
): string {
  if (explicitHost) return explicitHost;
  return env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] === "1" ? "0.0.0.0" : "127.0.0.1";
}

export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.has(host);
}

/**
 * The child's environment. The one thing it changes: a non-loopback bind
 * implies `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1`.
 *
 * `serve --host 0.0.0.0` used to open the listener and leave the API's header
 * checks demanding a local `Host`, so every request from the LAN — the entire
 * point of passing `--host` — answered 403. The two halves of "I meant to
 * expose this" have to agree, and the flag is exactly the switch that says so.
 * The warning printed alongside is what makes it a decision rather than a
 * surprise.
 */
export function resolveServeEnv(
  host: string,
  env: NodeJS.ProcessEnv,
  port: string,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...env, PORT: port };
  if (!isLoopbackHost(host)) next["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] = "1";
  return next;
}

export function registerServe(program: Command) {
  program
    .command("serve")
    .description("Start the Email Agent web UI")
    .option("-p, --port <port>", "Port to run on", "3847")
    .option(
      "-H, --host <host>",
      "Interface to bind (default: loopback; 0.0.0.0 when EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1)",
    )
    .action((options: { port: string; host?: string }) => {
      const host = resolveServeHost(options.host, process.env);
      console.log(
        chalk.bold(`\nStarting Email Agent on ${host}:${options.port}...\n`),
      );
      if (!isLoopbackHost(host)) {
        console.log(
          chalk.yellow(
            `Binding to ${host}: anything that can reach this port can read your mail and\n` +
              `approve queued Gmail changes. The API's local-origin header checks are turned\n` +
              `OFF for this run (they would refuse the LAN browser this bind exists for), and\n` +
              `they never stopped a non-browser client anyway.\n`,
          ),
        );
      }

      const repoRoot = resolveRepoRoot();
      const webDir = join(repoRoot, "packages", "web");

      // The web package's "dev" script hardcodes `next dev --port 3847`, so
      // passing --port through `npm run dev -- --port <n>` would silently
      // lose to the hardcoded flag. Spawn next directly instead.
      const child = spawn(
        "npx",
        ["next", "dev", "--port", options.port, "--hostname", host],
        {
          stdio: "inherit",
          env: resolveServeEnv(host, process.env, options.port),
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
