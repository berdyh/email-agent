// The queue helpers whose behaviour is a property of LANCEDB, not of the pure
// predicate they build.
//
// `pending-operations.test.ts` covers the builders — `buildPruneFilter`,
// `buildPendingEmailFilter`, the dedupe key, the age rule — and those were
// never in doubt. What no test touched is whether the predicates they emit
// actually select the rows they are meant to when handed to
// `table.delete()` / `table.query()`: the backticked camelCase columns, the
// lexicographic-is-chronological ISO comparison, the `!= ''` guard, and the
// claim/resolve state machine as it appears ON DISK between chunks.
//
// Everything here runs against a real temp-directory LanceDB under a throwaway
// $HOME (see `testing/lancedb-fixture.ts`). Nothing is mocked except the Gmail
// call itself, which is injected through the seam `applyClaimedOperationsInChunks`
// already exposes — the claim and the resolve are the real ones.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useTempDb } from "../testing/lancedb-fixture.js";

await useTempDb("queue-helpers");

const {
  buildPruneFilter,
  countPendingOperations,
  getPendingOperations,
  getPendingOperationsForEmails,
  prunePendingOperations,
  claimPendingOperations,
  resolveClaimedOperations,
} = await import("./pending-operations.js");
const { applyClaimedOperationsInChunks } = await import(
  "../actions/approval.js"
);
const {
  readAllPendingOperations,
  readPendingOperation,
  seedPendingOperations,
} = await import("../testing/lancedb-fixture.js");

import type { PendingOperationRecord } from "./schema.js";
import type { ActionApplyResult, GmailOperation } from "../actions/types.js";

const CUTOFF = "2026-06-01T00:00:00.000Z";
const OLD = "2026-01-01T00:00:00.000Z";
const NEW = "2026-12-01T00:00:00.000Z";

// ---------------------------------------------------------------------------
// prune — the only deletion path in the whole product
// ---------------------------------------------------------------------------

describe("prunePendingOperations against a real table", () => {
  it("deletes exactly the rows buildPruneFilter selects, and nothing adjacent", async () => {
    // Every status, on both sides of the cutoff. The two that must survive
    // despite being old are the ones the filter's extra clauses exist for:
    // `failed` (excluded by status) and an unresolved row that somehow carries
    // a prunable status (excluded by `resolvedAt != ''`).
    const seeded = await seedPendingOperations([
      { id: "pr-applied-old", status: "applied", resolvedAt: OLD },
      { id: "pr-rejected-old", status: "rejected", resolvedAt: OLD },
      { id: "pr-applied-new", status: "applied", resolvedAt: NEW },
      { id: "pr-failed-old", status: "failed", resolvedAt: OLD, error: "gmail said no" },
      { id: "pr-pending", status: "pending", resolvedAt: "" },
      { id: "pr-applying", status: "applying", resolvedAt: "", claimToken: "tok" },
      { id: "pr-applied-unresolved", status: "applied", resolvedAt: "" },
    ]);
    assert.equal(seeded.length, 7);

    const removed = await prunePendingOperations(CUTOFF);
    assert.equal(removed, 2, "the advisory count is the pre-delete count");

    assert.deepEqual(
      (await readAllPendingOperations()).map((row) => row.id),
      [
        "pr-applied-new",
        "pr-applied-unresolved",
        "pr-applying",
        "pr-failed-old",
        "pr-pending",
      ],
    );

    // And the filter really is the thing doing the selecting, on a real
    // DataFusion parse — not just an equivalent JS filter that happens to
    // agree. The `resolvedAt` comparison is a STRING comparison standing in for
    // a date comparison, which only works because toISOString() is fixed-width.
    assert.equal(
      buildPruneFilter(CUTOFF),
      "status IN ('applied', 'rejected') AND `resolvedAt` != '' AND " +
        `\`resolvedAt\` < '${CUTOFF}'`,
    );
  });

  it("is a no-op that deletes nothing when nothing is old enough", async () => {
    const before = await readAllPendingOperations();
    assert.equal(await prunePendingOperations("2020-01-01T00:00:00.000Z"), 0);
    assert.deepEqual(await readAllPendingOperations(), before);
  });

  it("counts pending rows off the table, not off a JS filter", async () => {
    assert.equal(await countPendingOperations("pending"), 1);
    assert.equal(await countPendingOperations("applying"), 1);
    assert.equal(await countPendingOperations("rejected"), 0);
  });
});

