import assert from "node:assert/strict";
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
});
