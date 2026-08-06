import assert from "node:assert/strict";
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
});
