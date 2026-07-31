import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PendingOperationRecord } from "@email-agent/core";
import { describeOperation } from "./approvals.js";

function record(
  overrides: Partial<PendingOperationRecord> = {},
): PendingOperationRecord {
  return {
    id: "op-1",
    batchId: "batch-1",
    actionId: "junk",
    actionName: "Junk Detector",
    accountId: "me@example.com",
    emailId: "m1",
    type: "trash",
    labelIds: "[]",
    status: "pending",
    error: "",
    createdAt: "2026-07-31T10:00:00.000Z",
    resolvedAt: "",
    ...overrides,
  };
}

describe("approval operation descriptions", () => {
  it("names each simple Gmail mutation in the user's terms", () => {
    assert.equal(describeOperation(record({ type: "trash" })), "Move to Trash");
    assert.equal(describeOperation(record({ type: "spam" })), "Mark as Spam");
    assert.equal(
      describeOperation(record({ type: "markRead" })),
      "Mark as Read",
    );
    assert.equal(
      describeOperation(record({ type: "markUnread" })),
      "Mark as Unread",
    );
  });

  it("renders a lone INBOX removal as an archive", () => {
    assert.equal(
      describeOperation(
        record({ type: "removeLabels", labelIds: '["INBOX"]' }),
      ),
      "Archive",
    );
  });

  it("lists the labels for any other label mutation", () => {
    // More than one label is a label edit, not an archive, even when INBOX is
    // among them — the user must see everything that is being removed.
    assert.equal(
      describeOperation(
        record({ type: "removeLabels", labelIds: '["INBOX","Promotions"]' }),
      ),
      "Remove labels: INBOX, Promotions",
    );
    assert.equal(
      describeOperation(
        record({ type: "removeLabels", labelIds: '["Promotions"]' }),
      ),
      "Remove labels: Promotions",
    );
    assert.equal(
      describeOperation(record({ type: "addLabels", labelIds: '["Later"]' })),
      "Add labels: Later",
    );
  });

  it("falls back to the raw type for an unrecognized operation", () => {
    // A queued row written by an older/newer build must still be displayable
    // rather than crashing the approvals list.
    assert.equal(describeOperation(record({ type: "warpDrive" })), "warpDrive");
  });
});
