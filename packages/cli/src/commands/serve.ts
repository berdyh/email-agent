import type { Command } from "commander";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import chalk from "chalk";
import {
  initDb,
  isUnlockGateEnabled,
  mintUnlockToken,
  verifyStrandedApplyingOperations,
} from "@email-agent/core";
import { describeStrandedNotifyLines } from "./approvals.js";
import {
  buildUnlockUrl,
  describeUnlockDisabledLines,
  describeUnlockLines,
} from "../unlock-url.js";

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
 *
 * Since 2026-08-22 the bind is no longer the whole story for a BROWSER: a
 * request also needs a session cookie, obtained once by opening the unlock link
 * this command prints (`config/session.ts` in core). That narrows "another
 * process on this machine" to "another process running as THIS USER" — anything
 * else can still reach the port and gets a lock screen. It does not narrow it
 * further, and never will: code running as this user reads the OAuth tokens
 * directly.
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
/**
 * Whether this run should mint and print an unlock link.
 *
 * Two conditions, both necessary. A non-loopback bind implies the remote flag
 * (see `resolveServeEnv`), which turns the gate off — printing a token there
 * would claim a protection that is not running. And the flag set explicitly on
 * a loopback bind is the documented headless-client combination, where the gate
 * is off for the same reason.
 *
 * Note what is NOT a condition: how the server was started. There is no
 * "arming" environment variable — the gate is on by default in the web process
 * however it was launched, which is why `npm run dev` and `npm run start` need
 * `email-agent unlock` rather than a token this command forgot to hand them.
 */
export function shouldPrintUnlockUrl(host: string, env: NodeJS.ProcessEnv): boolean {
  return isLoopbackHost(host) && isUnlockGateEnabled(env);
}

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
    .action(async (options: { port: string; host?: string }) => {
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

      // D1 (owner's decision): verification runs automatically at startup,
      // GATED ON A CHEAP DB READ FIRST — zero Gmail calls and zero output when
      // nothing is stale. This is a GENUINELY NEW COST for this command: unlike
      // `fetch`, `serve` never opened the database before this. It costs one
      // LanceDB connect plus one filtered scan before the Next.js child even
      // spawns; when rows ARE stale, it costs one live Gmail call per row (see
      // AGENTS.md and `verify-stranded.ts`'s own module header for why that is
      // serial, not batched). A failure here must never stop `serve` from
      // starting — wrapped in its own try/catch, one honest line, and the
      // child spawns regardless.
      //
      // AND IT IS BOUNDED IN TIME, which the try/catch alone could never give
      // it: a catch catches throws, not hangs, and until the bounds went in
      // (2026-08-22) nothing under `users.messages.get` supplied a timeout at
      // all. On a network where connections hang rather than reset — a captive
      // portal, a half-up VPN — a handful of stranded rows read serially meant
      // `serve` printed the line above and NEVER SPAWNED THE SERVER.
      //
      // The ceiling is `STRANDED_VERIFICATION_DEADLINE_MS` (20s, the pass
      // budget) PLUS `GMAIL_READ_DEADLINE_MS` (10s, the one read that may start
      // just inside the budget) = 30s, whatever the network is doing and
      // however many rows are stranded. Rows the budget did not reach come back
      // as `not-checked`, unchanged and still visible, for the next run. When
      // nothing is stranded this whole block still costs zero Gmail calls, so
      // D1's cheap-gate property is untouched.
      //
      // WHY THE BOUND RATHER THAN SPAWNING THE CHILD FIRST: the bound lives in
      // core and every caller inherits it — `fetch`, this command, and
      // `POST /api/approvals/stranded/verify` — whereas re-ordering the spawn
      // would fix this command only, and leave the route and the fetch tail
      // exactly as exposed. It would also have to switch the child off
      // `stdio: "inherit"` onto pipes for the parent to interleave its own
      // output sanely, which is a real cost for a narrower fix.
      try {
        await initDb();
        const verified = await verifyStrandedApplyingOperations();
        for (const line of describeStrandedNotifyLines(verified)) {
          console.log(chalk.yellow(line));
        }
      } catch (verifyErr) {
        console.log(
          chalk.yellow(
            `Could not check for Gmail changes stuck mid-apply: ` +
              `${verifyErr instanceof Error ? verifyErr.message : String(verifyErr)}. ` +
              `Starting the server anyway.`,
          ),
        );
      }

      // D4 (owner's decision): print the link BEFORE spawning the child. The
      // child inherits stdio, so the parent cannot watch it for a readiness
      // line without switching to pipes and forwarding its output — about
      // thirty lines of machinery to avoid a two-second "connection refused"
      // for someone who clicks instantly. The printed block says so instead.
      //
      // Nothing about the token crosses into the child: it is not in the
      // child's environment, and the digest lives in `~/.email-agent/session
      // .json`, which the web process reads per request. That is also why
      // `email-agent unlock` can hand out a fresh link to a server that is
      // already running.
      if (shouldPrintUnlockUrl(host, process.env)) {
        try {
          const { token } = mintUnlockToken();
          for (const line of describeUnlockLines(
            buildUnlockUrl(host, options.port, token),
            { pendingServerStart: true },
          )) {
            console.log(chalk.cyan(line));
          }
        } catch (mintErr) {
          console.log(
            chalk.yellow(
              `Could not write an unlock link: ` +
                `${mintErr instanceof Error ? mintErr.message : String(mintErr)}. ` +
                `Starting the server anyway — run \`npx email-agent unlock\` once it is up.`,
            ),
          );
        }
      } else {
        for (const line of describeUnlockDisabledLines()) {
          console.log(chalk.yellow(line));
        }
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
