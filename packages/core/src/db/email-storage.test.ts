// THE REGRESSION TEST FOR "email-agent fetch could not store a single email".
//
// `upsertEmails` is the only write path for fetched mail (`gmail/sync.ts`), and
// against a table created by the current `initDb()` its `mergeInsert` form threw
// on EVERY call. Two independent reasons, both reproduced here by running the
// real function against a real temp-directory LanceDB:
//
//   * `mergeInsert` compares the incoming batch's Arrow schema field by field.
//     `createEmptyTable(name, schema)` builds non-nullable columns (apache-arrow
//     `Field` defaults to `nullable = false`); LanceDB infers `nullable = true`
//     from plain JS objects. Result: `Append with different schema: 'id' should
//     have nullable=false but nullable=true`, once per column. `table.add()`
//     coerces, which is why every other writer in this package worked.
//   * the join key `accountId` is composed into `target_accountId` and parsed as
//     an unquoted SQL identifier, which DataFusion folds to lowercase:
//     `No field named target_accountid`.
//
// Nothing caught it because no test had ever written an email row to a real
// table — the suite covered `buildEmailRecords` (pure) and the filter builders
// (pure), and both were correct. The bug lived entirely in the LanceDB call.
//
// These tests therefore assert the BEHAVIOUR, not the implementation: a row can
// be stored, re-storing it replaces rather than duplicates, and the identity
// that decides "same row" is (accountId, id) — never id alone.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useTempDb } from "../testing/lancedb-fixture.js";

await useTempDb("email-storage");

const { getEmails, getEmailById, countEmails, buildEmailReplacementFilter } =
  await import("./emails.js");
const { seedEmails } = await import("../testing/lancedb-fixture.js");

describe("storing fetched mail", () => {
  it("writes a row at all — the failure that broke `fetch` outright", async () => {
    await seedEmails([{ id: "store-1", accountId: "a@example.com", subject: "hello" }]);

    const stored = await getEmailById("store-1", "a@example.com");
    assert.ok(stored, "upsertEmails wrote nothing");
    assert.equal(stored.subject, "hello");
    assert.equal(stored.accountId, "a@example.com");
    // The embedding is the expensive part of a fetch; a store that dropped it
    // would cost a paid API call to rebuild.
    assert.equal(stored.vector.length, 768);
  });

  it("replaces a row on re-fetch instead of duplicating it", async () => {
    await seedEmails([
      { id: "store-2", accountId: "a@example.com", subject: "first", isUnread: true },
    ]);
    await seedEmails([
      { id: "store-2", accountId: "a@example.com", subject: "second", isUnread: false },
    ]);

    const rows = (await getEmails({ accountId: "a@example.com" })).filter(
      (row) => row.id === "store-2",
    );
    assert.equal(rows.length, 1, "a re-fetch must not leave two rows for one message");
    assert.equal(rows[0]?.subject, "second");
    assert.equal(rows[0]?.isUnread, false);
  });

  it("keeps the same Gmail id in two accounts as two rows", async () => {
    // Gmail message ids are per-mailbox, so the same id in two accounts is two
    // different messages. This is why the identity is the (accountId, id) PAIR
    // and why a single lowercase merge key would have been the wrong repair.
    await seedEmails([
      { id: "shared-id", accountId: "a@example.com", subject: "for a" },
      { id: "shared-id", accountId: "b@example.com", subject: "for b" },
    ]);

    assert.equal((await getEmailById("shared-id", "a@example.com"))?.subject, "for a");
    assert.equal((await getEmailById("shared-id", "b@example.com"))?.subject, "for b");

    // Re-storing one account's copy must leave the other account's alone.
    await seedEmails([
      { id: "shared-id", accountId: "a@example.com", subject: "for a, again" },
    ]);
    assert.equal(
      (await getEmailById("shared-id", "a@example.com"))?.subject,
      "for a, again",
    );
    assert.equal((await getEmailById("shared-id", "b@example.com"))?.subject, "for b");
    assert.equal(await countEmails({ accountId: "b@example.com" }), 1);
  });

  it("never deletes an (account, id) pair the batch did not name", async () => {
    // A batch spanning two accounts is where a cross-product replacement filter
    // — `accountId IN (a, b) AND id IN (p, q)` — destroys mail: it matches the
    // pairs (a, q) and (b, p) that nobody asked about. `fetch --scope all` over
    // two accounts produces exactly this shape.
    await seedEmails([
      { id: "pair-p", accountId: "x@example.com", subject: "keep me" },
      { id: "pair-q", accountId: "y@example.com", subject: "keep me too" },
    ]);
    await seedEmails([
      { id: "pair-q", accountId: "x@example.com", subject: "new" },
      { id: "pair-p", accountId: "y@example.com", subject: "new" },
    ]);

    assert.equal((await getEmailById("pair-p", "x@example.com"))?.subject, "keep me");
    assert.equal((await getEmailById("pair-q", "y@example.com"))?.subject, "keep me too");
    assert.equal((await getEmailById("pair-q", "x@example.com"))?.subject, "new");
    assert.equal((await getEmailById("pair-p", "y@example.com"))?.subject, "new");
  });

  it("leaves rows the batch does not mention untouched", async () => {
    const before = await countEmails();
    await seedEmails([{ id: "store-3", accountId: "c@example.com" }]);
    assert.equal(await countEmails(), before + 1);

    await seedEmails([{ id: "store-3", accountId: "c@example.com", subject: "again" }]);
    assert.equal(
      await countEmails(),
      before + 1,
      "a re-store must delete exactly the rows it re-adds and nothing else",
    );
  });
});

describe("buildEmailReplacementFilter", () => {
  it("groups by account rather than emitting a cross product", () => {
    // `accountId IN (a, b) AND id IN (1, 2)` would match (a,2) and (b,1) —
    // rows the batch never mentions — and delete another account's mail.
    const filter = buildEmailReplacementFilter([
      { accountId: "a@example.com", id: "1" },
      { accountId: "b@example.com", id: "2" },
    ]);
    assert.equal(
      filter,
      "(`accountId` = 'a@example.com' AND id IN ('1')) OR " +
        "(`accountId` = 'b@example.com' AND id IN ('2'))",
    );
  });

  it("backticks accountId and collapses repeats", () => {
    const filter = buildEmailReplacementFilter([
      { accountId: "a@example.com", id: "1" },
      { accountId: "a@example.com", id: "2" },
      { accountId: "a@example.com", id: "1" },
    ]);
    assert.equal(filter, "(`accountId` = 'a@example.com' AND id IN ('1', '2'))");
  });

  it("escapes quotes in both positions", () => {
    const filter = buildEmailReplacementFilter([
      { accountId: "o'brien@example.com", id: "a'b" },
    ]);
    assert.equal(filter, "(`accountId` = 'o''brien@example.com' AND id IN ('a''b'))");
  });
});
