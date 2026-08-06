import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { buildEmailLookupFilter, emailRefKey } from "./email-lookup.js";

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
});
