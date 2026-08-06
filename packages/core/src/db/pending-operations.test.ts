import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildClaimFilter,
  buildIdListFilter,
  buildPendingOperationFilters,
  buildPendingResolutionFilter,
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

  it("builds a single-id filter for a row-by-row resolution", () => {
    // resolvePendingOperations updates each failed row on its own so it can
    // carry that row's error message.
    assert.equal(buildIdListFilter(["op-1"]), "id IN ('op-1')");
  });

  it("keeps a pending status filter separate from an unscoped account", () => {
    // "" is the gcloud/unscoped sentinel, not "no account filter" — the two
    // must not collapse, or an unscoped queue row would match every account.
    assert.deepEqual(
      buildPendingOperationFilters({ status: "pending", accountId: "" }),
      ["status = 'pending'", "`accountId` = ''"],
    );
    assert.deepEqual(buildPendingOperationFilters({ status: "pending" }), [
      "status = 'pending'",
    ]);
  });

  it("scopes a batch filter without a status", () => {
    assert.deepEqual(buildPendingOperationFilters({ batchId: "batch-1" }), [
      "`batchId` = 'batch-1'",
    ]);
  });

  it("refuses to build an id filter with no ids", () => {
    // `id IN ()` is a DataFusion parse error, so this must fail loudly at the
    // call site rather than reaching LanceDB.
    assert.throws(() => buildIdListFilter([]), /at least one id/);
  });

  it("scopes a claim to one attempt and one status", () => {
    // Resolution is only ever allowed against rows this attempt won, so a
    // concurrent apply and reject cannot overwrite each other's decision.
    assert.equal(
      buildClaimFilter("token-1", "applying"),
      "`claimToken` = 'token-1' AND status = 'applying'",
    );
    assert.equal(
      buildClaimFilter("quote'token", "rejected"),
      "`claimToken` = 'quote''token' AND status = 'rejected'",
    );
  });

  it("only resolves rows that are still pending", () => {
    // Without the status guard, a second resolver could flip a row the user
    // just rejected back to applied.
    assert.equal(
      buildPendingResolutionFilter(["op-1"]),
      "id IN ('op-1') AND status = 'pending'",
    );
  });
});
