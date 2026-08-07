// CROSS-PROCESS CLAIM ATOMICITY. Two forked OS processes, one LanceDB
// directory, both trying to claim the same three rows, six rounds.
//
// This is the guarantee the entire approval gate rests on: a row is moved out
// of `pending` and stamped with an attempt's token BEFORE any Gmail call, and
// only the rows an attempt actually won come back. If two concurrent claims
// could both commit, two processes would each believe they owned the same
// change, both would call Gmail, and a rejection issued during an apply could
// be reported as honored and then silently overwritten.
//
// WHY IT HAD TO BE FORKED PROCESSES. Every earlier probe was in-process:
//   * two `addColumns()` calls — a SCHEMA conflict, a different conflict class;
//   * two `update()` calls through two handles of ONE connection — the right
//     class, but one process, and the whole question was whether a second OS
//     process over the same directory behaves the same way.
// A same-process test cannot answer it, and a fake table would answer it
// according to whatever the author already believed.
//
// WHY THE OUTCOME IS DETERMINISTIC AND NOT A TIMING BET. The two workers run a
// two-phase barrier: both open a FRESH table handle (phase "prepare") and only
// then is either told to write (phase "go"). A LanceDB handle is pinned to the
// version it was opened at, so both hold the same read version when they write,
// and whichever commits second is committing against a version that has moved —
// which the commit check refuses. The race is real (which process wins varies
// run to run, and is reported below), but "exactly one wins" does not depend on
// who wins.
//
// WHAT THIS PINS, at two levels:
//   raw   — `table.update()` on the pinned handle. Exactly one commits; the
//           other THROWS `Commit conflict for version N`. No row is claimed
//           twice, and the loser's token is on nothing.
//   claim — `claimPendingOperations()`, what the product actually calls. It
//           wraps the primitive in `updateAtLatestVersion` (refresh + bounded
//           retry), which converts that error into the SILENT no-op the claim
//           protocol assumes: the loser gets zero rows and no exception.
//
// The gap between those two rows is the consequence that has to be handled and
// is asserted here rather than described: a caller that reaches LanceDB WITHOUT
// `updateAtLatestVersion` receives an error, not a no-op, and must read that
// specific error as "someone else got there first".

