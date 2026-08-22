// THE STORE LOCK'S OWN PROPERTIES — the ones that are about the lock rather
// than about the session store it guards.
//
// `session-cross-process.race.test.ts` proves the lock does its job with two
// real OS processes. What it cannot show is what happens when the lock is NOT
// released: a lockfile that survives `kill -9` and blocks every future unlock is
// strictly worse than the race it was added to fix, so the recovery path needs
// direct coverage, and so does the promise that a caller cannot be blocked
// forever.
//
// A lock file written straight to disk here is not a simulation — it is byte for
// byte what another process's lock is, which is the whole reason this mechanism
// works across processes at all. The PIDs in it are real too: a live one is this
// test process, and a dead one is a child that has already exited.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { describe, it } from "node:test";
import { useTempHome } from "../testing/lancedb-fixture.js";

await useTempHome("session-lock");

const { SESSION_PATH } = await import("./defaults.js");
const {
  LOCK_ACQUIRE_BUDGET_MS,
  LOCK_MAX_HOLD_MS,
  acquireStoreLock,
  lockPathFor,
  withStoreLock,
} = await import("./session-lock.js");
const { exchangeUnlockToken, mintUnlockToken } = await import("./session.js");
const { ensurePrivateDirSync } = await import("../shared/private-files.js");

const LOCK = lockPathFor(SESSION_PATH);

/**
 * A PID that is genuinely gone: a child that has already exited by the time
 * `spawnSync` returns. Reused across the file, since re-spawning per test would
 * only produce another number with the same property.
 */
const DEAD_PID = spawnSync(process.execPath, ["-e", ""]).pid;

/** A lock file held by somebody else, exactly as their process would write it. */
function plantLock(pid: number, ageMs = 0): void {
  ensurePrivateDirSync(dirname(SESSION_PATH));
  writeFileSync(LOCK, `someone-else\n${pid}\n`);
  const at = new Date(Date.now() - ageMs);
  utimesSync(LOCK, at, at);
}

/** Removes a planted lock through the real takeover path. */
function clearPlantedLock(): void {
  plantLock(DEAD_PID);
  acquireStoreLock(SESSION_PATH)?.release();
  assert.equal(existsSync(LOCK), false);
}

describe("the session store lock", () => {
  it("breaks a crashed holder's lock immediately, without waiting anything out", () => {
    plantLock(DEAD_PID);
    const started = Date.now();
    const held = acquireStoreLock(SESSION_PATH);
    const elapsed = Date.now() - started;

    assert.ok(held, "a lock left behind by a killed process must be recoverable");
    // The no-brick property, and the reason staleness is a LIVENESS question
    // rather than an age one: there is nothing to wait for. An age threshold
    // would have made every waiter beside this corpse sit out the threshold.
    assert.ok(elapsed < 250, `takeover took ${elapsed}ms; it should be immediate`);
    held.release();
    assert.equal(existsSync(LOCK), false, "release must remove the lock it holds");
  });

  it("breaks a lock older than the absolute cap even though its PID is alive", () => {
    // PID reuse, or a lock written inside another PID namespace: the liveness
    // check answers "alive" forever, so without the cap this would be permanent.
    // `process.pid` is the most unambiguously live PID available here.
    plantLock(process.pid, LOCK_MAX_HOLD_MS * 2);
    const held = acquireStoreLock(SESSION_PATH);
    assert.ok(held, "a lock past LOCK_MAX_HOLD_MS must be breakable whatever its PID says");
    held.release();
  });

  it("orders the cap after the budget, so a waiter answers `busy` before stealing", () => {
    assert.ok(
      LOCK_ACQUIRE_BUDGET_MS < LOCK_MAX_HOLD_MS,
      `LOCK_ACQUIRE_BUDGET_MS (${LOCK_ACQUIRE_BUDGET_MS}) must be shorter than ` +
        `LOCK_MAX_HOLD_MS (${LOCK_MAX_HOLD_MS}): a waiter must give up on a live ` +
        `holder rather than steal from it, and the cap is only a backstop`,
    );
  });

  it("releases the lock when the guarded body throws", () => {
    assert.throws(() => {
      withStoreLock(
        SESSION_PATH,
        Date.now(),
        () => {
          throw new Error("boom");
        },
        () => undefined,
      );
    }, /boom/);
    assert.equal(
      existsSync(LOCK),
      false,
      "a throw inside the section must not leave the store locked",
    );
  });

  it("does not unlink a lock that was taken over from it", () => {
    // The one window a takeover opens: this process's lock was broken, and the
    // file on disk now belongs to somebody else. Releasing it would hand a third
    // process the lock while the second is still inside the section.
    const held = acquireStoreLock(SESSION_PATH);
    assert.ok(held);
    writeFileSync(LOCK, `a-different-owner\n${process.pid}\n`);
    held.release();
    assert.equal(
      existsSync(LOCK),
      true,
      "release must check that the lock is still ours before removing it",
    );
    clearPlantedLock();
  });
});

describe("the session store under contention", () => {
  it("answers `busy` rather than burning or lying about a valid token", () => {
    const { token } = mintUnlockToken();
    // A live holder that is not this call: the lock is never stolen from it, so
    // the acquisition budget is spent and `busy` is the honest answer.
    plantLock(process.pid);

    const started = Date.now();
    const result = exchangeUnlockToken(token);
    const elapsed = Date.now() - started;

    assert.ok(!result.ok, `expected a failure, got ${JSON.stringify(result)}`);
    assert.equal(result.reason, "busy");
    // A caller is delayed, never deadlocked — the budget is a real ceiling.
    assert.ok(elapsed >= LOCK_ACQUIRE_BUDGET_MS, `gave up after ${elapsed}ms`);
    assert.ok(elapsed < LOCK_ACQUIRE_BUDGET_MS * 3, `waited ${elapsed}ms, far past the budget`);

    clearPlantedLock();

    // The two things `busy` promises. First: nothing was spent, so the user's
    // one-time link still works once the other process lets go.
    assert.ok(
      exchangeUnlockToken(token).ok,
      "a token refused for contention must still be redeemable",
    );

    // Second: it did not count against the rate-limit window. Reporting
    // contention as `invalid` would have spent the caller's budget for them.
    const store = JSON.parse(readFileSync(SESSION_PATH, "utf-8")) as { failures: number[] };
    assert.equal(store.failures.length, 0);
  });

  it("mints anyway when the lock cannot be taken, because minting is the way back in", () => {
    plantLock(process.pid);
    const minted = mintUnlockToken();
    // Deliberately fails OPEN, unlike the exchange. See `mintUnlockToken`: a
    // correctness property that leaves a locked-out user with no recovery
    // command is the wrong trade, and the worst a lost update costs here is
    // another `email-agent unlock`.
    assert.ok(minted.token.length > 0);
    clearPlantedLock();
    assert.ok(exchangeUnlockToken(minted.token).ok, "the minted token must be redeemable");
  });
});
