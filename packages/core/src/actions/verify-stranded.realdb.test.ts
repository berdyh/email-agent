// The verification pass driven end to end against a REAL LanceDB in a temp
// directory under a throwaway $HOME. Only the Gmail read is stubbed — the stale
// listing and both adjudication writes are the product's own functions against
// the product's own table.
//
// That is the only way the claims below can be made. What is being tested is
// which rows a predicate matches at the moment it runs, and a fake table would
// model that according to whatever the author already believed.
//
// NOT COVERED, and it must keep being said: a real `users.messages.get` round
// trip. There is no linked Gmail account on this machine (AGENTS.md records the
// same limit for a successful Gmail mutation), so the mapping from a live
// response to a verdict is exercised only through the injected reader.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useTempDb } from "../testing/lancedb-fixture.js";

await useTempDb("verify-stranded");

const {
  claimPendingOperations,
  describeLostClaimedOutcomes,
  getStaleApplyingOperations,
  resolveClaimedOperations,
  STALE_APPLYING_THRESHOLD_MS,
} = await import("../db/pending-operations.js");
const {
  adjudicateStrandedOperations,
  STRANDED_APPLIED_NOTE,
  STRANDED_VERIFIED_NOTE,
} = await import("./approval.js");
const { verifyStrandedApplyingOperations } = await import(
  "./verify-stranded.js"
);
const {
  backdateClaim,
  capturingWarnings,
  readPendingOperation: readRow,
  seedPendingOperations,
} = await import("../testing/lancedb-fixture.js");

/** A row a crash left mid-apply: claimed, past the staleness threshold. */
async function seedStranded(
  id: string,
  overrides: Record<string, string> = {},
): Promise<void> {
  await seedPendingOperations([
    { id, emailId: `msg-${id}`, status: "pending", ...overrides },
  ]);
  await claimPendingOperations([id], `token-${id}`, "applying", "cli");
  await backdateClaim(id, STALE_APPLYING_THRESHOLD_MS + 60_000);
}

/**
 * The REAL stale listing, narrowed to the ids one test owns.
 *
 * All the tests in this file share one table in one process, so a row an
 * earlier case deliberately left stranded is genuinely stale for every later
 * one. Narrowing keeps each case about its own rows while still going through
 * `getStaleApplyingOperations` — the staleness rule itself is not stubbed, so a
 * row that is not actually stale is still absent from what comes back.
 */
function onlyStranded(ids: string[]) {
  return async () =>
    (await getStaleApplyingOperations()).filter((row) => ids.includes(row.id));
}

