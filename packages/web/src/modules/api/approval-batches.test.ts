// The batch grouping that used to be a `useMemo` inside `ApprovalPanel`, where
// no test could reach it — there is no React testing library in this repo.
//
// What it holds is ORDER. The route returns rows already sorted newest-batch-
// first with a total order inside one millisecond, and the panel renders them
// in whatever order this hands back, with a header per batch. Re-sorting or
// re-keying here discards the server's ordering silently: the same queue
// renders differently between two loads, and a batch header can repeat.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { groupOperationsByBatch } from "./approvals-contract.js";
import type { ApprovalOperation } from "./approvals-contract.js";

function op(overrides: Partial<ApprovalOperation>): ApprovalOperation {
  return {
    id: "op-1",
    batchId: "batch-1",
    actionId: "junk",
    actionName: "Junk Detector",
    accountId: "me@example.com",
    emailId: "m-1",
    type: "trash",
    labelIds: [],
    label: "Move to Trash",
    destructive: true,
    createdAt: "2026-08-01T00:00:00.000Z",
    email: null,
    ...overrides,
  };
}

describe("groupOperationsByBatch", () => {
  it("returns nothing for an empty queue", () => {
    assert.deepEqual(groupOperationsByBatch([]), []);
  });

  it("groups a run's changes under one header", () => {
    const batches = groupOperationsByBatch([
      op({ id: "a", batchId: "b1" }),
      op({ id: "b", batchId: "b1" }),
      op({ id: "c", batchId: "b1" }),
    ]);
    assert.equal(batches.length, 1);
    assert.equal(batches[0]?.batchId, "b1");
    assert.equal(batches[0]?.actionName, "Junk Detector");
    assert.deepEqual(
      batches[0]?.operations.map((entry) => entry.id),
      ["a", "b", "c"],
    );
  });

  it("keeps the server's batch order, whatever the ids look like", () => {
    // Numeric-looking ids are the case an object literal or a key sort gets
    // wrong: `{9: …, 10: …}` enumerates 9 before 10 regardless of insertion,
    // and sorting reorders them again. The queue's real order is the one the
    // route computed from createdAt.
    const batches = groupOperationsByBatch([
      op({ id: "x", batchId: "10" }),
      op({ id: "y", batchId: "9" }),
      op({ id: "z", batchId: "2" }),
    ]);
    assert.deepEqual(
      batches.map((batch) => batch.batchId),
      ["10", "9", "2"],
    );
  });

  it("puts a batch's later rows back with its first, without moving the batch", () => {
    // Interleaved input. The panel prints one header per batch, so a grouping
    // that emitted b1, b2, b1 would repeat a header — the exact display bug the
    // total order in `getPendingOperations` was added to prevent.
    const batches = groupOperationsByBatch([
      op({ id: "1", batchId: "b1" }),
      op({ id: "2", batchId: "b2" }),
      op({ id: "3", batchId: "b1" }),
      op({ id: "4", batchId: "b2" }),
    ]);
    assert.deepEqual(
      batches.map((batch) => batch.batchId),
      ["b1", "b2"],
    );
    assert.deepEqual(batches[0]?.operations.map((entry) => entry.id), ["1", "3"]);
    assert.deepEqual(batches[1]?.operations.map((entry) => entry.id), ["2", "4"]);
  });

  it("takes the header from the batch's first row", () => {
    const batches = groupOperationsByBatch([
      op({ id: "1", batchId: "b1", actionName: "Junk", createdAt: "2026-08-01T00:00:00.000Z" }),
      op({ id: "2", batchId: "b1", actionName: "Junk", createdAt: "2026-08-01T00:00:00.000Z" }),
    ]);
    assert.equal(batches[0]?.actionName, "Junk");
    assert.equal(batches[0]?.createdAt, "2026-08-01T00:00:00.000Z");
  });

  it("does not mutate the array it was given", () => {
    const input = [op({ id: "1", batchId: "b1" }), op({ id: "2", batchId: "b2" })];
    const snapshot = input.map((entry) => entry.id);
    groupOperationsByBatch(input);
    assert.deepEqual(
      input.map((entry) => entry.id),
      snapshot,
      "the panel keeps the operations array in state; reordering it in place " +
        "would change what a later render sees",
    );
  });
});
