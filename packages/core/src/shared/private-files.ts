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
 * WHAT THE FIRST VERSION MISSED, and why the module now walks a whole chain
 * (2026-08-22, second pass). Hardening those three FILES left the app's own
 * DIRECTORIES below the root untouched, and `ensurePrivateDir` chmod-ed only the
 * single directory it was handed. `db/connection.ts` created
 * `~/.email-agent/data/lancedb` with a bare recursive `mkdir`, so the mail
 * database — every message body and every embedding, by far the largest and most
 * sensitive thing here — sat at `0755` with `0644` manifests inside, and
 * `actions/` did the same. Measured on throwaway `$HOME`s at `umask 022`:
 *
 *   settings-first  root 0700, but data/ lancedb/ emails.lance all 0755
 *   db-first        root 0755 TOO — nothing had written settings yet, so the
 *                   one shield that made the rest unreachable was absent and
 *                   the mail was readable by any other local user
 *   upgrade         a tree already at 0755 was never repaired by anything
 *
 * That is a hole in precisely the threat model the unlock/session gate is drawn
 * around. The gate raises the bar from "anything that can reach the port" to
 * "anything that can read this home directory"; a `0755` mail database hands the
 * mail to that second party directly, off disk, without the port, the gate or
 * this app being involved at all. The two mitigations are supposed to compose,
 * and one was quietly cancelling the other.
 *
 * So `ensurePrivateDir` now forces `0700` on EVERY level from the app root down
 * to the directory asked for, on every call. `privateDirChain` below carries the
 * reasoning for the walk, its containment bound, and the symlink stop.
 *
 * WHAT IS STILL NOT OURS TO SET, stated rather than implied: LanceDB creates the
 * `*.lance` table directories and the manifests inside them, at its own modes.
 * Nothing here changes those and nothing here should pretend to. They are
 * protected by being unreachable — `0700` on every ancestor means another local
 * user cannot traverse to them — not by their own permission bits.
 *
 * WHAT THIS DOES NOT BUY, stated so nobody upgrades it in their head: nothing
 * here stops a process running as THIS user. Such a process reads
 * `~/.email-agent/accounts/{email}/token.json` and calls the Gmail API
 * directly, never touching this app. The bar these modes raise is "another
 * local user, or a container mounting this home directory read-only" — which is
 * exactly the bar the unlock/session gate is drawn around too.
 */

import { chmod, lstat, mkdir, rename, writeFile } from "node:fs/promises";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, sep } from "node:path";

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
 * The root of everything this app owns on disk.
 *
 * Computed on every call rather than at module load, deliberately: `homedir()`
 * re-reads `$HOME` on POSIX (measured), so a test that redirects `$HOME` gets
 * the redirected root without the import-ordering trap that `config/defaults.ts`
 * carries. It is also the OUTERMOST directory anything here will ever `chmod` —
 * see `privateDirChain`.
 */
export function appPrivateRoot(): string {
  return join(homedir(), ".email-agent");
}

/**
 * The directories to force `0700` on, OUTERMOST FIRST, when a caller asks for
 * `dir` — every level from the app's own root down to `dir` inclusive.
 *
 * WHY A CHAIN AND NOT JUST THE LEAF. `mkdir(dir, { recursive: true, mode })`
 * applies `mode` to every level it CREATES (measured, node 26.7.0: `a/b/c` all
 * landed `0700`) but NEVER changes a level that already exists (measured: an
 * existing `0755` parent stayed `0755` while its new child got `0700`). So the
 * `mode` covers a fresh install and nothing else. A tree left behind by an
 * earlier version — `~/.email-agent/data/lancedb` at `0755`, holding the mail
 * bodies and their embeddings — is fixed by the `chmod` walk or by nothing at
 * all, and "nothing at all" helps no user who has already run this app.
 *
 * WHY IT STARTS AT THE ROOT AND NOT AT `$HOME`. This is the bound that makes
 * "never chmod something outside this app's own tree" a property of the code
 * rather than a promise. The walk cannot reach `$HOME`, `/`, or a sibling
 * directory, because it is built by appending segments to the root, never by
 * walking up from the leaf. Containment is tested with `relative()` rather than
 * `startsWith(root)`, which would happily match `~/.email-agent-backup`.
 *
 * A `dir` OUTSIDE the root yields just `[dir]` — the old leaf-only behaviour.
 * Callers that pass an arbitrary directory (tests, and any future caller with
 * its own storage) get a private directory and no upward walk at all.
 *
 * Pure, and exported, so both the async and sync variants share ONE definition
 * of which directories are in scope. A second hand-written walk is exactly the
 * drift this module exists to prevent.
 */
export function privateDirChain(
  dir: string,
  root: string = appPrivateRoot(),
): string[] {
  const rel = relative(root, dir);
  if (rel === "") return [root];
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    return [dir];
  }
  const chain = [root];
  let current = root;
  for (const segment of rel.split(sep)) {
    current = join(current, segment);
    chain.push(current);
  }
  return chain;
}

const symlinkNotices = new Set<string>();

/**
 * Says once per process that a level of the chain is a symlink, so the walk
 * stopped there.
 *
 * Once per path, because `ensurePrivateDirSync` runs on the web request path
 * (the session store) and an unguarded warn would print on every request.
 */
function noteSymlinkStop(path: string): void {
  if (symlinkNotices.has(path)) return;
  symlinkNotices.add(path);
  console.warn(
    `[email-agent] ${path} is a symlink, so its permissions were left alone ` +
      `and nothing below it was tightened either. chmod() follows symlinks and ` +
      `there is no lchmod() on Linux, so tightening it would change a mode ` +
      `outside this app's own directory. If it points somewhere shared, set it ` +
      `to 0700 yourself.`,
  );
}

/** For tests: forget which symlink notices have already been printed. */
export function resetSymlinkNoticesForTest(): void {
  symlinkNotices.clear();
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * Creates `dir` if absent and forces `0700` on it AND on every level between it
 * and the app's own root — including levels an older version left at `0755`.
 *
 * Runs on every write rather than once at startup. That is a few `lstat`/`chmod`
 * syscalls on a path that already does file I/O, and it buys self-healing: a
 * directory loosened after the fact (a restore from an archive that dropped
 * modes, an `rsync` without `-p`, a stray `chmod -R`) is tightened again by the
 * next write instead of staying open until someone happens to reinstall.
 * `chmod` to a mode a directory already has is idempotent and unobservable.
 */
export async function ensurePrivateDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  for (const level of privateDirChain(dir)) {
    // A symlink is where the walk stops, not where it throws. `chmod` resolves
    // the link, so tightening it would set a mode on a target this app does not
    // own — and every level BELOW it resolves through the same link, so those
    // are out of the tree too. Refusing outright would brick an install whose
    // data directory is deliberately a symlink onto another volume, which is a
    // legitimate setup we must not punish for a mode we cannot safely set.
    let symlinked = false;
    try {
      symlinked = (await lstat(level)).isSymbolicLink();
    } catch {
      symlinked = false;
    }
    if (symlinked) {
      noteSymlinkStop(level);
      return;
    }
    await chmod(level, PRIVATE_DIR_MODE);
  }
}

/** Synchronous `ensurePrivateDir`, for the request-path session store. */
export function ensurePrivateDirSync(dir: string): void {
  mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  for (const level of privateDirChain(dir)) {
    if (isSymlink(level)) {
      noteSymlinkStop(level);
      return;
    }
    chmodSync(level, PRIVATE_DIR_MODE);
  }
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
