/**
 * Writing files under `~/.email-agent/` so only the owning user can read them.
 *
 * WHY THIS EXISTS AT ALL. Everything this app persists under `~/.email-agent/`
 * is a credential or the mail it unlocks: `accounts/{email}/token.json` holds a
 * Gmail OAuth refresh token, `settings.json` holds runtime consent flags, and
 * `session.json` (the unlock/session store) holds the digests that decide who
 * may drive the local web UI. Until 2026-08-22 every one of those was written
 * with no explicit mode, so under the common `umask 022` they landed on disk as
 * `0644` inside a `0755` directory — world-readable. That is not a theoretical
 * complaint: the OAuth refresh token is the whole mailbox, and any other local
 * user could read it.
 *
 * MEASURED BEFORE CHANGING IT (this machine, 2026-08-22): `~/.email-agent` was
 * `755`, `~/.email-agent/data` was `755`, and neither `saveSettings()` nor
 * `saveTokens()` passed a `mode`. So the choice was NOT "give the new session
 * file tighter permissions than its siblings and say nothing" — it was fix all
 * three together, which is what this module is for.
 *
 * WHY tmp-then-rename RATHER THAN write-then-chmod. `writeFile(path, data,
 * { mode })` applies the mode only when it CREATES the file; an existing `0644`
 * file keeps `0644` forever. A `chmod` after the write closes that, but leaves a
 * window in which the new bytes sit on disk at the old mode. Writing a fresh
 * temp file in the same directory (created at the tight mode, so it is never
 * momentarily loose) and `rename`-ing it over the target has neither problem,
 * and gives readers atomicity for free — a concurrent reader sees either the
 * whole old file or the whole new one, never a half-written one. `rename` is
 * within one directory, so it never crosses a filesystem.
 *
 * The directory is handled separately because `mkdir(..., { mode })` likewise
 * only applies to a directory it creates: an existing `0755` `~/.email-agent`
 * is chmod-ed to `0700` on the next write. Requested modes are still subject to
 * the process umask, which is why they are re-applied explicitly rather than
 * trusted to `mkdir`/`open`.
 *
 * WHAT THIS DOES NOT BUY, stated so nobody upgrades it in their head: nothing
 * here stops a process running as THIS user. Such a process reads
 * `~/.email-agent/accounts/{email}/token.json` and calls the Gmail API
 * directly, never touching this app. The bar these modes raise is "another
 * local user, or a container mounting this home directory read-only" — which is
 * exactly the bar the unlock/session gate is drawn around too.
 */

import { chmod, mkdir, rename, writeFile } from "node:fs/promises";
import {
  chmodSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";

/** `rwx------` — the owner alone may list or traverse the directory. */
export const PRIVATE_DIR_MODE = 0o700;

/** `rw-------` — the owner alone may read the file. */
export const PRIVATE_FILE_MODE = 0o600;

function tempSiblingPath(path: string): string {
  return join(
    dirname(path),
    `.${randomBytes(8).toString("hex")}.tmp`,
  );
}

/**
 * Creates `dir` if absent and forces `0700` on it either way.
 *
 * The unconditional `chmod` is the point: a home directory created by an older
 * version of this app already exists at `0755`, and `mkdir` would leave it
 * there.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await chmod(dir, PRIVATE_DIR_MODE);
}

/** Synchronous `ensurePrivateDir`, for the request-path session store. */
export function ensurePrivateDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  chmodSync(dir, PRIVATE_DIR_MODE);
}

/**
 * Writes `data` to `path` at `0600`, atomically, tightening the parent
 * directory to `0700` on the way.
 */
export async function writePrivateFile(
  path: string,
  data: string,
): Promise<void> {
  await ensurePrivateDir(dirname(path));
  const temp = tempSiblingPath(path);
  await writeFile(temp, data, { mode: PRIVATE_FILE_MODE });
  // `mode` on `writeFile` is masked by the umask, so re-assert it rather than
  // hoping the caller's umask was 0o077.
  await chmod(temp, PRIVATE_FILE_MODE);
  await rename(temp, path);
}

/** Synchronous `writePrivateFile`, for the request-path session store. */
export function writePrivateFileSync(path: string, data: string): void {
  ensurePrivateDirSync(dirname(path));
  const temp = tempSiblingPath(path);
  writeFileSync(temp, data, { mode: PRIVATE_FILE_MODE });
  chmodSync(temp, PRIVATE_FILE_MODE);
  renameSync(temp, path);
}

/**
 * The permission bits of `path`, or `undefined` if it does not exist.
 *
 * Exists so tests can assert the modes above without each of them re-deriving
 * `statSync(...).mode & 0o777`.
 */
export function filePermissions(path: string): number | undefined {
  try {
    return statSync(path).mode & 0o777;
  } catch {
    return undefined;
  }
}
