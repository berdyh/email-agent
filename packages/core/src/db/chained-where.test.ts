// THE REGRESSION TEST FOR THE CHAINED-`.where()` BUG.
//
// LanceDB's `Query.where()` maps to `onlyIf`, which REPLACES the previous
// predicate instead of ANDing it. `query().where(A).where(B)` therefore matches
// B alone, silently. The fix at every call site is to join the predicates into
// one string with `" AND "`.
//
// WHY IT HAS TO BE A REAL TABLE. The bug is invisible to the type checker —
// both spellings compile — and invisible to a test of the filter BUILDERS,
// which were always correct: `buildEmailFilters` and
// `buildPendingOperationFilters` return the right array either way, and it is
// the *application* of that array that was wrong. The only witness is what a
// two-filter query actually returns from LanceDB, so these run the product's
// own read functions against a real temp-directory database seeded so that the
// difference is observable: for every pair, the rows matching only the LAST
// filter are strictly more than the rows matching BOTH.
//
// A companion structural guard lives in `no-chained-where.test.ts`. Read its
// header before trusting it: it is a text scan and says so.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useTempDb } from "../testing/lancedb-fixture.js";

await useTempDb("chained-where");

const { getEmails, countEmails } = await import("./emails.js");
const { getPendingOperations } = await import("./pending-operations.js");
const { seedEmails, seedPendingOperations } = await import(
  "../testing/lancedb-fixture.js"
);

// The seed is the whole test. Four emails across two accounts and two read
// states, so `{accountId: "a@x", unreadOnly: true}` has an intersection of ONE
// while the trailing filter alone matches TWO.
await seedEmails([
  { id: "m1", accountId: "a@example.com", isUnread: true },
  { id: "m2", accountId: "a@example.com", isUnread: false },
  { id: "m3", accountId: "b@example.com", isUnread: true },
  { id: "m4", accountId: "b@example.com", isUnread: false },
]);

await seedPendingOperations([
  { id: "p1", accountId: "a@example.com", status: "pending", batchId: "b-1" },
  { id: "p2", accountId: "a@example.com", status: "applied", batchId: "b-1", resolvedAt: "2026-08-02T00:00:00.000Z" },
  { id: "p3", accountId: "b@example.com", status: "pending", batchId: "b-2" },
  { id: "p4", accountId: "b@example.com", status: "applied", batchId: "b-2", resolvedAt: "2026-08-02T00:00:00.000Z" },
]);

describe("a two-filter query returns the intersection, not the last filter", () => {
  it("getEmails(accountId + unreadOnly) — chaining would return both unread rows", async () => {
    const rows = await getEmails({
      accountId: "a@example.com",
      unreadOnly: true,
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["m1"],
    );

    // The exact wrong answer the bug produced, spelled out so a future reader
    // can see what "silently dropped" meant: `isUnread = true` alone.
    const lastFilterOnly = await getEmails({ unreadOnly: true });
    assert.deepEqual(
      lastFilterOnly.map((row) => row.id).sort(),
      ["m1", "m3"],
      "precondition: the trailing filter alone must match MORE rows, or this test cannot distinguish the two",
    );
  });

  it("countEmails(accountId + unreadOnly) — the count path takes the same joined predicate", async () => {
    // `countEmails` passes the joined string to `table.countRows(filter)`
    // rather than to a query builder, so it is a separate call site with the
    // same failure mode.
    assert.equal(await countEmails({ accountId: "a@example.com", unreadOnly: true }), 1);
    assert.equal(await countEmails({ unreadOnly: true }), 2);
    assert.equal(await countEmails({ accountId: "a@example.com" }), 2);
    assert.equal(await countEmails(), 4);
  });

  it("getPendingOperations(status + accountId) — the approval queue's own read", async () => {
    const rows = await getPendingOperations({
      status: "pending",
      accountId: "a@example.com",
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["p1"],
    );

    // Filter order matters to the bug and not to the fix: whichever predicate
    // `buildPendingOperationFilters` emits last is the one a chain would keep.
    // Both single-filter reads match more than the pair, so a chain in either
    // direction is visible here.
    assert.equal((await getPendingOperations({ status: "pending" })).length, 2);
    assert.equal(
      (await getPendingOperations({ accountId: "a@example.com" })).length,
      2,
    );
  });

  it("getPendingOperations(status + batchId + accountId) — three filters, one predicate", async () => {
    const rows = await getPendingOperations({
      status: "applied",
      batchId: "b-1",
      accountId: "a@example.com",
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["p2"],
    );
    assert.equal((await getPendingOperations({ batchId: "b-1" })).length, 2);
  });

  it("getActionResults(actionId + accountId) — the third call site the fix touched", async () => {
    const { seedActionResults } = await import("../testing/lancedb-fixture.js");
    const { getActionResults } = await import("./actions.js");

    await seedActionResults([
      { id: "r1", actionId: "junk", accountId: "a@example.com" },
      { id: "r2", actionId: "junk", accountId: "b@example.com" },
      { id: "r3", actionId: "priority", accountId: "a@example.com" },
    ]);

    const rows = await getActionResults({
      actionId: "junk",
      accountId: "a@example.com",
    });
    assert.deepEqual(
      rows.map((row) => row.id),
      ["r1"],
    );
    assert.equal((await getActionResults({ accountId: "a@example.com" })).length, 2);
    assert.equal((await getActionResults({ actionId: "junk" })).length, 2);
  });
});