import assert from "node:assert/strict";
import { fork, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
// Neither of these touches $HOME, so a static import is safe above the
// useTempDb() call; only CORE modules have to wait for it.
import ts from "typescript";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { useTempDb } from "../testing/lancedb-fixture.js";

const home = await useTempDb("claim-race");

const { readAllPendingOperations, seedPendingOperations } = await import(
  "../testing/lancedb-fixture.js"
);
const { getDb } = await import("./connection.js");
const { pendingOperationsTable } = await import("./schema.js");

import type {
  DoneMessage,
  ParentMessage,
  WorkerMessage,
  WorkerMode,
} from "../testing/claim-race-worker.js";

const WORKER = fileURLToPath(
  new URL("../testing/claim-race-worker.ts", import.meta.url),
);
const ROUNDS = 6;
const CONTESTED = ["race-1", "race-2", "race-3"];

await seedPendingOperations(CONTESTED.map((id) => ({ id, status: "pending" })));

const children: ChildProcess[] = [];
after(() => {
  for (const child of children) child.kill();
});

function spawnWorker(mode: WorkerMode, label: string): ChildProcess {
  const child = fork(WORKER, [mode, label], {
    // The child is a real `node` process; tsx is loaded the same way the test
    // runner loads it, so the worker runs from source like everything else.
    execArgv: ["--import", "tsx"],
    // $HOME is how LANCEDB_DIR reaches the child — the same mechanism a real
    // second process would use, not an injected path.
    env: { ...process.env, HOME: home.path, USERPROFILE: home.path },
    stdio: ["ignore", "ignore", "inherit", "ipc"],
  });
  children.push(child);
  return child;
}

/** Resolves with the next message of `type` from `child`. */
function nextMessage<T extends WorkerMessage["type"]>(
  child: ChildProcess,
  type: T,
): Promise<Extract<WorkerMessage, { type: T }>> {
  return new Promise((resolve, reject) => {
    const onMessage = (raw: unknown) => {
      const message = raw as WorkerMessage;
      if (message.type !== type) return;
      cleanup();
      resolve(message as Extract<WorkerMessage, { type: T }>);
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

/** Puts the three contested rows back to `pending` for the next round. */
async function resetContested(): Promise<void> {
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  await table.checkoutLatest();
  await table.update({
    where: `id IN (${CONTESTED.map((id) => `'${id}'`).join(", ")})`,
    values: { status: "pending", claimToken: "", claimedAt: "", resolvedAt: "" },
  });
}

interface RoundOutcome {
  round: number;
  a: DoneMessage;
  b: DoneMessage;
}

/**
 * Runs `ROUNDS` barrier-synchronised rounds and returns both sides' answers.
 * The workers are started once and reused, so every round is a fresh handle
 * over a table the previous round has already moved.
 */
async function race(mode: WorkerMode): Promise<RoundOutcome[]> {
  const a = spawnWorker(mode, "A");
  const b = spawnWorker(mode, "B");
  const outcomes: RoundOutcome[] = [];

  for (let round = 0; round < ROUNDS; round++) {
    await resetContested();

    // PHASE 1 — both open their handle. Neither has written yet.
    post(a, { type: "prepare", round });
    post(b, { type: "prepare", round });
    await Promise.all([nextMessage(a, "ready"), nextMessage(b, "ready")]);

    // PHASE 2 — release both in the same tick.
    const settled = Promise.all([nextMessage(a, "done"), nextMessage(b, "done")]);
    post(a, { type: "go", round, ids: CONTESTED, token: `A-${String(round)}` });
    post(b, { type: "go", round, ids: CONTESTED, token: `B-${String(round)}` });
    const [aDone, bDone] = await settled;

    outcomes.push({ round, a: aDone, b: bDone });
  }

  a.kill();
  b.kill();
  return outcomes;
}

function describeWinners(outcomes: RoundOutcome[]): string {
  return outcomes
    .map((outcome) => (outcome.a.won.length > 0 ? "A" : outcome.b.won.length > 0 ? "B" : "-"))
    .join("");
}

describe("two OS processes claiming the same rows", () => {
  it("raw table.update(): exactly one commits, the other is refused with a commit conflict", async () => {
    const outcomes = await race("raw");

    for (const { round, a, b } of outcomes) {
      const winners = [a, b].filter((side) => side.error === null);
      const losers = [a, b].filter((side) => side.error !== null);

      assert.equal(
        winners.length,
        1,
        `round ${String(round)}: expected exactly one commit, got ${String(winners.length)} ` +
          `(A: ${a.error ?? "ok"} / B: ${b.error ?? "ok"})`,
      );
      assert.equal(losers.length, 1);

      // THE ERROR THE LOSER GETS. Asserted on its text because calling code has
      // to recognise it: `isCommitConflict()` in `db/pending-operations.ts`
      // matches /commit conflict/i, and this is the string it matches.
      assert.match(
        String(losers[0]?.error),
        /commit conflict for version/i,
        `round ${String(round)}: the loser must be refused, not silently succeed`,
      );

      // Exactly one owner of all three rows; the loser owns nothing.
      assert.deepEqual(
        [...(winners[0]?.won ?? [])].sort(),
        CONTESTED,
        `round ${String(round)}: the winner must own all three rows`,
      );
      assert.deepEqual(losers[0]?.won, []);
    }

    // ZERO ROWS CLAIMED TWICE — the property the gate actually needs. Read off
    // the table rather than off the workers' reports.
    const rows = await readAllPendingOperations();
    const contested = rows.filter((row) => CONTESTED.includes(row.id));
    assert.equal(contested.length, 3, "no row may be duplicated by a losing commit");
    const tokens = new Set(contested.map((row) => row.claimToken));
    assert.equal(
      tokens.size,
      1,
      `all three rows must carry ONE attempt's token, saw ${[...tokens].join(", ")}`,
    );

    // The race is genuine: which side wins varies run to run. Reported, not
    // asserted — requiring a particular sequence would be a flake, and the
    // guarantee under test is "exactly one wins", not "this one wins".
    console.log(`  raw winners by round: ${describeWinners(outcomes)}`);
  });

  it("claimPendingOperations(): the loser gets zero rows and NO error", async () => {
    // The product path. `updateAtLatestVersion` refreshes the handle and retries
    // a commit conflict on a bounded ladder, so the loser's retry re-evaluates
    // `status = 'pending'` against the winner's committed version, matches
    // nothing, and returns an empty set. That silent no-op is exactly what
    // `applyClaimedOperationsInChunks` assumes when it does
    // `if (rows.length === 0) continue;` — the assumption is now checked
    // against two real processes instead of asserted.
    const outcomes = await race("claim");

    for (const { round, a, b } of outcomes) {
      assert.equal(a.error, null, `round ${String(round)}: A must not throw`);
      assert.equal(b.error, null, `round ${String(round)}: B must not throw`);

      const owned = [...a.won, ...b.won].sort();
      assert.deepEqual(
        owned,
        CONTESTED,
        `round ${String(round)}: every contested row must be won exactly once ` +
          `(A won ${String(a.won.length)}, B won ${String(b.won.length)})`,
      );
      // And it is one owner, not a split: a claim is a single atomic update
      // over the whole id list.
      assert.ok(
        a.won.length === 0 || b.won.length === 0,
        `round ${String(round)}: the three rows were split across both processes`,
      );
    }

    const rows = await readAllPendingOperations();
    const contested = rows.filter((row) => CONTESTED.includes(row.id));
    assert.equal(contested.length, 3);
    assert.deepEqual(
      [...new Set(contested.map((row) => row.status))],
      ["applying"],
    );
    assert.equal(new Set(contested.map((row) => row.claimToken)).size, 1);

    console.log(`  claim winners by round: ${describeWinners(outcomes)}`);
  });
});

// ---------------------------------------------------------------------------
// The consequence, audited.
//
// The two tests above establish that a caller WITHOUT the retry wrapper gets an
// EXCEPTION rather than a no-op when it loses. So every write that is supposed
// to lose a race quietly has to go through `updateAtLatestVersion`, and every
// write that does not has to be one where an error is the right answer. This
// checks that, rather than leaving it as something a reader has to verify.
// ---------------------------------------------------------------------------

/**
 * Every `<expr>.update(` call in `source`, as `line:enclosingFunctionName`.
 * AST-based, so a mention in a comment or a string is not a call.
 */
function updateCallSites(file: string, source: string): string[] {
  const sourceFile = ts.createSourceFile(
    file,
    source,
    ts.ScriptTarget.ES2022,
    true,
  );
  const sites: string[] = [];

  const enclosingName = (node: ts.Node): string => {
    for (let cur: ts.Node | undefined = node.parent; cur; cur = cur.parent) {
      if (ts.isFunctionDeclaration(cur) && cur.name) return cur.name.text;
      if (
        ts.isVariableDeclaration(cur.parent ?? cur) &&
        ts.isIdentifier((cur.parent as ts.VariableDeclaration).name)
      ) {
        return ((cur.parent as ts.VariableDeclaration).name as ts.Identifier).text;
      }
    }
    return "<top level>";
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      node.expression.name.text === "update"
    ) {
      const line =
        sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
      sites.push(`${String(line)}:${enclosingName(node)}`);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(sourceFile, visit);
  return sites;
}

describe("who has to handle the commit conflict", () => {
  it("every approval-queue write goes through the retry wrapper", async () => {
    // A queue write that skipped `updateAtLatestVersion` would THROW where the
    // claim protocol expects "I lost, zero rows" — turning a routine race
    // between the CLI and `serve` into a failed apply.
    const path = fileURLToPath(new URL("./pending-operations.ts", import.meta.url));
    const source = await readFile(path, "utf8");

    const sites = updateCallSites(path, source);
    assert.ok(sites.length > 0, "the walk found no update() call at all");

    const outsideWrapper = sites.filter(
      (site) => !site.endsWith(":updateAtLatestVersion"),
    );
    assert.deepEqual(
      outsideWrapper,
      [],
      `pending-operations.ts calls table.update() outside updateAtLatestVersion at ` +
        `${outsideWrapper.join(", ")}. A commit conflict there is an exception, not the ` +
        `silent no-op the claim protocol assumes.`,
    );
  });

  it("names the modules that still take the raw error, with what it means there", async () => {
    // NOT a claim that these are safe — a claim that they are KNOWN. Each opens
    // its own handle and writes without a refresh-and-retry, so a concurrent
    // committer makes them throw. They are all single-write, non-queue paths
    // where an error surfaces to a caller that can retry the user action, which
    // is why this is recorded rather than swept; the residual is tracked in
    // TODOS.md ("other queue helpers still hold stale handles").
    const known: Record<string, string> = {
      "emails.ts":
        "read-status, vector and stale-unread writes — a cached mailbox flag, " +
        "not a Gmail mutation; a conflict surfaces as a failed request the user can repeat",
      "clusters.ts": "delete-all + add, run only by an explicit clustering pass",
    };

    for (const [file, reason] of Object.entries(known)) {
      const path = fileURLToPath(new URL(`./${file}`, import.meta.url));
      const source = await readFile(path, "utf8");
      assert.ok(reason.length > 0);
      // If one of these ever starts writing `pending_operations`, it joins the
      // rule above instead of this list.
      assert.ok(
        !source.includes("pendingOperationsTable"),
        `${file} now writes the approval queue and must use updateAtLatestVersion`,
      );
    }
  });
});