// ---------------------------------------------------------------------------
// the dedupe lookup
// ---------------------------------------------------------------------------

describe("getPendingOperationsForEmails against a real table", () => {
  it("returns the pending rows for the named emails and nothing else", async () => {
    await seedPendingOperations([
      { id: "dd-1", emailId: "m-a", status: "pending" },
      { id: "dd-2", emailId: "m-a", status: "applied", resolvedAt: NEW },
      { id: "dd-3", emailId: "m-b", status: "pending" },
      { id: "dd-4", emailId: "m-c", status: "pending" },
      { id: "dd-5", emailId: "m-b", status: "rejected", resolvedAt: NEW },
      { id: "dd-6", emailId: "m-b", status: "applying", claimToken: "t" },
    ]);

    const rows = await getPendingOperationsForEmails(["m-a", "m-b"]);
    assert.deepEqual(
      rows.map((row) => row.id).sort(),
      ["dd-1", "dd-3"],
      "a dedupe check must see pending rows only — an applied or rejected row is " +
        "not a reason to suppress a fresh proposal, and an `applying` row is mid-flight",
    );
  });

  it("returns nothing for an email with no queue rows", async () => {
    assert.deepEqual(await getPendingOperationsForEmails(["m-nonexistent"]), []);
  });

  it("short-circuits an empty list instead of emitting `IN ()`", async () => {
    // `IN ()` is a DataFusion parse error, so the guard is load-bearing rather
    // than an optimisation.
    assert.deepEqual(await getPendingOperationsForEmails([]), []);
  });

  it("escapes a quote in an email id instead of breaking the predicate", async () => {
    await seedPendingOperations([
      { id: "dd-quote", emailId: "m'quote", status: "pending" },
    ]);
    const rows = await getPendingOperationsForEmails(["m'quote"]);
    assert.deepEqual(rows.map((row) => row.id), ["dd-quote"]);
  });
});

// ---------------------------------------------------------------------------
// the enqueue dedupe, end to end against the table
// ---------------------------------------------------------------------------

describe("enqueueOperationsDetailed against a real table", () => {
  it("drops a proposal identical to one already pending, and keeps the different ones", async () => {
    const { enqueueOperationsDetailed } = await import("../actions/approval.js");

    const trash = (emailId: string): GmailOperation => ({
      emailId,
      type: "trash",
      accountEmail: "me@example.com",
    });

    const first = await enqueueOperationsDetailed({
      batchId: "enq-batch-1",
      actionId: "junk",
      actionName: "Junk",
      operations: [trash("enq-m1"), trash("enq-m2")],
    });
    assert.equal(first.ids.length, 2);
    assert.equal(first.duplicates, 0);

    const second = await enqueueOperationsDetailed({
      batchId: "enq-batch-2",
      actionId: "junk",
      actionName: "Junk",
      operations: [
        trash("enq-m1"), // already pending — dropped
        { ...trash("enq-m2"), type: "spam" }, // different change to the same mail — kept
        trash("enq-m3"), // new mail — kept
      ],
    });
    assert.equal(second.duplicates, 1);
    assert.deepEqual(
      second.operations.map((op) => `${op.emailId}:${op.type}`),
      ["enq-m2:spam", "enq-m3:trash"],
      "the returned operations must line up with the ids actually written",
    );

    const queued = (await getPendingOperations({ status: "pending" })).filter(
      (row) => row.emailId.startsWith("enq-m"),
    );
    assert.equal(queued.length, 4);
  });

  it("re-proposes after the earlier row was rejected", async () => {
    // Deliberate: the dedupe is scoped to PENDING rows. Suppressing a
    // re-proposal after a rejection would hide the proposal entirely, leaving
    // the user nothing to see or act on.
    const { enqueueOperationsDetailed, rejectPendingOperationsByIds } =
      await import("../actions/approval.js");

    const op: GmailOperation = {
      emailId: "enq-reject",
      type: "trash",
      accountEmail: "me@example.com",
    };
    const first = await enqueueOperationsDetailed({
      batchId: "enq-batch-3",
      actionId: "junk",
      actionName: "Junk",
      operations: [op],
    });
    assert.equal(await rejectPendingOperationsByIds(first.ids, "cli"), 1);

    const again = await enqueueOperationsDetailed({
      batchId: "enq-batch-4",
      actionId: "junk",
      actionName: "Junk",
      operations: [op],
    });
    assert.equal(again.duplicates, 0);
    assert.equal(again.ids.length, 1);
  });
});

