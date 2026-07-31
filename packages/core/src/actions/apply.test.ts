import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildOperationAccountLookup,
  mapResultToOperations,
  scopeOperationsToAccounts,
} from "./apply.js";

describe("junk action operation mapping", () => {
  it("maps a spam recommendation to a spam operation", () => {
    assert.deepEqual(
      mapResultToOperations("junk", [
        { emailId: "m1", recommendation: "spam" },
      ]),
      [{ emailId: "m1", type: "spam" }],
    );
  });

  it("maps delete and archive recommendations", () => {
    assert.deepEqual(
      mapResultToOperations("junk", [
        { emailId: "m1", recommendation: "delete" },
        { emailId: "m2", recommendation: "archive" },
        { emailId: "m3", recommendation: "keep" },
      ]),
      [
        { emailId: "m1", type: "trash" },
        { emailId: "m2", type: "removeLabels", labelIds: ["INBOX"] },
      ],
    );
  });
});

describe("Gmail operation account scoping", () => {
  it("builds account lookup by message id and marks duplicate ids ambiguous", () => {
    const lookup = buildOperationAccountLookup([
      { id: "m1", accountId: "me@example.com" },
      { id: "m2", accountId: "" },
      { id: "m1", accountId: "work@example.com" },
    ]);

    assert.equal(lookup.get("m1"), null);
    assert.equal(lookup.get("m2"), "");
  });

  it("attaches derived operation account identity", () => {
    assert.deepEqual(
      scopeOperationsToAccounts(
        [{ emailId: "m1", type: "trash" }],
        undefined,
        new Map([["m1", "me@example.com"]]),
      ),
      [{ emailId: "m1", type: "trash", accountEmail: "me@example.com" }],
    );
  });

  it("preserves explicit gcloud sentinel account identity", () => {
    assert.deepEqual(
      scopeOperationsToAccounts([{ emailId: "m1", type: "spam" }], ""),
      [{ emailId: "m1", type: "spam", accountEmail: "" }],
    );
  });

  it("validates lookup membership before applying an explicit batch account", () => {
    assert.deepEqual(
      scopeOperationsToAccounts(
        [{ emailId: "m1", type: "spam" }],
        "me@example.com",
        new Map([["m1", "me@example.com"]]),
      ),
      [{ emailId: "m1", type: "spam", accountEmail: "me@example.com" }],
    );
    assert.throws(
      () =>
        scopeOperationsToAccounts(
          [{ emailId: "missing", type: "trash" }],
          "me@example.com",
          new Map([["m1", "me@example.com"]]),
        ),
      /not in the action batch/,
    );
  });

  it("rejects ambiguous message ids only when an operation targets one", () => {
    assert.throws(
      () =>
        scopeOperationsToAccounts(
          [{ emailId: "m1", type: "trash" }],
          undefined,
          new Map([["m1", null]]),
        ),
      /multiple accounts/,
    );
  });

  it("rejects unknown message ids when a lookup-backed action run produced operations", () => {
    assert.throws(
      () =>
        scopeOperationsToAccounts(
          [{ emailId: "missing", type: "trash" }],
          undefined,
          new Map([["m1", "me@example.com"]]),
        ),
      /not in the action batch/,
    );
  });
});
