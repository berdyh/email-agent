import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildClaimFilter,
  buildIdListFilter,
  buildPendingOperationFilters,
  buildPendingResolutionFilter,
  buildInFilter,
  buildPendingEmailFilter,
  buildPruneFilter,
  PRUNABLE_STATUSES,
  selectStaleApplyingOperations,
} from "./pending-operations.js";
import type { PendingOperationRecord } from "./schema.js";

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
    // resolveClaimedOperations updates each failed row on its own so it can
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

function applyingRow(
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
    status: "applying",
    error: "",
    claimToken: "token-1",
    createdAt: "2026-08-01T00:00:00.000Z",
    claimedAt: "2026-08-07T10:00:00.000Z",
    resolvedAt: "",
    ...overrides,
  };
}

describe("stranded `applying` rows", () => {
  const cutoff = "2026-08-07T10:15:00.000Z";

  it("surfaces a row claimed before the cutoff", () => {
    const rows = [applyingRow({ claimedAt: "2026-08-07T09:00:00.000Z" })];
    assert.deepEqual(
      selectStaleApplyingOperations(rows, cutoff).map((r) => r.id),
      ["op-1"],
    );
  });

  it("leaves an in-flight apply alone", () => {
    // A healthy apply is claimed and resolved within a Gmail round trip;
    // reporting it as stranded would ask the user about a change in progress.
    const rows = [applyingRow({ claimedAt: "2026-08-07T10:16:00.000Z" })];
    assert.deepEqual(selectStaleApplyingOperations(rows, cutoff), []);
  });

  it("ages from the claim, not from when the change was proposed", () => {
    // The regression this column exists for: a row queued days ago and claimed
    // one second ago is NOT stranded.
    const rows = [
      applyingRow({
        createdAt: "2026-07-01T00:00:00.000Z",
        claimedAt: "2026-08-07T10:16:00.000Z",
      }),
    ];
    assert.deepEqual(selectStaleApplyingOperations(rows, cutoff), []);
  });

  it("falls back to createdAt for a row migrated in without a claim time", () => {
    const rows = [
      applyingRow({ claimedAt: "", createdAt: "2026-08-01T00:00:00.000Z" }),
    ];
    assert.deepEqual(
      selectStaleApplyingOperations(rows, cutoff).map((r) => r.id),
      ["op-1"],
    );
  });

  it("surfaces a row whose timestamp cannot be read", () => {
    // A row we cannot age is exactly the row a crash left behind — fail toward
    // showing it to the user rather than hiding it forever.
    const rows = [applyingRow({ claimedAt: "not a date" })];
    assert.equal(selectStaleApplyingOperations(rows, cutoff).length, 1);
  });

  it("never reports rows that are not claimed for an apply", () => {
    const rows = [
      applyingRow({ id: "p", status: "pending", claimedAt: "" }),
      applyingRow({ id: "a", status: "applied" }),
      applyingRow({ id: "r", status: "rejected" }),
      applyingRow({ id: "f", status: "failed" }),
    ];
    assert.deepEqual(selectStaleApplyingOperations(rows, cutoff), []);
  });
});

describe("retention prune filter", () => {
  it("only ever targets resolved rows", () => {
    // Pruning a pending row discards a change the user was never asked about;
    // pruning an `applying` row destroys the only evidence that a Gmail
    // mutation may have landed unrecorded. `failed` is kept as a diagnostic.
    assert.deepEqual([...PRUNABLE_STATUSES], ["applied", "rejected"]);
    const filter = buildPruneFilter("2025-08-07T00:00:00.000Z");
    assert.equal(filter.includes("'pending'"), false);
    assert.equal(filter.includes("'applying'"), false);
    assert.equal(filter.includes("'failed'"), false);
  });

  it("compares resolvedAt as a date and excludes the unresolved sentinel", () => {
    // "" sorts before every real ISO timestamp, so without the != '' guard a
    // row that slipped into a prunable status without a resolvedAt would be
    // swept away by any cutoff.
    assert.equal(
      buildPruneFilter("2025-08-07T00:00:00.000Z"),
      "status IN ('applied', 'rejected') AND `resolvedAt` != '' AND `resolvedAt` < '2025-08-07T00:00:00.000Z'",
    );
  });

  it("escapes the cutoff it interpolates", () => {
    assert.ok(buildPruneFilter("a'b").includes("'a''b'"));
  });
});

describe("dedupe lookup filter", () => {
  it("scopes to still-pending rows for the emails in question", () => {
    // camelCase columns need backticks or DataFusion folds them to lowercase
    // and the query fails with "No field named emailid".
    assert.equal(
      buildPendingEmailFilter(["m1", "m2"]),
      "status = 'pending' AND `emailId` IN ('m1', 'm2')",
    );
  });

  it("escapes values and refuses an empty list", () => {
    assert.equal(buildInFilter("`emailId`", ["a'b"]), "`emailId` IN ('a''b')");
    assert.throws(() => buildInFilter("`emailId`", []), /at least one value/);
  });
});
