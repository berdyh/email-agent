/**
 * The cross-process mutual exclusion the session store's read-modify-write
 * needs, and nothing else.
 *
 * ─── WHY THIS EXISTS ─────────────────────────────────────────────────────────
 *
 * `config/session.ts` reads `~/.email-agent/session.json`, decides something,
 * and writes the whole file back. Inside one process that is atomic for free —
 * every function there is synchronous, so nothing can interleave. Across
 * processes it was not, and two processes over one store is the ordinary setup
 * rather than an exotic one: `email-agent serve` beside `npm run dev`, two
 * `serve`s on two ports, `email-agent unlock` run while the browser is
 * redeeming. MEASURED against the pre-lock code by
 * `session-cross-process.race.test.ts`: twenty of twenty barrier-synchronised
 * rounds saw BOTH processes redeem the same one-time unlock token, and every
 * rate-limit round recorded one of the two failed guesses instead of two.
 *
 * ─── WHY A LOCKFILE, AND NOT THE TWO OTHER SHAPES ────────────────────────────
 *
 * `rename()` as the atomic commit: already in use (`writePrivateFileSync`
 * renames a finished temp file over the target), and it is what gives readers
 * whole-file atomicity. It does NOT help here, because rename always overwrites:
 * two processes that both read version N both commit version N+1, and the second
 * silently erases the first. Atomic writes are not a compare-and-swap.
 *
 * An `O_EXCL` marker per token, so that creating `<hash>.burn` IS the burn: a
 * genuinely elegant fit for the burn, with nothing to release and nothing to go
 * stale. Rejected because the burn is not the only loss — the review named the
 * rate-limit window in the same breath, and `renewSession` writes back a store
 * it read earlier, so it can resurrect a token another process just burned. A
 * marker fixes one of those three. One mechanism around the whole
 * read-modify-write fixes all three, and a second concurrency mechanism beside
 * the first is a thing that drifts.
 *
 * ─── WHY THIS IS NOT `db/migration-lock.ts` COMING BACK ──────────────────────
 *
 * That module was deleted in `3c64219` along with 953 lines of snapshot and
 * replay machinery, and the standing prohibition is about the DATABASE. The
 * reason it went is worth reading before writing any lock: it existed only to
 * make a drop-and-recreate table migration survivable — a design that should not
 * have existed — and review had already found that its `mkdir` lock "can admit
 * two owners". Hardening it would have been hardening the wrong mechanism, so
 * the mechanism went instead. LanceDB then carried the atomicity itself, in MVCC
 * commit checks the code could lean on.
 *
 * Neither half of that applies here. There is no wrong design underneath to
 * delete: a one-time token has to be burned exactly once, the file is plain JSON
 * with no commit check of its own, and no rewrite makes an external
 * read-modify-write atomic. And the specific defect that condemned the old lock
 * — two owners — is what the takeover protocol below is built to avoid, rather
 * than something it hopes will not happen.
 *
 * ─── NO DEADLOCK, AND NO BRICK: THE TWO THINGS THAT MATTER ───────────────────
 *
 * A lock that survives `kill -9` and refuses every future unlock is worse than
 * the race it fixes. Four properties, each load-bearing:
 *
 *  1. **A dead holder is detected as dead, not merely as old.** Staleness is
 *     decided by asking the operating system whether the recorded PID still
 *     exists (`process.kill(pid, 0)`), NOT by an age threshold. An age threshold
 *     alone was written first and was wrong in both directions: it steals from a
 *     live holder that is merely slow (a real hazard — the threshold has to be
 *     shorter than the acquisition budget, so the two numbers are in tension),
 *     and until it elapses it makes every waiter beside a corpse wait out the
 *     whole threshold for no reason. A liveness check has neither problem: a
 *     crashed holder is broken IMMEDIATELY, and a live one is never broken.
 *  2. **PID reuse and foreign PID namespaces cannot brick it either.** A
 *     recorded PID can be reused by an unrelated process, and a lock written
 *     inside a different PID namespace names a number that means nothing here —
 *     in both cases the liveness check answers "alive" forever. So there is also
 *     an absolute cap (`LOCK_MAX_HOLD_MS`, 30s): a lock older than that is
 *     broken whatever its PID says. Thirty seconds is ~30,000x the section it
 *     guards, so no honest holder can reach it.
 *  3. **Takeover has exactly one winner.** The obvious `unlink()` + retry is a
 *     TOCTOU: two waiters both see a stale lock, both unlink, both create, and
 *     there are two holders — which is the precise defect that killed the old
 *     migration lock. So a stale lock is `rename()`d to a unique doomed name
 *     first. Rename is atomic and single-winner; every loser gets ENOENT. The
 *     winner of the rename does NOT thereby own the lock — it has only cleared
 *     the way, and everyone still races the ordinary `O_EXCL` create.
 *  4. **A caller cannot wait forever.** The budget is finite and the answer on
 *     exhaustion is `null`, which each caller answers in its own way. Nothing
 *     here decides that for them: see `config/session.ts`, where the exchange
 *     fails closed, minting proceeds unlocked, and renewal skips.
 *
 * SELF-DEADLOCK IS IMPOSSIBLE BY CONSTRUCTION, not by care: every function that
 * takes this lock is synchronous end to end and never calls another one. While
 * a process is inside the section, no other code in that process runs at all, so
 * it cannot reach a second acquisition and block on itself. If anything here
 * ever becomes async, that guarantee is gone — which is one more reason
 * `exchangeUnlockToken` must stay `await`-free.
 *
 * THE COST, STATED: with a live holder the wait is real, and after the budget
 * the answer is "busy, try again" rather than a result. The worst case is
 * therefore a bounded delay plus a retry — never a lost update, and never a
 * permanent refusal, because the only way to hold the lock past the cap is to be
 * a PID that is not really the holder, which the cap breaks.
 */

