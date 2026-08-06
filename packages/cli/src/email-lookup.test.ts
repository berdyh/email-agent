import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import { buildEmailLookupFilter, emailRefKey } from "./email-lookup.js";

describe("CLI batched email lookup filter", () => {
  it("returns undefined when there is nothing to look up", () => {
    assert.equal(buildEmailLookupFilter([]), undefined);
  });

  it("collapses the whole queue into one predicate per account", () => {
    // `loadOperationDisplays` used to run one getEmailById per queued row.
    const filter = buildEmailLookupFilter([
      { accountId: "me@example.com", emailId: "m1" },
      { accountId: "me@example.com", emailId: "m2" },
      { accountId: "me@example.com", emailId: "m1" },
      { accountId: "", emailId: "m3" },
    ]);

    assert.equal(
      filter,
      "(`accountId` = 'me@example.com' AND id IN ('m1', 'm2')) OR " +
        "(`accountId` = '' AND id IN ('m3'))",
    );
  });

  it("escapes quotes rather than letting them close the literal", () => {
    assert.equal(
      buildEmailLookupFilter([{ accountId: "o'b@x.com", emailId: "a'b" }]),
      "(`accountId` = 'o''b@x.com' AND id IN ('a''b'))",
    );
  });

  it("keys results on account + id, since a Gmail id repeats across accounts", () => {
    assert.notEqual(emailRefKey("a@x.com", "m1"), emailRefKey("b@x.com", "m1"));
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
