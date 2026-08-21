// The batched (accountId, id) email lookup — ONE copy now, in core.
//
// This test is the merge of two near-identical files that lived in
// `packages/web/src/modules/api/` and `packages/cli/src/`. Both copies of the
// code drifted wrong at the same time, twice (`limit(refs.length)`, then no
// limit at all), so both copies of the test grew the same regression cases in
// parallel. There is one of each now.
//
// IT DOES NOT USE THE SHARED `useTempHome()` FIXTURE, deliberately, and that is
// the same reason both predecessors did not: the case that matters most —
// two rows for one `(accountId, id)` pair — CANNOT be produced through
// `upsertEmails`, which deletes that pair before appending it. The rows have to
// be written straight into a table, through the module's own `EmailLookupTable`
// seam. Everything here is a real temp-directory LanceDB; nothing is mocked.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { connect } from "@lancedb/lancedb";
import {
  buildEmailLookupFilter,
  emailRefKey,
  getEmailsByIds,
  type EmailLookupTable,
} from "./emails.js";

function emailRow(
  accountId: string,
  id: string,
  subject: string,
  date = "2026-08-07T00:00:00.000Z",
) {
  return {
    id,
    accountId,
    threadId: "t1",
    from: `sender@${accountId}`,
    to: accountId,
    subject,
    date,
    bodyText: "",
    bodyHtml: "",
    labels: "[]",
    isUnread: true,
    senderDomain: "x.com",
    snippet: subject,
  };
}

