// THE REGRESSION TEST FOR "the eleventh row did not exist".
//
// `@lancedb/lancedb` 0.15.0 applies a DEFAULT LIMIT OF 10 to a plain filtered
// query, not only to a vector search. A table holding 25 rows answers
// `countRows()` with 25 and `query().where(...).toArray()` with TEN, silently.
//
// Every unbounded scan in this package went through `table.query()` with no
// limit, so the whole product quietly capped at ten: the approval queue listed
// at most 10 changes, `approvals apply` applied 10 of them and reported the
// rest as "not claimed", `getStaleApplyingOperations` could miss stranded rows,
// the mail list returned 10 whatever `limit` the caller asked for, and the
// batched email lookup resolved 10 emails and rendered every other queued row
// as "not in local DB".
//
// It survived 407 green tests because no test had ever put more than a handful
// of rows in a real table — and a comment in `email-lookup.ts` asserted the
// opposite behaviour as fact without ever checking it. THE THRESHOLD IS THE
// POINT of every case below: each one seeds strictly more than 10 rows, because
// at 10 or fewer the bug is invisible.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useTempDb } from "../testing/lancedb-fixture.js";

await useTempDb("query-limit");

const { getDb } = await import("./connection.js");
const { pendingOperationsTable } = await import("./schema.js");
const { UNLIMITED_QUERY_ROWS } = await import("./utils.js");
const {
  countPendingOperations,
  getPendingOperations,
  getPendingOperationsByIds,
  getPendingOperationsForEmails,
  getStaleApplyingOperations,
  claimPendingOperations,
  STALE_APPLYING_THRESHOLD_MS,
} = await import("./pending-operations.js");
const { getEmails, countEmails } = await import("./emails.js");
const { getActionResults } = await import("./actions.js");
const { seedActionResults, seedEmails, seedPendingOperations, backdateClaim } =
  await import("../testing/lancedb-fixture.js");

/** Strictly more than the default of 10, so the truncation is observable. */
const ROWS = 25;
const ids = Array.from({ length: ROWS }, (_, i) => `lim-${String(i).padStart(2, "0")}`);

describe("LanceDB's default query limit, pinned as a fact", () => {
  it("is 10 for a plain filtered scan — not vector searches only", async () => {
    // The fact the fix is built on, asserted directly against the driver so an
    // upgrade that changes it fails HERE, with an explanation, rather than
    // somewhere downstream.
    await seedPendingOperations(
      ids.map((id) => ({ id, status: "pending" as const, emailId: `lim-m-${id}` })),
    );

    const db = await getDb();
    const table = await db.openTable(pendingOperationsTable);
    await table.checkoutLatest();

    assert.equal(await table.countRows(), ROWS);
    assert.equal(
      (await table.query().toArray()).length,
      10,
      "if this is no longer 10, re-read UNLIMITED_QUERY_ROWS before relaxing anything",
    );
    assert.equal(
      (await table.query().where("status = 'pending'").toArray()).length,
      10,
    );
    assert.equal(
      (await table.query().limit(UNLIMITED_QUERY_ROWS).toArray()).length,
      ROWS,
    );
    // `limit(0)` is not "no limit"; it is zero rows. Recorded because it is the
    // obvious thing to reach for.
    assert.equal((await table.query().limit(0).toArray()).length, 0);
  });
});

describe("the approval queue reads past ten rows", () => {
  it("getPendingOperations returns every queued change", async () => {
    const rows = await getPendingOperations({ status: "pending" });
    assert.equal(
      rows.length,
      ROWS,
      "a user with 25 queued Gmail changes must be shown 25, not 10",
    );
    assert.equal(await countPendingOperations("pending"), ROWS);
  });

  it("getPendingOperations honours the caller's own limit on the full set", async () => {
    // The limit is applied in JS AFTER the newest-first sort, so a truncated
    // scan would have returned an arbitrary 3 rather than the newest 3.
    const rows = await getPendingOperations({ status: "pending", limit: 3 });
    assert.equal(rows.length, 3);
  });

  it("getPendingOperationsByIds resolves every id it was given", async () => {
    const rows = await getPendingOperationsByIds(ids);
    assert.deepEqual(rows.map((row) => row.id).sort(), [...ids].sort());
  });

  it("getPendingOperationsForEmails sees every pending row for the dedupe check", async () => {
    const rows = await getPendingOperationsForEmails(
      ids.map((id) => `lim-m-${id}`),
    );
    assert.equal(
      rows.length,
      ROWS,
      "a truncated dedupe lookup re-proposes changes that are already queued",
    );
  });

  it("a claim reads back every row it won, not the first ten", async () => {
    // THE SHARPEST CASE. `claimPendingOperations` stamps a token and reads the
    // rows back to learn what it won; a capped read-back means the apply
    // MUTATES GMAIL for rows it never learned it owned, and their outcome is
    // never written down. A chunk is 10 today, exactly at the boundary.
    const won = await claimPendingOperations(ids, "lim-token", "applying");
    assert.equal(won.length, ROWS);

    // And the stranded lister, which is the only surface those rows appear on.
    await backdateClaim(ids, STALE_APPLYING_THRESHOLD_MS + 60_000);
    const stale = await getStaleApplyingOperations();
    assert.equal(
      stale.length,
      ROWS,
      "a stranded row that is not listed is a Gmail mutation nobody can account for",
    );
  });
});

describe("the other tables read past ten rows", () => {
  it("getEmails returns the whole mailbox, and pages over it correctly", async () => {
    await seedEmails(
      Array.from({ length: ROWS }, (_, i) => ({
        id: `lim-e-${String(i).padStart(2, "0")}`,
        accountId: "me@example.com",
        // Descending dates, so "newest first" has an order to get wrong.
        date: new Date(Date.UTC(2026, 0, ROWS - i)).toISOString(),
      })),
    );

    assert.equal((await getEmails()).length, ROWS);
    assert.equal(await countEmails(), ROWS);

    const firstPage = await getEmails({ limit: 5 });
    assert.equal(firstPage.length, 5);
    assert.equal(firstPage[0]?.id, "lim-e-00", "newest first");

    // The offset walks past the old cap, which is where the truncation used to
    // turn into an empty page rather than a wrong one.
    const lastPage = await getEmails({ limit: 5, offset: 20 });
    assert.equal(lastPage.length, 5);
    assert.equal(lastPage[4]?.id, "lim-e-24");
  });

  it("getActionResults returns the whole history", async () => {
    await seedActionResults(
      Array.from({ length: ROWS }, (_, i) => ({
        id: `lim-r-${String(i).padStart(2, "0")}`,
        actionId: "junk",
      })),
    );
    assert.equal((await getActionResults({ actionId: "junk" })).length, ROWS);
    assert.equal((await getActionResults({ actionId: "junk", limit: 4 })).length, 4);
  });
});