import { closeSync, openSync, renameSync, statSync, unlinkSync, writeSync } from "node:fs";
import { readFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { dirname } from "node:path";
import { ensurePrivateDirSync } from "../shared/private-files.js";

/**
 * How long one acquisition attempt may spend waiting for a LIVE holder before
 * giving up and returning `null`.
 *
 * This is a synchronous wait, so it is also the worst case a request thread can
 * be blocked for. Reaching it takes a genuinely wedged peer: the guarded section
 * is a `readFileSync` and a few-KB `writeFileSync` on one small JSON file.
 */
export const LOCK_ACQUIRE_BUDGET_MS = 3_000;

/**
 * The absolute ceiling on a lock's life, whatever its PID claims.
 *
 * Property 2 in the header: a recorded PID can be reused, or can belong to
 * another PID namespace, and in either case the liveness check would answer
 * "alive" forever. This is the backstop that keeps that from being permanent.
 * Deliberately far LONGER than `LOCK_ACQUIRE_BUDGET_MS`, because it is not a
 * hold timeout for honest holders — a waiter that meets one of these answers
 * `busy` first, and the next attempt after the cap breaks it.
 */
export const LOCK_MAX_HOLD_MS = 30_000;

/**
 * How long a lock file may be unreadable or unparsable before it counts as
 * dead.
 *
 * Creating the lock is two syscalls — `open(O_EXCL)` then `write` — so for a few
 * microseconds a reader sees an EMPTY file with no PID in it. Treating that as
 * dead immediately would break the lock of a holder that had just taken it. A
 * second is six orders of magnitude more than that window needs, and it is also
 * what covers a lock file left behind truncated by a crash mid-write.
 */
export const LOCK_UNREADABLE_GRACE_MS = 1_000;

/** The lock file that guards `path`. */
export function lockPathFor(path: string): string {
  return `${path}.lock`;
}

export interface HeldLock {
  release(): void;
}

/**
 * Blocks the thread for `ms`, synchronously.
 *
 * `Atomics.wait` on a throwaway `SharedArrayBuffer` is the only real synchronous
 * sleep Node has (it is permitted on the main thread here, unlike in a browser).
 * A `Date.now()` spin would burn a core for the whole wait; this parks the
 * thread properly.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Whether the process holding this lock still exists.
 *
 * Signal 0 performs the permission and existence checks without delivering
 * anything. `ESRCH` is the one answer that means "gone": `EPERM` means the
 * process is there but owned by someone else, which for this store cannot
 * happen (mode 0700) but must still not be read as dead.
 */
function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** The PID recorded in a lock file, or `null` if it cannot be read. */
function lockHolderPid(lockPath: string): number | null {
  let raw: string;
  try {
    raw = readFileSync(lockPath, "utf-8");
  } catch {
    return null;
  }
  const pid = Number(raw.split("\n")[1]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
}

/**
 * Whether the lock at `lockPath` is a corpse: its holder has exited, or it has
 * outlived the absolute cap, or it has been unreadable for longer than the
 * moment it takes to write one.
 */
function lockIsDead(lockPath: string, nowMs: number): boolean {
  let ageMs: number;
  try {
    ageMs = nowMs - statSync(lockPath).mtimeMs;
  } catch {
    // Already gone. Not dead — absent, which the create attempt handles.
    return false;
  }
  if (ageMs > LOCK_MAX_HOLD_MS) return true;

  const pid = lockHolderPid(lockPath);
  if (pid === null) return ageMs > LOCK_UNREADABLE_GRACE_MS;
  return !processIsAlive(pid);
}

/**
 * Clears a lock whose holder is gone, with exactly one winner.
 *
 * See property 3 in the header for why this renames rather than unlinking. It
 * returns nothing on purpose: winning the rename confers no ownership, and a
 * caller that read it as "the lock is mine now" would reintroduce the two-owner
 * bug this shape exists to avoid.
 */
function breakStaleLock(lockPath: string, nowMs: number): void {
  if (!lockIsDead(lockPath, nowMs)) return;

  const doomed = `${lockPath}.stale-${randomBytes(6).toString("hex")}`;
  try {
    renameSync(lockPath, doomed);
  } catch {
    // Another waiter renamed it first, or the holder released it. Either way the
    // path is clear (or newly re-taken) and the next create attempt decides.
    return;
  }
  try {
    unlinkSync(doomed);
  } catch {
    // A leftover `.stale-*` file is inert: nothing ever reads one, and it does
    // not block acquisition. Losing the unlink must not fail the acquisition.
  }
}

/**
 * Takes the lock guarding `path`, or returns `null` if the budget ran out.
 *
 * `null` is a normal answer, not an error — each caller decides what it means
 * for them.
 */
export function acquireStoreLock(path: string, nowMs: number = Date.now()): HeldLock | null {
  const lockPath = lockPathFor(path);
  const owner = randomBytes(8).toString("hex");
  const deadline = nowMs + LOCK_ACQUIRE_BUDGET_MS;
  ensurePrivateDirSync(dirname(lockPath));

  let backoffMs = 1;
  for (;;) {
    try {
      // `wx` is `O_CREAT | O_EXCL`: the create either wins or fails, atomically,
      // with no window between checking and creating.
      const fd = openSync(lockPath, "wx", 0o600);
      try {
        // Line 1 identifies the holder for `release`; line 2 is the PID the
        // liveness check reads. Both are written immediately after the create,
        // which is the window `LOCK_UNREADABLE_GRACE_MS` covers.
        writeSync(fd, `${owner}\n${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return { release: () => releaseStoreLock(lockPath, owner) };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    }

    const now = Date.now();
    breakStaleLock(lockPath, now);
    if (now >= deadline) return null;
    sleepSync(backoffMs);
    // Ramped rather than fixed: the common contended case resolves in the first
    // millisecond, and a long wait should not spin at that rate for three
    // seconds.
    backoffMs = Math.min(backoffMs * 2, 25);
  }
}

/**
 * Releases the lock, but only if it is still OURS.
 *
 * The owner check exists for the one window a takeover can open: if this
 * process's lock was broken (it outlived `LOCK_MAX_HOLD_MS`, or its PID was not
 * really it), the file now on disk belongs to somebody else, and unlinking it
 * blindly would hand a third process the lock while the second is still inside
 * the section. Reading and unlinking is not itself atomic, so this NARROWS that
 * window rather than closing it — but it turns "always wrong after a takeover"
 * into "wrong only if the takeover lands between these two syscalls".
 */
function releaseStoreLock(lockPath: string, owner: string): void {
  try {
    if (readFileSync(lockPath, "utf-8").split("\n")[0] !== owner) return;
  } catch {
    // Already gone. Nothing to release.
    return;
  }
  try {
    unlinkSync(lockPath);
  } catch {
    // A release that cannot unlink leaves a lock that goes stale in
    // LOCK_STALE_MS and is broken by the next waiter. Throwing here would turn a
    // successful, committed operation into a failure.
  }
}

/**
 * Runs `body` holding the lock, or `onBusy` if the lock could not be taken.
 *
 * The two-callback shape is deliberate: it makes every caller state, at the call
 * site, what contention means for them. There is no default, because the right
 * answer genuinely differs — see the three callers in `config/session.ts`.
 */
export function withStoreLock<T>(
  path: string,
  nowMs: number,
  body: () => T,
  onBusy: () => T,
): T {
  const lock = acquireStoreLock(path, nowMs);
  if (!lock) return onBusy();
  try {
    return body();
  } finally {
    lock.release();
  }
}
