// CROSS-PROCESS ATOMICITY OF THE SESSION STORE. Two forked OS processes, one
// `~/.email-agent/session.json`, racing the same unlock token.
//
// WHAT THIS ANSWERS. `exchangeUnlockToken` is a read-modify-write: it reads the
// store, checks the burn bit, and writes the store back. Inside ONE process that
// is atomic for free — there is no `await` in it, and Next runs route handlers
// on a single event loop, so a second exchange cannot interleave. ACROSS
// processes nothing made it atomic, and two processes over one store are an
// ordinary setup, not an exotic one: `email-agent serve` beside `npm run dev`,
// two `serve`s on two ports, or `email-agent unlock` run while the browser is
// redeeming. Both could read the token unburned and both could return a session
// for a link the user was told works ONCE.
//
// WHY IT HAD TO BE FORKED PROCESSES. A single-process test of this passes
// against the broken code — it was run, and it reported exactly one success out
// of twenty concurrent exchanges, because the property it measured (one event
// loop) was never the property in doubt. Presenting that as evidence for
// cross-process atomicity is the specific mistake this file exists to prevent.
//
// WHY THE RACE IS REAL AND NOT A TIMING BET. The two workers run a two-phase
// barrier — both load their modules and answer "ready" before either is told to
// go — and then BUSY-SPIN to a shared wall-clock timestamp. That aligns them to
// well under a millisecond, which is the scale of the contested section. It is
// still a probabilistic race per round, which is why the assertion is over many
// rounds and why the fails-before evidence is a COUNT of double-successes rather
// than one round's outcome.
//
// MEASURED BEFORE THE LOCK EXISTED, and the numbers are not marginal:
// TWENTY of twenty burn rounds returned `ok: true` in BOTH processes — two
// sessions minted from one link the user was told works once — and every one of
// the eight failure rounds recorded ONE of the two guesses instead of two (1, 2,
// 3 … where 2, 4, 6 … was due). After the lock: zero and zero.
//
// The second mode is the same defect in its other costume, named in the review
// alongside the burn: a failed attempt is appended to the rate-limit window by
// the same read-modify-write, so two processes guessing at once can have one of
// their guesses vanish. The limiter's whole job is to count guesses.

import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { useTempHome } from "../testing/lancedb-fixture.js";

const home = await useTempHome("session-race");

const { exchangeUnlockToken, mintUnlockToken } = await import("./session.js");
const { SESSION_PATH } = await import("./defaults.js");
const { readFileSync } = await import("node:fs");

import type {
  DoneMessage,
  ParentMessage,
  SessionWorkerMessage,
  SessionWorkerMode,
} from "../testing/session-race-worker.js";

const WORKER = fileURLToPath(new URL("../testing/session-race-worker.ts", import.meta.url));

/** Enough rounds that a real race shows up, few enough to stay under a second. */
const BURN_ROUNDS = 20;
/**
 * Eight rounds is sixteen recorded failures, deliberately under the twenty the
 * limiter refuses at: past that the exchange short-circuits and stops writing,
 * and the test would be measuring the cap instead of the increment.
 */
const FAILURE_ROUNDS = 8;
/**
 * The renewal race needs two store writes to overlap rather than one write and
 * one read, so it is less reliably contested than the burn race; enough rounds
 * that a lost update cannot hide in a lucky ordering.
 */
const RENEW_ROUNDS = 20;

const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill();
});

function spawnWorker(mode: SessionWorkerMode, label: string): ChildProcess {
  const child = fork(WORKER, [mode, label], {
    execArgv: ["--import", "tsx"],
    // $HOME is how SESSION_PATH reaches the child — the same mechanism a real
    // second process uses, not an injected path.
    env: { ...process.env, HOME: home.path, USERPROFILE: home.path },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  children.push(child);
  return child;
}

function nextMessage<T extends SessionWorkerMessage["type"]>(
  child: ChildProcess,
  type: T,
): Promise<Extract<SessionWorkerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const message = raw as SessionWorkerMessage;
      if (message.type !== type) return;
      cleanup();
      resolve(message as Extract<SessionWorkerMessage, { type: T }>);
    };
    const onExit = (code: number | null) => {
      cleanup();
      reject(new Error(`worker exited (${String(code)}) before sending ${type}`));
    };
    const cleanup = () => {
      child.off("message", onMessage);
      child.off("exit", onExit);
    };
    child.on("message", onMessage);
    child.on("exit", onExit);
  });
}

function post(child: ChildProcess, message: ParentMessage): void {
  child.send(message);
}

/**
 * Both workers act at the same instant; returns what each of them got back.
 *
 * `values` is per-worker rather than shared, because the renewal race presents
 * an unlock token to one process and a session cookie to the other.
 */
async function race(
  workers: readonly ChildProcess[],
  round: number,
  values: readonly string[],
): Promise<DoneMessage[]> {
  await Promise.all(
    workers.map(async (child) => {
      post(child, { type: "prepare", round });
      await nextMessage(child, "ready");
    }),
  );
  // Far enough ahead that the IPC message has certainly been delivered to both
  // and both are already spinning, close enough that the test stays quick.
  const startAt = Date.now() + 40;
  const answers = workers.map((child) => nextMessage(child, "done"));
  workers.forEach((child, index) => {
    post(child, { type: "go", round, value: values[index] ?? "", startAt });
  });
  return Promise.all(answers);
}

