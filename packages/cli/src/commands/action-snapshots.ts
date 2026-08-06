import { createInterface } from "node:readline/promises";
import type { Command } from "commander";
import chalk from "chalk";
import {
  listSnapshots,
  listUserActions,
  restoreSnapshot,
  UnsafeActionSourceError,
} from "@email-agent/core";
import type { SnapshotEntry } from "@email-agent/core";

/**
 * Recover the action filename a snapshot belongs to.
 *
 * `saveUserAction` names snapshots `<original>.<ISO timestamp with : and .
 * replaced by ->.ts`, e.g. `junk.action.ts.2026-02-28T12-00-00-000Z.ts`. The
 * timestamp segment therefore never contains a dot, so the original filename is
 * everything up to the last two dot-separated segments.
 */
export function originalFilenameFromSnapshot(
  snapshotFilename: string,
): string | undefined {
  return /^(.+\.action\.(?:ts|js))\.[^.]+\.ts$/.exec(snapshotFilename)?.[1];
}

interface SnapshotListing {
  filename: string;
  snapshots: SnapshotEntry[];
}

async function collectSnapshots(actionFilename?: string): Promise<SnapshotListing[]> {
  const filenames = actionFilename
    ? [actionFilename]
    : (await listUserActions()).map((action) => action.filename);

  const listings: SnapshotListing[] = [];
  for (const filename of filenames) {
    const snapshots = await listSnapshots(filename);
    if (snapshots.length > 0) listings.push({ filename, snapshots });
  }
  return listings;
}

function printListings(listings: SnapshotListing[]): void {
  for (const listing of listings) {
    console.log(chalk.bold(`\n${listing.filename}`));
    for (const snapshot of listing.snapshots) {
      console.log(
        `  ${chalk.dim(snapshot.timestamp)}  ${chalk.cyan(snapshot.filename)}`,
      );
    }
  }
  console.log(
    chalk.dim(
      "\nRestore one with `email-agent actions snapshots restore <snapshot-file>`.",
    ),
  );
}

async function confirm(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(question);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export function registerActionSnapshots(program: Command) {
  const actions = program
    .command("actions")
    .description("Manage user action files and their snapshots");

  const snapshots = actions
    .command("snapshots")
    .description("List or restore previous versions of a user action");

  snapshots
    .command("list", { isDefault: true })
    .description("List saved snapshots, newest first")
    .option("-a, --action <filename>", "Only one action file, e.g. junk.action.ts")
    .action(async (options: { action?: string }) => {
      const listings = await collectSnapshots(options.action);
      if (listings.length === 0) {
        console.log(
          chalk.dim(
            options.action
              ? `No snapshots for ${options.action}.`
              : "No action snapshots. One is written every time an action is overwritten by the edit flow.",
          ),
        );
        return;
      }
      printListings(listings);
    });

  snapshots
    .command("restore <snapshot>")
    .description("Restore a snapshot over the current action file")
    .option(
      "-a, --action <filename>",
      "Target action file (defaults to the one encoded in the snapshot name)",
    )
    .option("-y, --yes", "Skip the confirmation prompt")
    .action(async (snapshot: string, options: { action?: string; yes?: boolean }) => {
      const original = options.action ?? originalFilenameFromSnapshot(snapshot);
      if (!original) {
        console.error(
          chalk.red(
            `Cannot tell which action "${snapshot}" belongs to. Pass --action <filename>.`,
          ),
        );
        process.exitCode = 1;
        return;
      }

      if (
        !options.yes &&
        !(await confirm(
          `Restore ${chalk.cyan(snapshot)} over ${chalk.cyan(original)}? ` +
            `The current version is snapshotted first. [y/N] `,
        ))
      ) {
        console.log(chalk.dim("Skipped — nothing was changed."));
        return;
      }

      try {
        await restoreSnapshot(snapshot, original);
        console.log(chalk.green(`Restored ${original} from ${snapshot}.`));
      } catch (err) {
        // restoreSnapshot writes through saveUserAction, so the save-time source
        // guard re-validates the snapshot. A snapshot taken BEFORE that guard
        // existed can therefore contain a value import and be refused — which is
        // correct, but it must not read as a generic failure.
        if (err instanceof UnsafeActionSourceError) {
          console.error(
            chalk.red(
              `Refused to restore ${snapshot}: it does not pass the action source guard.`,
            ),
          );
          for (const violation of err.violations) {
            console.error(chalk.red(`  - ${violation.rule}: ${violation.detail}`));
          }
          console.error(
            chalk.yellow(
              "This snapshot predates the guard, or was hand-edited. Nothing was changed. " +
                "Copy the parts you need out of ~/.email-agent/actions/.snapshots/ by hand instead.",
            ),
          );
        } else {
          console.error(
            chalk.red(`Failed to restore ${snapshot}: ${err instanceof Error ? err.message : String(err)}`),
          );
        }
        process.exitCode = 1;
      }
    });
}
