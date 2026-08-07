/**
 * Runs the BUILT `email-agent` binary against a seeded temp-directory LanceDB.
 *
 * The CLI's own tests all call exported functions directly, which is why
 * TODOS.md could say "nothing fails if a command stops calling its formatter".
 * This runs the real entry point as a real process: commander parsing, the
 * command registration in `src/index.ts`, the core imports, the LanceDB writes
 * and the exit code. Only the Gmail API is absent, and it is absent the way it
 * is for a user with no linked account — `createGmailClient` throws locally, so
 * no network call is made and the queue rows resolve `failed`.
 *
 * IT IS `dist/index.js`, NOT the source. `npm test` builds the CLI for exactly
 * this reason: a test that ran `src/index.ts` under tsx would not cover the tsc
 * emit, and the emit is what a user runs.
 *
 * Seeding shells out to `packages/core/dist/testing/seed-cli.js` instead of
 * importing the fixture: `packages/cli` may only import the `@email-agent/core`
 * barrel, and the fixture is deliberately not on it. Same fixture, same
 * `$HOME`, one process boundary.
 */

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { after } from "node:test";

const execFileAsync = promisify(execFile);

// .../packages/cli/src/testing -> repo root
const PACKAGES = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const CLI_BIN = join(PACKAGES, "cli", "dist", "index.js");
const SEED_BIN = join(PACKAGES, "core", "dist", "testing", "seed-cli.js");

export interface RunResult {
  stdout: string;
  stderr: string;
  /** Combined output, which is what a user actually sees in a terminal. */
  output: string;
  exitCode: number;
}

export interface SeedSpec {
  emails?: Array<Record<string, unknown>>;
  pendingOperations?: Array<Record<string, unknown>>;
  actionResults?: Array<Record<string, unknown>>;
  backdateClaims?: { ids: string[]; ms: number };
}

export interface QueueRow {
  id: string;
  status: string;
  claimToken: string;
  error: string;
  resolvedAt: string;
  [key: string]: unknown;
}

export interface RunOptions {
  stdin?: string;
  /**
   * Extra environment for this invocation.
   *
   * The reason it exists: `agentMode: "direct-api"` sends the runner through
   * the OpenAI SDK, which reads `OPENAI_BASE_URL`/`OPENAI_API_KEY` from the
   * environment. Pointing those at a local `node:http` stub is how a full
   * `run-action` — prompt, agent call, result parse, queue write, approval
   * prompt — becomes reachable in a test without a model or a key.
   */
  env?: Record<string, string>;
}

export interface CliHarness {
  home: string;
  seed: (spec: SeedSpec) => Promise<void>;
  /** Every `pending_operations` row, id-sorted. */
  queue: () => Promise<QueueRow[]>;
  /** Writes `$HOME/.email-agent/settings.json`. Partial: core fills defaults. */
  writeSettings: (settings: Record<string, unknown>) => Promise<void>;
  run: (args: string[], options?: RunOptions) => Promise<RunResult>;
}

/** Strips ANSI, so an assertion is about words rather than colour codes. */
// eslint-disable-next-line no-control-regex
const ANSI = /\[[0-9;]*m/g;

export async function startCli(label: string): Promise<CliHarness> {
  const home = await mkdtemp(join(tmpdir(), `email-agent-cli-${label}-`));
  after(async () => {
    await rm(home, { recursive: true, force: true });
  });

  const env = { ...process.env, HOME: home, USERPROFILE: home };

  const seedRun = async (args: string[]): Promise<string> => {
    const { stdout } = await execFileAsync(process.execPath, [SEED_BIN, ...args], {
      env,
      cwd: PACKAGES,
    });
    return stdout;
  };

  await seedRun(["init"]);

  return {
    home,
    seed: async (spec) => {
      await seedRun(["seed", JSON.stringify(spec)]);
    },
    queue: async () => JSON.parse(await seedRun(["read"])) as QueueRow[],
    writeSettings: async (settings) => {
      const dir = join(home, ".email-agent");
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "settings.json"), JSON.stringify(settings), "utf-8");
    },
    run: (args, options = {}) =>
      new Promise<RunResult>((resolvePromise, rejectPromise) => {
        const child = execFile(
          process.execPath,
          [CLI_BIN, ...args],
          {
            env: { ...env, ...(options.env ?? {}) },
            cwd: PACKAGES,
            maxBuffer: 8 * 1024 * 1024,
          },
          (error, stdout, stderr) => {
            // A non-zero exit is an ANSWER here, not a failure: several commands
            // exit 1 deliberately (a stranded row is an unresolved change to the
            // user's mailbox). Only a spawn failure rejects.
            const code =
              error && typeof (error as { code?: unknown }).code === "number"
                ? ((error as { code: number }).code)
                : error
                  ? 1
                  : 0;
            if (error && typeof (error as { code?: unknown }).code === "string") {
              rejectPromise(error);
              return;
            }
            const clean = (value: string) => value.replace(ANSI, "");
            resolvePromise({
              stdout: clean(stdout),
              stderr: clean(stderr),
              output: clean(stdout) + clean(stderr),
              exitCode: code,
            });
          },
        );
        // Every interactive command reads from stdin; closing it without input
        // is what a piped invocation does, and readline then sees EOF.
        child.stdin?.end(options.stdin ?? "");
      }),
  };
}