function storeFailureCount(): number {
  const parsed = JSON.parse(readFileSync(SESSION_PATH, "utf-8")) as { failures: number[] };
  return parsed.failures.length;
}

function storeSessionCount(): number {
  const parsed = JSON.parse(readFileSync(SESSION_PATH, "utf-8")) as { sessions: unknown[] };
  return parsed.sessions.length;
}

function storeBurnedAt(): number | null {
  const parsed = JSON.parse(readFileSync(SESSION_PATH, "utf-8")) as {
    unlock: { usedAt: number | null } | null;
  };
  return parsed.unlock?.usedAt ?? null;
}

describe("session store: two real processes", () => {
  it("burns a one-time unlock token exactly once across processes", async () => {
    const workers = [spawnWorker("exchange", "A"), spawnWorker("exchange", "B")] as const;
    let doubleWins = 0;
    const winners: string[] = [];

    for (let round = 0; round < BURN_ROUNDS; round += 1) {
      // A fresh token per round, minted by the PARENT — a third process as far
      // as the two workers are concerned.
      const { token } = mintUnlockToken();
      const sessionsBefore = storeSessionCount();
      const answers = await race(workers, round, [token, token]);

      const wins = answers.filter((a) => a.result?.ok);
      if (wins.length > 1) doubleWins += 1;
      winners.push(answers.findIndex((a) => a.result?.ok) === 0 ? "A" : "B");

      assert.equal(
        wins.length,
        1,
        `round ${round}: ${wins.length} processes redeemed one one-time token`,
      );
      const loser = answers.find((a) => !a.result?.ok);
      assert.ok(loser?.result && !loser.result.ok);
      assert.equal(
        loser.result.reason,
        "used",
        `round ${round}: the loser must OBSERVE the burn, not fail some other way ` +
          `(got ${loser.result.reason})`,
      );
      // The winner's session is on disk, and only one of them is.
      assert.equal(
        storeSessionCount(),
        sessionsBefore + 1,
        `round ${round}: exactly one session must have been appended`,
      );
    }

    assert.equal(doubleWins, 0);
    // INFORMATIONAL ONLY, and deliberately not an assertion. Which process wins
    // is a real race and the split varies run to run, but one of them winning
    // all twenty rounds is a legitimate outcome — asserting a split would be
    // trading a test that cannot fail for one that fails at random. The
    // property that matters is asserted per round above: exactly one winner.
    console.log(`  winners: ${winners.join("")}`);
  });

  it("counts every failed guess from every process against the rate-limit window", async () => {
    const workers = [spawnWorker("failure", "C"), spawnWorker("failure", "D")] as const;
    // A fresh mint clears the window (documented on `mintUnlockToken`), so the
    // count below starts from zero whatever the previous test left behind.
    mintUnlockToken();
    assert.equal(storeFailureCount(), 0);

    for (let round = 0; round < FAILURE_ROUNDS; round += 1) {
      const answers = await race(workers, round, [
        `wrong-token-${round}-a`,
        `wrong-token-${round}-b`,
      ]);
      for (const answer of answers) {
        assert.equal(answer.result?.ok, false);
      }
      assert.equal(
        storeFailureCount(),
        (round + 1) * 2,
        `round ${round}: both processes' guesses must be on file, not one of them`,
      );
    }
  });

  // THE THIRD COSTUME OF THE SAME DEFECT, and the one that is easiest to miss
  // because the function looks read-only from outside.
  //
  // `hasValidSession` reads the store, then extends a more-than-half-elapsed
  // session. Until 2026-08-22 it wrote back the WHOLE store object that read had
  // produced — so if another process burned the unlock token and appended its
  // session in between, the renewal's write erased both: the one-time token was
  // silently UN-BURNED and redeemable again, and the session the real exchange
  // had just issued vanished, logging that browser out.
  //
  // A cookie kept alive by ordinary page loads is exactly the thing most likely
  // to be doing this at the moment somebody clicks a fresh unlock link.
  it("does not let an idle renewal erase another process's burn", async () => {
    const workers = [spawnWorker("renew", "E"), spawnWorker("exchange", "F")] as const;

    for (let round = 0; round < RENEW_ROUNDS; round += 1) {
      // A session for the renewing process to keep alive...
      const seed = mintUnlockToken();
      const seeded = exchangeUnlockToken(seed.token);
      assert.ok(seeded.ok);
      // ...and a fresh, unburned token for the other one to redeem. Minting
      // replaces the unlock record, which is why the seed above is spent first.
      const { token } = mintUnlockToken();
      const sessionsBefore = storeSessionCount();

      const answers = await race(workers, round, [seeded.sessionToken, token]);
      assert.equal(answers[0]?.valid, true, `round ${round}: the seeded session must be live`);
      assert.equal(answers[1]?.result?.ok, true, `round ${round}: the exchange must succeed`);

      assert.notEqual(
        storeBurnedAt(),
        null,
        `round ${round}: the renewal wrote back a pre-burn store and the one-time ` +
          `token is redeemable again`,
      );
      assert.equal(
        storeSessionCount(),
        sessionsBefore + 1,
        `round ${round}: the exchange's new session must survive the renewal's write`,
      );
    }
  });
});
