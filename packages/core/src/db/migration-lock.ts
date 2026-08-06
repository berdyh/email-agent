// A cross-process advisory lock for LanceDB drop-and-recreate migrations.
//
// `initDb()`'s cached `initPromise` serializes callers inside ONE process. It
// says nothing about a `serve` and a CLI run starting at the same moment after
// an upgrade: both would see the same missing column and both would run the
// read → drop → create → insert sequence, interleaved, over the same table.
//
// SCOPE, precisely. This lock serializes *migrations* against each other. It
// does NOT make the table safe to write during one: ordinary enqueue/claim/
// resolve calls do not take it (that would put a filesystem lock on every
// queue write), so a process already past `initDb()` can still write into the
// drop window and have that write land in a table that is about to be
// replaced. The durable backup bounds the damage — recovery merges the
// snapshot with whatever the table holds — but a write that lands strictly
// between the snapshot and the drop is still lost. Closing that needs
// migration-aware write paths; see TODOS.md.

import { mkdir, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

/**
 * How long a lock directory may sit untouched before it is treated as
 * abandoned. A migration is a handful of table rewrites, so minutes is
 * generous; the cost of guessing too low is two concurrent migrations, and the
 * cost of guessing too high is a startup that waits.
 */
export const STALE_LOCK_MS = 5 * 60 * 1000;

/** How long to wait for another process's migration before giving up. */
export const LOCK_WAIT_MS = 60 * 1000;

const POLL_INTERVAL_MS = 100;

export function migrationLockPath(dir: string, name: string): string {
  return join(dir, `${name}.migration.lock`);
}

/** True when a lock directory is old enough to be treated as abandoned. */
export function isLockStale(
  lockMtimeMs: number,
  nowMs: number,
  staleAfterMs: number = STALE_LOCK_MS,
): boolean {
  // A clock that moved backwards must not make a fresh lock look stale.
  return nowMs - lockMtimeMs >= staleAfterMs;
}

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Runs `fn` while holding an exclusive on-disk lock named `name` under `dir`.
 *
 * `mkdir` is the primitive: it is atomic and fails with EEXIST if the
 * directory already exists, on every filesystem we care about, without needing
 * a daemon or advisory-locking support. A lock older than `staleAfterMs` is
 * stolen — otherwise a process killed mid-migration would block every future
 * start forever, which is a worse failure than the race the lock prevents.
 *
 * If the lock cannot be taken within `waitMs`, this THROWS rather than
 * proceeding unlocked. Running the migration anyway would mean two processes
 * dropping and recreating the same table, and the error names the lock path so
 * a human can clear it.
 */
export async function withMigrationLock<T>(
  dir: string,
  name: string,
  fn: () => Promise<T>,
  options?: { waitMs?: number; staleAfterMs?: number; now?: () => number },
): Promise<T> {
  const waitMs = options?.waitMs ?? LOCK_WAIT_MS;
  const staleAfterMs = options?.staleAfterMs ?? STALE_LOCK_MS;
  const now = options?.now ?? (() => Date.now());

  await mkdir(dir, { recursive: true });
  const lockPath = migrationLockPath(dir, name);
  const deadline = now() + waitMs;

  for (;;) {
    try {
      await mkdir(lockPath);
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;

      let stale = false;
      try {
        stale = isLockStale((await stat(lockPath)).mtimeMs, now(), staleAfterMs);
      } catch {
        // Vanished between mkdir and stat — the holder released it. Retry.
      }
      if (stale) {
        console.warn(
          `Reclaiming an abandoned migration lock at ${lockPath} (untouched for over ${Math.round(staleAfterMs / 1000)}s).`,
        );
        await rm(lockPath, { recursive: true, force: true });
        continue;
      }
      if (now() >= deadline) {
        throw new Error(
          `Timed out after ${Math.round(waitMs / 1000)}s waiting for the ${name} migration lock at ${lockPath}. Another email-agent process is migrating this table; wait for it to finish, or remove the lock directory if no such process is running.`,
        );
      }
      await sleep(POLL_INTERVAL_MS);
    }
  }

  try {
    // Diagnostic only — nothing reads it back. The lock IS the directory.
    await writeFile(
      join(lockPath, "owner.json"),
      JSON.stringify({ pid: process.pid, acquiredAt: new Date().toISOString() }),
    ).catch(() => {});
    return await fn();
  } finally {
    await rm(lockPath, { recursive: true, force: true });
  }
}
