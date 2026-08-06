import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PendingOperationRecord } from "@email-agent/core";
import {
  commitReviewDecisions,
  describeOperation,
  describeReviewCommit,
} from "./approvals.js";

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
    claimToken: "",
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

describe("committing review decisions", () => {
  function tracker() {
    const order: string[] = [];
    return {
      order,
      applyIds: async (ids: string[]) => {
        order.push(`apply:${ids.join(",")}`);
      },
      rejectIds: async (ids: string[]) => {
        order.push(`reject:${ids.join(",")}`);
      },
    };
  }

  it("records rejections before it touches Gmail", async () => {
    const handlers = tracker();
    await commitReviewDecisions({ approved: ["a"], rejected: ["b"] }, handlers);
    assert.deepEqual(handlers.order, ["reject:b", "apply:a"]);
  });

  it("keeps the user's rejections when the apply throws mid-batch", async () => {
    const order: string[] = [];
    const commit = await commitReviewDecisions(
      { approved: ["a", "b"], rejected: ["c"] },
      {
        rejectIds: async (ids) => {
          order.push(`reject:${ids.join(",")}`);
        },
        applyIds: async () => {
          throw new Error("network down");
        },
      },
    );

    // The rejection ran, and it ran first — the regression this covers is the
    // old order, where the throw happened before any "no" was written.
    assert.deepEqual(order, ["reject:c"]);
    assert.equal(commit.rejectError, undefined);
    assert.equal((commit.applyError as Error).message, "network down");
  });

  it("still applies approvals when recording rejections fails", async () => {
    const order: string[] = [];
    const commit = await commitReviewDecisions(
      { approved: ["a"], rejected: ["b"] },
      {
        rejectIds: async () => {
          throw new Error("db locked");
        },
        applyIds: async (ids) => {
          order.push(`apply:${ids.join(",")}`);
        },
      },
    );

    assert.deepEqual(order, ["apply:a"]);
    assert.equal((commit.rejectError as Error).message, "db locked");
    assert.equal(commit.applyError, undefined);
  });

  it("says nothing at all when both halves succeed", async () => {
    const commit = await commitReviewDecisions(
      { approved: ["a"], rejected: ["b"] },
      tracker(),
    );
    assert.deepEqual(describeReviewCommit(commit), []);
  });

  it("tells the user their rejections survived an apply failure", () => {
    const lines = describeReviewCommit({
      approvedIds: ["a", "b"],
      rejectedIds: ["c"],
      applyError: new Error("network down"),
    });

    const text = lines.join("\n");
    assert.match(text, /Failed to apply 2 approved changes: network down/);
    assert.match(text, /Your 1 rejection was already recorded/);
    // Honest about the half-applied case rather than claiming nothing happened.
    assert.match(text, /may have reached Gmail before the failure/);
  });

  it("does not claim rejections were recorded when the reject itself failed", () => {
    const text = describeReviewCommit({
      approvedIds: ["a"],
      rejectedIds: ["c"],
      rejectError: new Error("db locked"),
      applyError: new Error("network down"),
    }).join("\n");

    assert.match(text, /Failed to record 1 rejection: db locked/);
    assert.match(text, /still pending/);
    assert.equal(text.includes("already recorded"), false);
  });
});
