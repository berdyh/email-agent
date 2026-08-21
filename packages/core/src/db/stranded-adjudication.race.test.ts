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
import { describe, it } from "node:test";
// The shared fixture. It redirects $HOME, then re-reads LANCEDB_DIR and throws
// if the result is not inside the temp directory — so the ordering rule these
// dynamic imports exist for is now CHECKED rather than merely followed. Every
// core import below has to stay a dynamic one, because static imports are
// hoisted above the redirect and would resolve the database path against the
// developer's real home.
import { useTempDb } from "../testing/lancedb-fixture.js";

await useTempDb("stranded");

const {
  claimPendingOperations,
  describeLostClaimedOutcomes,
  resolveClaimedOperations,
  resolveStrandedApplyingOperations,
  STALE_APPLYING_THRESHOLD_MS,
} = await import("./pending-operations.js");
const {
  adjudicateStrandedOperations,
  STRANDED_APPLIED_NOTE,
  STRANDED_VERIFIED_NOTE,
} = await import("../actions/approval.js");
const {
  backdateClaim,
  capturingWarnings,
  readPendingOperation: readRow,
  seedPendingOperations,
} = await import("../testing/lancedb-fixture.js");

async function seedPending(
  id: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  await seedPendingOperations([
    { id, emailId: `m-${id}`, status: "pending", ...overrides },
  ]);
}

