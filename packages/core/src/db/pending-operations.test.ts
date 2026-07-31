import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIdListFilter,
  buildPendingOperationFilters,
} from "./pending-operations.js";

describe("pending operation DB filters", () => {
  it("builds backtick-quoted filters for camelCase columns", () => {
    assert.deepEqual(
      buildPendingOperationFilters({
        status: "pending",
        batchId: "batch-1",
        accountId: "me@example.com",
      }),
      [
        "status = 'pending'",
        "`batchId` = 'batch-1'",
        "`accountId` = 'me@example.com'",
      ],
    );
  });

  it("keeps an explicit empty account id scoped", () => {
    assert.deepEqual(buildPendingOperationFilters({ accountId: "" }), [
      "`accountId` = ''",
    ]);
  });

  it("returns no filters when no options are given", () => {
    assert.deepEqual(buildPendingOperationFilters(), []);
  });

  it("escapes quotes in id list filters", () => {
    assert.equal(
      buildIdListFilter(["op-1", "quote'id"]),
      "id IN ('op-1', 'quote''id')",
    );
  });
});
