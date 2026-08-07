import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { connect } from "@lancedb/lancedb";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildEmailLookupFilter,
  emailRefKey,
  getEmailsByRefs,
  type EmailLookupTable,
} from "./email-lookup.js";

function emailRow(accountId: string, id: string, subject: string) {
  return {
    id,
    accountId,
    threadId: "t1",
    from: `sender@${accountId}`,
    to: accountId,
    subject,
    date: "2026-08-07T00:00:00.000Z",
    bodyText: "",
    bodyHtml: "",
    labels: "[]",
    isUnread: true,
    senderDomain: "x.com",
    snippet: subject,
  };
}

describe("batched email lookup filter", () => {
  it("returns undefined when there is nothing to look up", () => {
    assert.equal(buildEmailLookupFilter([]), undefined);
  });

  it("groups ids per account into one IN list", () => {
    const filter = buildEmailLookupFilter([
      { accountId: "a@example.com", emailId: "1" },
      { accountId: "a@example.com", emailId: "2" },
      // Duplicate pair must not widen the IN list.
      { accountId: "a@example.com", emailId: "1" },
      { accountId: "b@example.com", emailId: "3" },
    ]);

    assert.equal(
      filter,
      "(`accountId` = 'a@example.com' AND id IN ('1', '2')) OR " +
        "(`accountId` = 'b@example.com' AND id IN ('3'))",
    );
  });

  it("backticks accountId so DataFusion does not fold it to lowercase", () => {
    const filter = buildEmailLookupFilter([{ accountId: "", emailId: "x" }]);
    // The empty accountId is the gcloud/ADC sentinel and is a legitimate value.
    assert.equal(filter, "(`accountId` = '' AND id IN ('x'))");
  });

  it("escapes single quotes in both halves of the identity", () => {
    const filter = buildEmailLookupFilter([
      { accountId: "o'brien@example.com", emailId: "a'b" },
    ]);
    assert.equal(filter, "(`accountId` = 'o''brien@example.com' AND id IN ('a''b'))");
    assert.equal(filter?.includes("' OR '1'='1"), false);
  });

  it("keys the result map on the full identity, not the email id alone", () => {
    // The same Gmail id can exist under two accounts.
    assert.notEqual(emailRefKey("a@example.com", "1"), emailRefKey("b@example.com", "1"));
  });

  it("separates the key halves with a NUL written as an escape, not a literal byte", async () => {
    // A literal NUL in the source makes git classify the file as binary: `git
    // diff` prints `Bin 0 -> N bytes` with no patch, and the file reaches review
    // unread. It shipped that way once; this pins the escape form.
    const source = await readFile(new URL("./email-lookup.ts", import.meta.url), "utf8");
    assert.equal(source.includes("\u0000"), false, "source must not contain a literal NUL byte");

    const key = emailRefKey("a@x.com", "m1");
    assert.deepEqual(key.split("\u0000"), ["a@x.com", "m1"]);
  });

  it("returns a row for every pair even when the table holds a duplicate", async () => {
    // A REAL LanceDB table, not a predicate string. The bug was `.limit(refs.length)`:
    // it assumed one row per (accountId, id) pair, and nothing enforces that. With
    // two `a@x.com/id1` rows and one `b@x.com/id2` row, a limit of 2 stopped the
    // scan on the duplicates and the Map came back without b@x.com/id2 — which the
    // approval surfaces render as "not in local DB" for an email that is right there.
    const dir = await mkdtemp(join(tmpdir(), "email-lookup-test-"));
    try {
      const db = await connect(dir);
      const table = await db.createTable("emails", [
        emailRow("a@x.com", "id1", "First copy"),
        emailRow("a@x.com", "id1", "Duplicate copy"),
        emailRow("b@x.com", "id2", "Other account"),
        emailRow("c@x.com", "id1", "Same id, third account"),
      ]);

      const found = await getEmailsByRefs(
        [
          { accountId: "a@x.com", emailId: "id1" },
          { accountId: "b@x.com", emailId: "id2" },
        ],
        async () => table as unknown as EmailLookupTable,
      );

      assert.equal(found.size, 2);
      assert.equal(found.get(emailRefKey("b@x.com", "id2"))?.subject, "Other account");
      assert.ok(found.has(emailRefKey("a@x.com", "id1")));
      // c@x.com shares the Gmail id but was not asked for: the predicate is scoped
      // per account, so it must not leak into another account's result.
      assert.equal(found.has(emailRefKey("c@x.com", "id1")), false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("escapes quotes against a real table rather than only in the filter string", async () => {
    const dir = await mkdtemp(join(tmpdir(), "email-lookup-test-"));
    try {
      const db = await connect(dir);
      const table = await db.createTable("emails", [
        emailRow("o'brien@x.com", "a'b", "Quoted identity"),
        emailRow("other@x.com", "plain", "Should not match"),
      ]);

      const found = await getEmailsByRefs(
        [
          { accountId: "o'brien@x.com", emailId: "a'b" },
          // A closing quote plus a tautology: escaped, this matches nothing.
          { accountId: "x", emailId: "' OR '1'='1" },
        ],
        async () => table as unknown as EmailLookupTable,
      );

      assert.equal(found.size, 1);
      assert.equal(found.get(emailRefKey("o'brien@x.com", "a'b"))?.subject, "Quoted identity");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