describe("adjudicating a row an apply is still working on", () => {
  it("refuses a row that is not actually stale, so the apply keeps its outcome", async () => {
    // THE FIX for the in-flight window. The ids a surface submits are just ids;
    // before the cutoff moved into the write predicate, a row claimed one
    // second ago could be adjudicated by any client that named it, and the
    // apply's own write-back then matched nothing.
    const id = "op-fresh";
    await seedPending(id);
    const claimed = await claimPendingOperations([id], "token-A", "applying", "cli");
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
    await claimPendingOperations([id], "token-A", "applying", "cli");
    await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

    const resolved = await adjudicateStrandedOperations([id], "notApplied");
    assert.equal(resolved, 1);
    const requeued = await readRow(id);
    assert.equal(requeued.status, "pending");
    assert.equal(requeued.claimToken, "");
    // The attribution goes back with the status. The user has just said this
    // apply never reached Gmail, so the row must not keep recording "cli" as
    // having approved it — a pending row is unclaimed, and unclaimed is "".
    assert.equal(requeued.approvedVia, "");

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
    await claimPendingOperations([id], "token-A", "applying", "cli");
    await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

    assert.equal(await adjudicateStrandedOperations([id], "applied"), 1);
    const row = await readRow(id);
    assert.equal(row.status, "applied");
    assert.equal(row.error, STRANDED_APPLIED_NOTE);
    // The OPPOSITE of the `notApplied` branch, deliberately: the surface that
    // initiated the crashed apply is kept, because on this branch it is the one
    // case where the attribution is genuinely informative. Adjudicating does not
    // make the adjudicator the approver.
    assert.equal(row.approvedVia, "cli");
    // The lease is released, or a later claim-scoped read would match a row it
    // does not own.
    assert.equal(row.claimToken, "");
    // HOW it was decided, as a value rather than a sentence to grep for. "The
    // user says so" is the default because it is what both human surfaces mean.
    assert.equal(row.resolutionEvidence, "user-confirmed");
  });

  it("records a row the API verified with the API's own note and evidence", async () => {
    // The verifier's branch. The two evidence values must produce two
    // DIFFERENT notes as well as two different column values: a human reading
    // the audit trail sees only `error`, and telling them a person confirmed
    // something no person looked at is the failure this column exists to stop.
    const id = "op-verified";
    await seedPending(id);
    await claimPendingOperations([id], "token-A", "applying", "web");
    await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

    assert.equal(
      await adjudicateStrandedOperations([id], "applied", {
        evidence: "verified-api",
      }),
      1,
    );
    const row = await readRow(id);
    assert.equal(row.status, "applied");
    assert.equal(row.resolutionEvidence, "verified-api");
    assert.equal(row.error, STRANDED_VERIFIED_NOTE);
    assert.notEqual(row.error, STRANDED_APPLIED_NOTE);
    // The note must not overclaim: an end-state match is not causation.
    assert.match(row.error, /not proof this app's call produced it/);
    // Claim-time attribution is untouched by resolve-time evidence. The web
    // surface really did initiate the apply that crashed; the API is only what
    // established the outcome.
    assert.equal(row.approvedVia, "web");
  });

  it("clears the evidence on a requeue, whoever gave the answer", async () => {
    // A `pending` row has no resolution, so it can carry no evidence of one —
    // and a pending row showing "verified-api" would read as resolved in every
    // list. Both answers clear it, exactly as `approvedVia` is cleared.
    for (const evidence of ["user-confirmed", "verified-api"] as const) {
      const id = `op-requeue-${evidence}`;
      // Seeded already carrying evidence, so the clear is load-bearing rather
      // than vacuous. Nothing in the product reaches this branch with a
      // non-empty value today — `claimPendingOperations` does not touch the
      // column and an `applied` row is never re-claimed — which is exactly why
      // the invariant needs pinning here instead of being inferred from the
      // reachable states.
      await seedPending(id, { resolutionEvidence: "verified-api" });
      await claimPendingOperations([id], "token-A", "applying", "cli");
      await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

      assert.equal(
        await adjudicateStrandedOperations([id], "notApplied", { evidence }),
        1,
      );
      const row = await readRow(id);
      assert.equal(row.status, "pending", evidence);
      assert.equal(row.resolutionEvidence, "", evidence);
      assert.equal(row.approvedVia, "", evidence);
      assert.equal(row.claimedAt, "", evidence);
      assert.equal(row.resolvedAt, "", evidence);
      assert.equal(row.error, "", evidence);
      assert.equal(row.claimToken, "", evidence);
    }
  });

  it("refuses a row a healthy apply claimed a second ago, verifier or not", async () => {
    // The age clause is the ONLY thing standing between an automatic
    // verification pass and a row an apply is legitimately working on right
    // now. The verifier gets no private write path for exactly this reason: it
    // goes through `adjudicateStrandedOperations`, which recomputes the cutoff
    // at write time and folds it into the same predicate that stamps the token.
    const id = "op-fresh-verified";
    await seedPending(id);
    await claimPendingOperations([id], "token-live", "applying", "web");

    assert.equal(
      await adjudicateStrandedOperations([id], "applied", {
        evidence: "verified-api",
      }),
      0,
    );
    const untouched = await readRow(id);
    assert.equal(untouched.status, "applying");
    assert.equal(untouched.claimToken, "token-live");
    assert.equal(untouched.resolutionEvidence, "");
  });
});

describe("two adjudications racing over one stranded row", () => {
  it("only the call whose write landed reports the row", async () => {
    // THE COUNT CONTRACT. B steals the token between A's post-claim read and
    // A's final write. A's write no-ops. Before this was fixed A still returned
    // the row it had read, so the surface told the user "Recorded 1 change as
    // applied" for a row B had put back in the queue.
    const id = "op-race";
    await seedPending(id);
    await claimPendingOperations([id], "token-A", "applying", "cli");
    await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

    const cutoffIso = new Date(
      Date.now() - STALE_APPLYING_THRESHOLD_MS,
    ).toISOString();

    let bWon = -1;
    const aWon = await resolveStrandedApplyingOperations(
      [id],
      "adjudicate-A",
      cutoffIso,
      {
        status: "applied",
        error: STRANDED_APPLIED_NOTE,
        resolvedAt: new Date().toISOString(),
      },
      {
        afterClaim: async () => {
          const rows = await resolveStrandedApplyingOperations(
            [id],
            "adjudicate-B",
            cutoffIso,
            { status: "pending", error: "", resolvedAt: "", claimedAt: "" },
          );
          bWon = rows.length;
        },
      },
    );

    assert.equal(bWon, 1, "B's write is the one that landed");
    assert.equal(aWon.length, 0, "A must not claim credit for B's decision");

    const row = await readRow(id);
    assert.equal(row.status, "pending", "B's answer is what survives");
    assert.equal(row.claimToken, "");
  });

  it("gives the winner's evidence, not the loser's, when a verifier and a person collide", async () => {
    // THE CROSS-SOURCE RACE. Neither answer is authoritative and there is
    // deliberately no priority ordering: the person may have looked at Gmail a
    // second ago while the verifier's read is minutes old, and neither can
    // establish causation anyway. First token stamp wins, exactly as two people
    // racing already do — and the row must not end up with one source's status
    // and the other's evidence.
    const id = "op-cross-source";
    await seedPending(id);
    await claimPendingOperations([id], "token-A", "applying", "cli");
    await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

    const cutoffIso = new Date(
      Date.now() - STALE_APPLYING_THRESHOLD_MS,
    ).toISOString();

    let verifierWon = -1;
    const userWon = await resolveStrandedApplyingOperations(
      [id],
      "adjudicate-user",
      cutoffIso,
      {
        status: "applied",
        error: STRANDED_APPLIED_NOTE,
        resolvedAt: new Date().toISOString(),
        resolutionEvidence: "user-confirmed",
      },
      {
        afterClaim: async () => {
          const rows = await resolveStrandedApplyingOperations(
            [id],
            "adjudicate-verifier",
            cutoffIso,
            {
              status: "applied",
              error: STRANDED_VERIFIED_NOTE,
              resolvedAt: new Date().toISOString(),
              resolutionEvidence: "verified-api",
            },
          );
          verifierWon = rows.length;
        },
      },
    );

    assert.equal(verifierWon, 1, "the verifier's write is the one that landed");
    assert.equal(userWon.length, 0, "the loser must not claim credit");

    // Read the row back OFF THE TABLE: the returned rows are a snapshot, and
    // what matters is that the surviving status, note and evidence all came
    // from the same writer.
    const row = await readRow(id);
    assert.equal(row.status, "applied");
    assert.equal(row.resolutionEvidence, "verified-api");
    assert.equal(row.error, STRANDED_VERIFIED_NOTE);
  });

  it("reports the row when no one steals it", async () => {
    // The other half of the contract: the count is not simply pessimistic.
    const id = "op-uncontested";
    await seedPending(id);
    await claimPendingOperations([id], "token-A", "applying", "cli");
    await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);

    const cutoffIso = new Date(
      Date.now() - STALE_APPLYING_THRESHOLD_MS,
    ).toISOString();
    const won = await resolveStrandedApplyingOperations(
      [id],
      "adjudicate-solo",
      cutoffIso,
      { status: "pending", error: "", resolvedAt: "", claimedAt: "" },
    );
    assert.equal(won.length, 1);
    assert.equal(won[0]?.id, id);
    assert.equal((await readRow(id)).status, "pending");
  });
});