// ---------------------------------------------------------------------------
// chunked claim/resolve, as the table sees it
// ---------------------------------------------------------------------------

function okResult(operations: GmailOperation[]): ActionApplyResult {
  return {
    applied: operations.length,
    failed: 0,
    errors: [],
    outcomes: operations.map((op) => ({
      emailId: op.emailId,
      type: op.type,
      ok: true,
    })),
  };
}

describe("the chunked apply's claim/resolve state on disk", () => {
  it("has exactly one chunk claimed while Gmail is being called", async () => {
    // THE BOUND THE WHOLE DESIGN RESTS ON, checked against the table rather
    // than against an injected recorder: at the moment of a Gmail call, the
    // rows in `applying` are this chunk's rows, every later id is still
    // `pending`, and every earlier id is already resolved.
    const seeded = await seedPendingOperations(
      Array.from({ length: 7 }, (_, i) => ({
        id: `chunk-${String(i).padStart(2, "0")}`,
        batchId: "chunk-batch",
        status: "pending" as const,
      })),
    );
    const ids = seeded.map((row) => row.id);

    const snapshots: Array<Record<string, string>> = [];
    const result = await applyClaimedOperationsInChunks(
      ids,
      {
        newToken: () => `tok-${String(snapshots.length)}`,
        claim: (chunkIds, token) =>
          claimPendingOperations(chunkIds, token, "applying", "cli"),
        apply: async (operations) => {
          const rows = await readAllPendingOperations();
          const byStatus: Record<string, string> = {};
          for (const row of rows) {
            if (!row.id.startsWith("chunk-")) continue;
            byStatus[row.id] = row.status;
          }
          snapshots.push(byStatus);
          return okResult(operations);
        },
        resolve: (outcomes, token) =>
          resolveClaimedOperations(outcomes, token, NEW),
      },
      3,
    );

    assert.equal(result.applied, 7);
    assert.equal(snapshots.length, 3, "7 ids at chunk size 3 is three chunks");

    const applyingIn = (snapshot: Record<string, string>): string[] =>
      Object.entries(snapshot)
        .filter(([, status]) => status === "applying")
        .map(([id]) => id)
        .sort();

    assert.deepEqual(applyingIn(snapshots[0] as Record<string, string>), [
      "chunk-00",
      "chunk-01",
      "chunk-02",
    ]);
    assert.deepEqual(applyingIn(snapshots[1] as Record<string, string>), [
      "chunk-03",
      "chunk-04",
      "chunk-05",
    ]);
    assert.deepEqual(applyingIn(snapshots[2] as Record<string, string>), [
      "chunk-06",
    ]);

    // Chunk 2's snapshot: chunk 1 already resolved, chunk 3 still untouched.
    assert.equal(snapshots[1]?.["chunk-00"], "applied");
    assert.equal(snapshots[1]?.["chunk-06"], "pending");

    for (const id of ids) {
      const row = await readPendingOperation(id);
      assert.equal(row.status, "applied", `${id} should be applied`);
      assert.equal(row.resolvedAt, NEW);
      // The lease is spent but harmless; what matters is that no row is left
      // in `applying`, which is the state nothing else can act on.
      assert.notEqual(row.status, "applying");
    }
  });

  it("a claim only ever wins rows that are still pending", async () => {
    const [a, b] = await seedPendingOperations([
      { id: "claim-a", status: "pending" },
      { id: "claim-b", status: "rejected", resolvedAt: NEW },
    ]);
    assert.ok(a && b);

    const won = await claimPendingOperations(
      ["claim-a", "claim-b"],
      "tok-claim",
      "applying",
      "cli",
    );
    assert.deepEqual(won.map((row) => row.id), ["claim-a"]);
    assert.equal((await readPendingOperation("claim-b")).status, "rejected");
    assert.equal((await readPendingOperation("claim-b")).claimToken, "");
  });

  it("stamps the claiming SURFACE onto the row it wins, and only that row", async () => {
    // `approvedVia` is attribution, so the one thing it must get right is that
    // the value written is the one the caller passed — and that a row the claim
    // did NOT win keeps its own (here: still-unattributed) value rather than
    // inheriting the claimer's.
    const [a, b] = await seedPendingOperations([
      { id: "via-a", status: "pending" },
      { id: "via-b", status: "pending" },
    ]);
    assert.ok(a && b);
    assert.equal((await readPendingOperation("via-a")).approvedVia, "");

    const won = await claimPendingOperations(["via-a"], "tok-via", "applying", "web");

    assert.deepEqual(won.map((row) => row.id), ["via-a"]);
    // Read back off the table, not off the returned rows: the point is what was
    // WRITTEN, not what the call happened to return.
    assert.equal((await readPendingOperation("via-a")).approvedVia, "web");
    assert.equal((await readPendingOperation("via-a")).status, "applying");
    assert.equal((await readPendingOperation("via-b")).approvedVia, "");
    assert.equal((await readPendingOperation("via-b")).status, "pending");
  });

  it("records the CLI and auto-apply surfaces the same way the web one is recorded", async () => {
    // The two literals that reach `claimPendingOperations` from outside the web
    // routes. Both go through the product's own reject/apply entry points, so
    // this also pins that `rejectPendingOperationsByIds` still passes its
    // `resolvedAt` in the right POSITION — `approvedVia` was inserted before it,
    // and a silent positional shift would have stamped a timestamp into the
    // attribution column.
    const { rejectPendingOperationsByIds } = await import("../actions/approval.js");
    await seedPendingOperations([
      { id: "via-cli", status: "pending" },
      { id: "via-auto", status: "pending" },
    ]);

    assert.equal(await rejectPendingOperationsByIds(["via-cli"], "cli"), 1);
    const rejected = await readPendingOperation("via-cli");
    assert.equal(rejected.approvedVia, "cli");
    assert.equal(rejected.status, "rejected");
    assert.notEqual(rejected.resolvedAt, "", "resolvedAt must still be a timestamp");
    assert.equal(rejected.claimToken.length > 0, true);

    await claimPendingOperations(["via-auto"], "tok-auto", "applying", "auto-apply");
    assert.equal((await readPendingOperation("via-auto")).approvedVia, "auto-apply");
  });

  it("a resolve only ever writes rows carrying its own token", async () => {
    await seedPendingOperations([
      { id: "res-mine", status: "pending" },
      { id: "res-theirs", status: "pending" },
    ]);
    await claimPendingOperations(["res-mine"], "tok-mine", "applying", "cli");
    await claimPendingOperations(["res-theirs"], "tok-theirs", "applying", "cli");

    const outcome = await resolveClaimedOperations(
      [
        { id: "res-mine", status: "applied" },
        { id: "res-theirs", status: "applied" },
      ],
      "tok-mine",
      NEW,
    );

    assert.equal(outcome.resolved, 1);
    assert.deepEqual(outcome.lost, [{ id: "res-theirs", status: "applied" }]);
    assert.equal((await readPendingOperation("res-mine")).status, "applied");
    assert.equal(
      (await readPendingOperation("res-theirs")).status,
      "applying",
      "another attempt's row must be left exactly as it was",
    );
  });
});

// ---------------------------------------------------------------------------
// ordering, which the grouped surfaces depend on
// ---------------------------------------------------------------------------

describe("getPendingOperations ordering off a real table", () => {
  it("is newest-first with a total order inside one millisecond", async () => {
    // Every row in a batch shares one createdAt, so without the batchId/id
    // tie-break two batches queued in the same millisecond interleave and the
    // grouped display repeats batch headers.
    const stamp = "2026-07-15T00:00:00.000Z";
    await seedPendingOperations([
      { id: "ord-b2", batchId: "zz", createdAt: stamp, emailId: "ord-1" },
      { id: "ord-a2", batchId: "aa", createdAt: stamp, emailId: "ord-2" },
      { id: "ord-a1", batchId: "aa", createdAt: stamp, emailId: "ord-3" },
      { id: "ord-newer", batchId: "mm", createdAt: NEW, emailId: "ord-4" },
    ]);

    const rows: PendingOperationRecord[] = (
      await getPendingOperations({ status: "pending" })
    ).filter((row) => row.id.startsWith("ord-"));

    assert.deepEqual(
      rows.map((row) => row.id),
      ["ord-newer", "ord-a1", "ord-a2", "ord-b2"],
    );
  });
});
