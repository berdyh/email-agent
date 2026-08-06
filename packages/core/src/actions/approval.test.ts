import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeGmailOperation,
  isDestructiveOperation,
  parseLabelIds,
  recordToGmailOperation,
  toPendingOperationRecords,
} from "./approval.js";

describe("queued operation descriptions", () => {
  it("names each mutation in the words the user approves", () => {
    assert.equal(describeGmailOperation("trash"), "Move to Trash");
    assert.equal(describeGmailOperation("spam"), "Mark as Spam");
    assert.equal(describeGmailOperation("markRead"), "Mark as Read");
    assert.equal(describeGmailOperation("markUnread"), "Mark as Unread");
    assert.equal(
      describeGmailOperation("removeLabels", ["INBOX"]),
      "Archive",
    );
    assert.equal(
      describeGmailOperation("removeLabels", ["INBOX", "Work"]),
      "Remove labels: INBOX, Work",
    );
    assert.equal(
      describeGmailOperation("addLabels", ["Later"]),
      "Add labels: Later",
    );
  });

  it("stays displayable for a row written by another build", () => {
    assert.equal(describeGmailOperation("someFutureType"), "someFutureType");
  });

  it("treats only trash and spam as destructive", () => {
    assert.equal(isDestructiveOperation("trash"), true);
    assert.equal(isDestructiveOperation("spam"), true);
    assert.equal(isDestructiveOperation("removeLabels"), false);
    assert.equal(isDestructiveOperation("markRead"), false);
  });
});

describe("parseLabelIds", () => {
  it("reads a well-formed label array", () => {
    assert.deepEqual(parseLabelIds('["INBOX","Work"]'), ["INBOX", "Work"]);
  });

  it("degrades to no labels rather than throwing on a bad row", () => {
    // One unparsable row must not 500 the approvals list and hide every other
    // queued change from review.
    for (const raw of ["", "not json", "{}", "null", '["INBOX", 7]']) {
      const parsed = parseLabelIds(raw);
      assert.ok(Array.isArray(parsed));
      assert.ok(parsed.every((id) => typeof id === "string"));
    }
    assert.deepEqual(parseLabelIds('["INBOX", 7]'), ["INBOX"]);
  });
});

describe("pending operation records", () => {
  it("maps operations to pending rows with the batch identity", () => {
    const records = toPendingOperationRecords({
      batchId: "batch-1",
      actionId: "junk",
      actionName: "Junk Detector",
      createdAt: "2026-07-31T10:00:00.000Z",
      operations: [
        { emailId: "m1", type: "trash", accountEmail: "me@example.com" },
        { emailId: "m2", type: "removeLabels", labelIds: ["INBOX"] },
      ],
    });

    assert.equal(records.length, 2);
    const [first, second] = records;
    assert.ok(first && second);
    assert.notEqual(first.id, second.id);
    assert.equal(first.batchId, "batch-1");
    assert.equal(first.actionName, "Junk Detector");
    assert.equal(first.accountId, "me@example.com");
    assert.equal(first.status, "pending");
    assert.equal(first.claimToken, "");
    assert.equal(first.labelIds, "[]");
    assert.equal(first.resolvedAt, "");
    assert.equal(first.createdAt, "2026-07-31T10:00:00.000Z");
    // Missing accountEmail collapses to the unscoped/gcloud sentinel.
    assert.equal(second.accountId, "");
    assert.equal(second.labelIds, '["INBOX"]');
  });

  it("round-trips a pending row back to a Gmail operation", () => {
    const [record] = toPendingOperationRecords({
      batchId: "batch-1",
      actionId: "subscription",
      actionName: "Subscriptions",
      operations: [
        {
          emailId: "m1",
          type: "removeLabels",
          labelIds: ["INBOX"],
          accountEmail: "me@example.com",
        },
      ],
    });
    assert.ok(record);

    assert.deepEqual(recordToGmailOperation(record), {
      emailId: "m1",
      type: "removeLabels",
      labelIds: ["INBOX"],
      accountEmail: "me@example.com",
    });
  });

  it("stamps one shared ISO timestamp when no createdAt is given", () => {
    const before = Date.now();
    const records = toPendingOperationRecords({
      batchId: "batch-1",
      actionId: "junk",
      actionName: "Junk Detector",
      operations: [
        { emailId: "m1", type: "trash" },
        { emailId: "m2", type: "spam" },
      ],
    });
    const [first, second] = records;
    assert.ok(first && second);

    // One timestamp for the whole batch, so the approvals list groups and
    // sorts the batch as a single unit.
    assert.equal(first.createdAt, second.createdAt);
    const stamped = new Date(first.createdAt).getTime();
    assert.equal(Number.isNaN(stamped), false);
    assert.ok(stamped >= before && stamped <= Date.now());
  });

  it("produces no rows for an action that proposed no operations", () => {
    assert.deepEqual(
      toPendingOperationRecords({
        batchId: "batch-1",
        actionId: "junk",
        actionName: "Junk Detector",
        operations: [],
      }),
      [],
    );
  });

  it("omits empty label lists when rebuilding operations", () => {
    const [record] = toPendingOperationRecords({
      batchId: "batch-1",
      actionId: "junk",
      actionName: "Junk Detector",
      operations: [{ emailId: "m1", type: "trash", accountEmail: "" }],
    });
    assert.ok(record);

    const operation = recordToGmailOperation(record);
    assert.equal("labelIds" in operation, false);
    // The explicit gcloud sentinel survives the round-trip.
    assert.equal(operation.accountEmail, "");
  });
});
