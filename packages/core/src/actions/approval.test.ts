import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  recordToGmailOperation,
  toPendingOperationRecords,
} from "./approval.js";

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