describe("a verification pass over the real queue", () => {
  it("retires what Gmail confirms and requeues what it contradicts", async () => {
    await seedStranded("v-applied", { type: "markRead" });
    await seedStranded("v-requeued", { type: "markRead" });

    // The ONE case that uses the real default `listStranded` — nothing is
    // injected but the Gmail read, so the wiring of the production deps is
    // exercised rather than assumed. Anything it did not seed reads as a failed
    // check and is left alone.
    const result = await verifyStrandedApplyingOperations({
      readLabels: async (messageId) => {
        if (messageId === "msg-v-applied") {
          return { kind: "labels", labelIds: ["INBOX"] };
        }
        if (messageId === "msg-v-requeued") {
          return { kind: "labels", labelIds: ["INBOX", "UNREAD"] };
        }
        return { kind: "error", message: "not this test's row" };
      },
    });

    assert.ok(result.checked >= 2);
    assert.equal(result.appliedRecorded, 1);
    assert.equal(result.requeuedRecorded, 1);

    const applied = await readRow("v-applied");
    assert.equal(applied.status, "applied");
    // The API's note, not the user's. A human reading the audit trail sees only
    // this field, and telling them a person confirmed something no person
    // looked at is the failure the evidence column exists to prevent.
    assert.equal(applied.error, STRANDED_VERIFIED_NOTE);
    assert.notEqual(applied.error, STRANDED_APPLIED_NOTE);
    assert.equal(applied.resolutionEvidence, "verified-api");
    // Claim-time attribution is untouched: the CLI really did initiate the
    // apply that crashed.
    assert.equal(applied.approvedVia, "cli");
    assert.equal(applied.claimToken, "");

    const requeued = await readRow("v-requeued");
    assert.equal(requeued.status, "pending");
    assert.equal(requeued.error, "");
    assert.equal(requeued.resolvedAt, "");
    assert.equal(requeued.claimedAt, "");
    assert.equal(requeued.claimToken, "");
    assert.equal(requeued.approvedVia, "");
    // A pending row has no resolution, so it carries no evidence of one.
    assert.equal(requeued.resolutionEvidence, "");
  });

  it("leaves a row it could not read EXACTLY as it was", async () => {
    await seedStranded("v-unread-fail", { type: "trash" });

    const result = await verifyStrandedApplyingOperations({
      listStranded: onlyStranded(["v-unread-fail"]),
      readLabels: async () => ({ kind: "notFound" }),
    });

    assert.deepEqual(
      result.unresolved.map((entry) => entry.reason),
      ["message-missing"],
    );
    const row = await readRow("v-unread-fail");
    assert.equal(row.status, "applying", "still stranded, for a human");
    assert.equal(row.claimToken, "token-v-unread-fail");
    assert.equal(row.resolutionEvidence, "");
    // Still visible to every stranded surface, which is the point: a row we
    // could not answer must not become invisible.
    assert.equal(result.checked, 1);
  });

  it("never records an unscoped ADC row as applied against the real table", async () => {
    await seedStranded("v-adc", { type: "markRead", accountId: "" });

    const result = await verifyStrandedApplyingOperations({
      listStranded: onlyStranded(["v-adc"]),
      readLabels: async () => ({ kind: "labels", labelIds: ["INBOX"] }),
    });

    assert.deepEqual(
      result.unresolved.map((entry) => `${entry.id}:${entry.reason}`),
      ["v-adc:unscoped-account"],
    );
    assert.equal(result.appliedRecorded, 0);
    const row = await readRow("v-adc");
    assert.equal(row.status, "applying");
    assert.equal(row.resolutionEvidence, "");
  });

  it("does not touch a row a healthy apply claimed a second ago", async () => {
    // Two guards, both real: the row is not in the stale LIST, and even if it
    // were, `adjudicateStrandedOperations` re-asserts the cutoff inside the
    // same atomic write that stamps the token.
    await seedPendingOperations([
      { id: "v-fresh", emailId: "msg-v-fresh", status: "pending", type: "markRead" },
    ]);
    await claimPendingOperations(["v-fresh"], "token-live", "applying", "web");

    const result = await verifyStrandedApplyingOperations({
      listStranded: onlyStranded(["v-fresh"]),
      readLabels: async () => {
        throw new Error("a fresh claim must never be read back");
      },
    });

    assert.equal(result.checked, 0);
    const row = await readRow("v-fresh");
    assert.equal(row.status, "applying");
    assert.equal(row.claimToken, "token-live");
  });

  it("loses to a person who answered while it was reading Gmail, and says so", async () => {
    // THE CROSS-SOURCE RACE, driven deterministically: the user's adjudication
    // runs from INSIDE the Gmail read, i.e. after the verifier listed the row
    // and before it writes. There is deliberately no priority ordering — the
    // person may have looked at Gmail a second ago while this read is minutes
    // old, and neither establishes causation.
    //
    // What must hold: the verifier's write matches nothing, the count it
    // reports is the write's, not the read's, and the row keeps the answer that
    // actually landed.
    await seedStranded("v-race", { type: "markRead" });

    let userRecorded = -1;
    const result = await verifyStrandedApplyingOperations({
      listStranded: onlyStranded(["v-race"]),
      readLabels: async () => {
        userRecorded = await adjudicateStrandedOperations(
          ["v-race"],
          "applied",
        );
        return { kind: "labels", labelIds: ["INBOX"] };
      },
    });

    assert.equal(userRecorded, 1, "the person's answer is the one that landed");
    assert.deepEqual(result.appliedIds, ["v-race"]);
    assert.equal(
      result.appliedRecorded,
      0,
      "the count must be what the write reached, not what the read saw",
    );

    const row = await readRow("v-race");
    assert.equal(row.status, "applied");
    assert.equal(row.resolutionEvidence, "user-confirmed");
    assert.equal(row.error, STRANDED_APPLIED_NOTE);
  });

  it("still beats an apply hung past the threshold — and the outcome is still lost", async () => {
    // THE WINDOW THAT REMAINS, UNCHANGED BY THIS FEATURE, and it must stay
    // unchanged. An apply hung past STALE_APPLYING_THRESHOLD_MS that then
    // returns from Gmail loses: its write-back is scoped to the token the
    // adjudication overwrote, so it matches nothing, and after a `notApplied`
    // answer the same change can reach Gmail a second time behind an audit
    // trail saying it never happened.
    //
    // What this feature changes is NOT that direction — it is the QUALITY OF
    // THE ANSWER THAT BEATS IT. Here the verifier's read says notApplied, which
    // is what a person guessing could also have said; where the hung apply
    // really succeeded, the read would have said applied instead, so the
    // OUTCOME converges even though the WRITE is still discarded. Do not
    // restate that as the window being closed.
    await seedStranded("v-hung", { type: "markRead" });

    const result = await verifyStrandedApplyingOperations({
      listStranded: onlyStranded(["v-hung"]),
      readLabels: async () => ({ kind: "labels", labelIds: ["INBOX", "UNREAD"] }),
    });
    assert.equal(result.requeuedRecorded, 1);
    assert.equal((await readRow("v-hung")).status, "pending");

    // The hung apply returns and records the truth. Nothing prevents the loss;
    // we only notice it, which is the part that used to be silent.
    const { value, warnings } = await capturingWarnings(() =>
      resolveClaimedOperations(
        [{ id: "v-hung", status: "applied" }],
        "token-v-hung",
        new Date().toISOString(),
      ),
    );
    assert.equal(value.resolved, 0);
    assert.deepEqual(value.lost, [{ id: "v-hung", status: "applied" }]);
    assert.equal((await readRow("v-hung")).status, "pending");
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0], describeLostClaimedOutcomes(value.lost));
    assert.match(String(warnings[0]), /a second time/);
  });
});