/** A real LanceDB table over a throwaway directory, handed in through the seam. */
async function withTable<T>(
  rows: ReturnType<typeof emailRow>[],
  body: (open: () => Promise<EmailLookupTable>) => Promise<T>,
): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "email-lookup-test-"));
  try {
    const db = await connect(dir);
    const table = await db.createTable("emails", rows);
    return await body(async () => table as unknown as EmailLookupTable);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

describe("buildEmailLookupFilter", () => {
  it("returns undefined when there is nothing to look up", () => {
    assert.equal(buildEmailLookupFilter([]), undefined);
  });

  it("collapses the whole queue into one predicate per account", () => {
    // `loadOperationDisplays` / `toApprovalOperations` used to run one
    // getEmailById per queued row.
    const filter = buildEmailLookupFilter([
      { accountId: "me@example.com", id: "m1" },
      { accountId: "me@example.com", id: "m2" },
      { accountId: "me@example.com", id: "m1" },
      { accountId: "", id: "m3" },
    ]);

    assert.equal(
      filter,
      "(`accountId` = 'me@example.com' AND id IN ('m1', 'm2')) OR " +
        "(`accountId` = '' AND id IN ('m3'))",
    );
  });

  it("escapes quotes rather than letting them close the literal", () => {
    assert.equal(
      buildEmailLookupFilter([{ accountId: "o'b@x.com", id: "a'b" }]),
      "(`accountId` = 'o''b@x.com' AND id IN ('a''b'))",
    );
  });
});

describe("emailRefKey", () => {
  it("keys results on account + id, since a Gmail id repeats across accounts", () => {
    assert.notEqual(emailRefKey("a@x.com", "m1"), emailRefKey("b@x.com", "m1"));
  });

  it("separates the key halves with a NUL written as an escape, not a literal byte", async () => {
    // A literal NUL in the source makes git classify the file as binary: `git
    // diff` prints `Bin 0 -> N bytes` with no patch, and the file reaches review
    // unread. It shipped that way once, in both surface copies at once.
    const source = await readFile(new URL("./emails.ts", import.meta.url), "utf8");
    assert.equal(
      source.includes("\u0000"),
      false,
      "db/emails.ts must not contain a literal NUL byte",
    );

    assert.deepEqual(emailRefKey("a@x.com", "m1").split("\u0000"), ["a@x.com", "m1"]);
  });
});

describe("getEmailsByIds against a real table", () => {
  it("returns a row for every pair even when the table holds a duplicate", async () => {
    // The bug was `.limit(refs.length)`: it assumed one row per (accountId, id)
    // pair, and nothing enforces that. With two `a@x.com/id1` rows and one
    // `b@x.com/id2` row, a limit of 2 stopped the scan on the duplicates and the
    // Map came back without b@x.com/id2 — which the approval surfaces render as
    // "not in local DB" for an email that is right there.
    await withTable(
      [
        emailRow("a@x.com", "id1", "First copy"),
        emailRow("a@x.com", "id1", "Duplicate copy"),
        emailRow("b@x.com", "id2", "Other account"),
        emailRow("c@x.com", "id1", "Same id, third account"),
      ],
      async (open) => {
        const found = await getEmailsByIds(
          [
            { accountId: "a@x.com", id: "id1" },
            { accountId: "b@x.com", id: "id2" },
          ],
          open,
        );

        assert.equal(found.size, 2);
        assert.equal(found.get(emailRefKey("b@x.com", "id2"))?.subject, "Other account");
        assert.ok(found.has(emailRefKey("a@x.com", "id1")));
        // c@x.com shares the Gmail id but was not asked for: the predicate is
        // grouped per account, so it must not leak into another account's result.
        assert.equal(found.has(emailRefKey("c@x.com", "id1")), false);
      },
    );
  });

  it("picks the NEWEST duplicate by date, not the last row scanned", async () => {
    // The old rule was "last row scanned wins", which is a property of the scan
    // and not of the data: the same table could answer differently on two calls,
    // and the approval surfaces would show a different subject for the same
    // queued change.
    //
    // The dates are deliberately RFC-2822 and deliberately chosen so LEXICAL and
    // CHRONOLOGICAL order disagree — "Fri, 1 Jan 2027" sorts BEFORE "Mon, 2 Feb
    // 2026" as a string. `EmailRecord.date` is the raw `Date:` header off the
    // message, so a string comparison here would be wrong on real data; this
    // case fails against one.
    //
    // The newer row is inserted FIRST, so "last scanned wins" picks the older
    // one. That is the pre-fix failure.
    await withTable(
      [
        emailRow("a@x.com", "id1", "Newest", "Fri, 1 Jan 2027 09:00:00 +0000"),
        emailRow("a@x.com", "id1", "Oldest", "Mon, 2 Feb 2026 09:00:00 +0000"),
      ],
      async (open) => {
        const found = await getEmailsByIds([{ accountId: "a@x.com", id: "id1" }], open);
        assert.equal(found.size, 1);
        assert.equal(found.get(emailRefKey("a@x.com", "id1"))?.subject, "Newest");
      },
    );
  });

  it("picks the same duplicate whichever order the rows are scanned in", async () => {
    // Determinism is the whole point, so the answer must not depend on insertion
    // order. Same two rows, reversed.
    await withTable(
      [
        emailRow("a@x.com", "id1", "Oldest", "Mon, 2 Feb 2026 09:00:00 +0000"),
        emailRow("a@x.com", "id1", "Newest", "Fri, 1 Jan 2027 09:00:00 +0000"),
      ],
      async (open) => {
        const found = await getEmailsByIds([{ accountId: "a@x.com", id: "id1" }], open);
        assert.equal(found.get(emailRefKey("a@x.com", "id1"))?.subject, "Newest");
      },
    );
  });

  it("prefers a parseable date over an unparseable one, in both orders", async () => {
    // A `Date:` header can be missing or malformed — `extractHeader` yields ""
    // when the header is absent. An unparseable value must never outrank a real
    // timestamp just by being scanned later.
    for (const rows of [
      [
        emailRow("a@x.com", "id1", "Real date", "Mon, 2 Feb 2026 09:00:00 +0000"),
        emailRow("a@x.com", "id1", "No date", ""),
      ],
      [
        emailRow("a@x.com", "id1", "No date", ""),
        emailRow("a@x.com", "id1", "Real date", "Mon, 2 Feb 2026 09:00:00 +0000"),
      ],
    ]) {
      await withTable(rows, async (open) => {
        const found = await getEmailsByIds([{ accountId: "a@x.com", id: "id1" }], open);
        assert.equal(found.get(emailRefKey("a@x.com", "id1"))?.subject, "Real date");
      });
    }
  });

  it("still returns one entry per pair when two rows are indistinguishable", async () => {
    // Two rows sharing a pair AND a date have nothing to choose between them, so
    // the winner is arbitrary — but there must still be exactly one entry, and
    // the other requested pair must be untouched. Nothing here promises WHICH of
    // the two tied rows wins; only that the Map is complete.
    await withTable(
      [
        emailRow("a@x.com", "id1", "Tie A", ""),
        emailRow("a@x.com", "id1", "Tie B", ""),
        emailRow("b@x.com", "id2", "Other account"),
      ],
      async (open) => {
        const found = await getEmailsByIds(
          [
            { accountId: "a@x.com", id: "id1" },
            { accountId: "b@x.com", id: "id2" },
          ],
          open,
        );
        assert.equal(found.size, 2);
        assert.equal(found.get(emailRefKey("b@x.com", "id2"))?.subject, "Other account");
        assert.ok(
          ["Tie A", "Tie B"].includes(
            String(found.get(emailRefKey("a@x.com", "id1"))?.subject),
          ),
        );
      },
    );
  });

  it("escapes quotes against a real table rather than only in the filter string", async () => {
    await withTable(
      [
        emailRow("o'brien@x.com", "a'b", "Quoted identity"),
        emailRow("other@x.com", "plain", "Should not match"),
      ],
      async (open) => {
        const found = await getEmailsByIds(
          [
            { accountId: "o'brien@x.com", id: "a'b" },
            // A closing quote plus a tautology: escaped, this matches nothing.
            { accountId: "x", id: "' OR '1'='1" },
          ],
          open,
        );

        assert.equal(found.size, 1);
        assert.equal(
          found.get(emailRefKey("o'brien@x.com", "a'b"))?.subject,
          "Quoted identity",
        );
      },
    );
  });

  it("resolves more than ten emails, which the default query limit silently capped", async () => {
    // LanceDB applies a DEFAULT LIMIT OF 10 to a plain filtered query — not to
    // vector searches only, which is what the comment on this function used to
    // assert without ever checking. A queue referencing 15 emails resolved ten
    // and the surface rendered the other five as "not in local DB", for mail
    // sitting right there. THE COUNT IS THE TEST: at ten or fewer this is
    // invisible.
    const rows = Array.from({ length: 15 }, (_, i) =>
      emailRow("me@x.com", `many-${String(i).padStart(2, "0")}`, `Subject ${String(i)}`),
    );

    await withTable(rows, async (open) => {
      const found = await getEmailsByIds(
        rows.map((row) => ({ accountId: row.accountId, id: row.id })),
        open,
      );

      assert.equal(found.size, 15);
      assert.equal(found.get(emailRefKey("me@x.com", "many-14"))?.subject, "Subject 14");
    });
  });
});
