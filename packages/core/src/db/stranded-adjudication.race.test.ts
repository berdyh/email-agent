// These drive REAL concurrent operations against a REAL LanceDB in a temp
// directory under a throwaway $HOME. Nothing here is mocked: the claim, the
// adjudication and the apply's write-back all go through the same functions the
// product calls, against the same table.
//
// That is the only way these claims can be made. The window under test is
// entirely a property of what LanceDB's `update()` predicates match at the
// moment they run — the thing a fake table would have to model, and would model
// according to whatever the author already believed.

import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";

// `config/defaults.ts` computes LANCEDB_DIR from `homedir()` at module load, so
// $HOME has to be redirected BEFORE the first core import. Static imports are
// hoisted above every statement, so the dynamic imports below are the only
// ordering that actually works. `node --test` gives each test file its own
// process, so this does not leak into any other suite.
const home = await mkdtemp(join(tmpdir(), "email-agent-stranded-home-"));
process.env["HOME"] = home;
process.env["USERPROFILE"] = home;

const { getDb, initDb } = await import("./connection.js");
const { pendingOperationsTable } = await import("./schema.js");
const {
  claimPendingOperations,
  describeLostClaimedOutcomes,
  getPendingOperationsByIds,
  resolveClaimedOperations,
  savePendingOperations,
  STALE_APPLYING_THRESHOLD_MS,
} = await import("./pending-operations.js");
const { adjudicateStrandedOperations, STRANDED_APPLIED_NOTE } = await import(
  "../actions/approval.js"
);

after(async () => {
  await rm(home, { recursive: true, force: true });
});

await initDb();

async function seedPending(id: string): Promise<void> {
  await savePendingOperations([
    {
      id,
      batchId: "batch-1",
      actionId: "junk",
      actionName: "Junk Detector",
      accountId: "me@example.com",
      emailId: `m-${id}`,
      type: "trash",
      labelIds: "[]",
      status: "pending",
      error: "",
      claimToken: "",
      createdAt: "2026-08-01T00:00:00.000Z",
      claimedAt: "",
      resolvedAt: "",
    },
  ]);
}

/** Ages a claimed row so it looks hung rather than merely in flight. */
async function backdateClaim(id: string, ms: number): Promise<void> {
  const db = await getDb();
  const table = await db.openTable(pendingOperationsTable);
  await table.update({
    where: `id = '${id}'`,
    values: { claimedAt: new Date(Date.now() - ms).toISOString() },
  });
}

async function readRow(id: string) {
  const [row] = await getPendingOperationsByIds([id]);
  assert.ok(row, `row ${id} vanished`);
  return row;
}

/** Runs `fn` with console.warn captured. */
async function capturingWarnings<T>(
  fn: () => Promise<T>,
): Promise<{ value: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.map(String).join(" "));
  };
  try {
    return { value: await fn(), warnings };
  } finally {
    console.warn = original;
  }
}

describe("adjudicating a row an apply is still working on", () => {
  it("refuses a row that is not actually stale, so the apply keeps its outcome", async () => {
    // THE FIX for the in-flight window. The ids a surface submits are just ids;
    // before the cutoff moved into the write predicate, a row claimed one
    // second ago could be adjudicated by any client that named it, and the
    // apply's own write-back then matched nothing.
    const id = "op-fresh";
    await seedPending(id);
    const claimed = await claimPendingOperations([id], "token-A", "applying");
    assert.equal(claimed.length, 1);

    const resolved = await adjudicateStrandedOperations([id], "notApplied");
    assert.equal(resolved, 0);

    const untouched = await readRow(id);
    assert.equal(untouched.status, "applying");
    assert.equal(untouched.claimToken, "token-A");

    // The apply returns from Gmail and records the truth, unimpeded.
    const { value, warnings } = await capturingWarnings(() =>
      resolveClaimedOperations(
        [{ id, status: "applied" }],
        "token-A",
        new Date().toISOString(),
      ),
    );
    assert.deepEqual(value, { resolved: 1, lost: [] });
    assert.deepEqual(warnings, []);
    assert.equal((await readRow(id)).status, "applied");
  });

  it("still beats an apply hung past the threshold — and says the outcome was lost", async () => {
    // THE WINDOW THAT REMAINS. An apply that hangs past
    // STALE_APPLYING_THRESHOLD_MS and then succeeds loses the race: the
    // adjudication has already re-stamped the token, so the write-back matches
    // nothing. The `applied` fact is real and is discarded. This test pins the
    // consequence (the row is pending and re-approvable — the change can reach
    // Gmail twice) and pins that we NOTICE, which is the part that was silent.
    const id = "op-hung";
    await seedPending(id);
    await claimPendingOperations([id], "token-A", "applying");
    await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

    const resolved = await adjudicateStrandedOperations([id], "notApplied");
    assert.equal(resolved, 1);
    const requeued = await readRow(id);
    assert.equal(requeued.status, "pending");
    assert.equal(requeued.claimToken, "");

    const { value, warnings } = await capturingWarnings(() =>
      resolveClaimedOperations(
        [{ id, status: "applied" }],
        "token-A",
        new Date().toISOString(),
      ),
    );

    assert.equal(value.resolved, 0);
    assert.deepEqual(value.lost, [{ id, status: "applied" }]);
    // The row really is back in the approval queue: the same trash can be sent
    // to Gmail a second time, and the audit trail says it never happened.
    assert.equal((await readRow(id)).status, "pending");

    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], describeLostClaimedOutcomes(value.lost));
    assert.match(String(warnings[0]), /reached Gmail successfully/);
    assert.match(String(warnings[0]), /a second time/);
  });

  it("records a genuinely stranded row on the user's word", async () => {
    const id = "op-stranded";
    await seedPending(id);
    await claimPendingOperations([id], "token-A", "applying");
    await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

    assert.equal(await adjudicateStrandedOperations([id], "applied"), 1);
    const row = await readRow(id);
    assert.equal(row.status, "applied");
    assert.equal(row.error, STRANDED_APPLIED_NOTE);
    // The lease is released, or a later claim-scoped read would match a row it
    // does not own.
    assert.equal(row.claimToken, "");
  });
});
