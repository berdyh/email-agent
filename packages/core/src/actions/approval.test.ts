import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPLY_RESOLUTION_CHUNK_SIZE,
  applyClaimedOperationsInChunks,
  chunkList,
  describeGmailOperation,
  mergeApplyResults,
  operationDedupeKey,
  selectNewOperationIndexes,
  toOperationOutcomes,
  isDestructiveOperation,
  parseLabelIds,
  resolveRetentionCutoff,
  recordToGmailOperation,
  toPendingOperationRecords,
  type ChunkedApplyDeps,
} from "./approval.js";
import type { PendingOperationRecord } from "../db/schema.js";
import type { ActionApplyResult } from "./types.js";
import { defaultConfig } from "../config/defaults.js";

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

describe("chunked apply resolution", () => {
  it("splits a batch into ordered fixed-size chunks", () => {
    assert.deepEqual(chunkList([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
    assert.deepEqual(chunkList([1, 2, 3, 4], 4), [[1, 2, 3, 4]]);
    assert.deepEqual(chunkList([1], 10), [[1]]);
    assert.deepEqual(chunkList([], 3), []);
  });

  it("refuses a chunk size that would never advance", () => {
    // A size of 0 would loop forever over a non-empty batch, mid-mutation.
    assert.throws(() => chunkList([1], 0), /at least 1/);
  });

  it("keeps the configured chunk size small enough to bound the lying window", () => {
    assert.ok(APPLY_RESOLUTION_CHUNK_SIZE >= 1);
    assert.ok(APPLY_RESOLUTION_CHUNK_SIZE <= 50);
  });
});

describe("mapping Gmail outcomes onto queue rows", () => {
  const rows = toPendingOperationRecords({
    batchId: "batch-1",
    actionId: "junk",
    actionName: "Junk Detector",
    operations: [
      { emailId: "m1", type: "trash" },
      { emailId: "m2", type: "spam" },
    ],
  });

  it("records applied and failed per row, in order", () => {
    const outcomes = toOperationOutcomes(rows, {
      applied: 1,
      failed: 1,
      errors: [{ emailId: "m2", error: "boom" }],
      outcomes: [
        { emailId: "m1", type: "trash", ok: true },
        { emailId: "m2", type: "spam", ok: false, error: "boom" },
      ],
    });

    assert.deepEqual(outcomes, [
      { id: rows[0]?.id, status: "applied" },
      { id: rows[1]?.id, status: "failed", error: "boom" },
    ]);
  });

  it("fails closed when an outcome is missing", () => {
    // A short outcome list means applyOperations' one-per-operation contract
    // broke. Recording "applied" would retire the row and silently drop a
    // change the user approved.
    const outcomes = toOperationOutcomes(rows, {
      applied: 1,
      failed: 0,
      errors: [],
      outcomes: [{ emailId: "m1", type: "trash", ok: true }],
    });

    assert.equal(outcomes[1]?.status, "failed");
    assert.match(String(outcomes[1]?.error), /No apply outcome was recorded/);
  });
});

describe("merging per-chunk apply results", () => {
  it("sums counts and concatenates outcomes in chunk order", () => {
    const merged = mergeApplyResults([
      {
        applied: 2,
        failed: 0,
        errors: [],
        outcomes: [
          { emailId: "m1", type: "trash", ok: true },
          { emailId: "m2", type: "trash", ok: true },
        ],
      },
      {
        applied: 0,
        failed: 1,
        errors: [{ emailId: "m3", error: "boom" }],
        outcomes: [{ emailId: "m3", type: "spam", ok: false, error: "boom" }],
      },
    ]);

    assert.equal(merged.applied, 2);
    assert.equal(merged.failed, 1);
    assert.deepEqual(merged.errors, [{ emailId: "m3", error: "boom" }]);
    // Order is the contract: every surface pairs outcomes with the operations
    // it submitted, positionally.
    assert.deepEqual(
      merged.outcomes.map((o) => o.emailId),
      ["m1", "m2", "m3"],
    );
  });

  it("returns an empty result for a batch that produced no chunks", () => {
    assert.deepEqual(mergeApplyResults([]), {
      applied: 0,
      failed: 0,
      errors: [],
      outcomes: [],
    });
  });
});

describe("chunked apply claims one chunk at a time", () => {
  /**
   * A fake queue whose rows are whatever ids the caller asks for. Records the
   * exact claim/apply/resolve call sequence so the ordering guarantee — not
   * just the end state — is what the assertions read.
   */
  function harness(options?: {
    failResolveOnCall?: number;
    failApplyOnCall?: number;
    unclaimable?: ReadonlySet<string>;
  }) {
    const claimed: string[][] = [];
    const applied: string[][] = [];
    const resolved: string[][] = [];
    const tokens: string[] = [];
    let tokenSeq = 0;
    let resolveCalls = 0;
    let applyCalls = 0;

    const deps: ChunkedApplyDeps = {
      newToken() {
        const token = `token-${++tokenSeq}`;
        tokens.push(token);
        return token;
      },
      async claim(ids) {
        const won = ids.filter((id) => !options?.unclaimable?.has(id));
        claimed.push([...ids]);
        return won.map(
          (id) =>
            ({
              id,
              batchId: "b1",
              actionId: "a1",
              actionName: "A",
              accountId: "",
              emailId: `msg-${id}`,
              type: "trash",
              labelIds: "[]",
              status: "applying",
              error: "",
              claimToken: "t",
              createdAt: "2026-08-07T00:00:00.000Z",
              claimedAt: "2026-08-07T00:00:00.000Z",
              resolvedAt: "",
            }) satisfies PendingOperationRecord,
        );
      },
      async apply(operations) {
        applyCalls += 1;
        applied.push(operations.map((op) => op.emailId));
        if (applyCalls === options?.failApplyOnCall) {
          throw new Error("gmail exploded");
        }
        return {
          applied: operations.length,
          failed: 0,
          errors: [],
          outcomes: operations.map((op) => ({
            emailId: op.emailId,
            type: op.type,
            ok: true,
          })),
        } satisfies ActionApplyResult;
      },
      async resolve(outcomes) {
        resolveCalls += 1;
        if (resolveCalls === options?.failResolveOnCall) {
          throw new Error("lancedb exploded");
        }
        resolved.push(outcomes.map((outcome) => outcome.id));
      },
    };

    return { deps, claimed, applied, resolved, tokens };
  }

  const ids = (n: number) =>
    Array.from({ length: n }, (_, i) => `op-${String(i + 1).padStart(2, "0")}`);

  it("bounds the claimed set to the chunk in flight", async () => {
    // The bug: every id was claimed as `applying` BEFORE the loop, so a
    // first-chunk failure left the whole remainder claimed — ineligible for
    // approval OR rejection — even though only one chunk reached Gmail. With
    // 200 rows that stranded up to 200 of them.
    const { deps, claimed, applied, resolved } = harness({
      failResolveOnCall: 1,
    });

    await assert.rejects(
      applyClaimedOperationsInChunks(ids(30), deps, 10),
      /lancedb exploded/,
    );

    // Exactly one chunk was ever claimed. The other 20 ids never left
    // `pending`, so the user can still approve or reject them.
    assert.equal(claimed.length, 1);
    assert.deepEqual(claimed[0], ids(30).slice(0, 10));
    assert.equal(applied.length, 1);
    assert.deepEqual(resolved, []);
  });

  it("stops claiming when the Gmail call itself throws", async () => {
    const { deps, claimed } = harness({ failApplyOnCall: 2 });

    await assert.rejects(
      applyClaimedOperationsInChunks(ids(30), deps, 10),
      /gmail exploded/,
    );

    assert.equal(claimed.length, 2);
    assert.deepEqual(claimed[1], ids(30).slice(10, 20));
  });

  it("gives every chunk its own claim token", async () => {
    // Resolution predicates are scoped to claimToken AND status, so two chunks
    // sharing a token would let one chunk's resolve touch the other's rows.
    const { deps, tokens } = harness();
    await applyClaimedOperationsInChunks(ids(25), deps, 10);
    assert.equal(tokens.length, 3);
    assert.equal(new Set(tokens).size, 3);
  });

  it("resolves each chunk before claiming the next", async () => {
    const { deps, claimed, resolved } = harness();
    const result = await applyClaimedOperationsInChunks(ids(25), deps, 10);

    assert.deepEqual(claimed.map((chunk) => chunk.length), [10, 10, 5]);
    assert.deepEqual(resolved.map((chunk) => chunk.length), [10, 10, 5]);
    assert.equal(result.applied, 25);
    // Outcome order still follows input order, which every surface pairs
    // positionally against the operations it submitted.
    assert.deepEqual(
      result.outcomes.map((outcome) => outcome.emailId),
      ids(25).map((id) => `msg-${id}`),
    );
  });

  it("skips a chunk it won no rows for and carries on", async () => {
    // A concurrent reject took the whole first chunk. That must not abort the
    // rest of the batch, and must not produce phantom outcomes.
    const { deps, applied } = harness({ unclaimable: new Set(ids(20).slice(0, 10)) });
    const result = await applyClaimedOperationsInChunks(ids(20), deps, 10);

    assert.equal(applied.length, 1);
    assert.deepEqual(applied[0], ids(20).slice(10).map((id) => `msg-${id}`));
    assert.equal(result.applied, 10);
  });

  it("defaults to the documented chunk size", async () => {
    const { deps, claimed } = harness();
    await applyClaimedOperationsInChunks(ids(APPLY_RESOLUTION_CHUNK_SIZE + 1), deps);
    assert.deepEqual(
      claimed.map((chunk) => chunk.length),
      [APPLY_RESOLUTION_CHUNK_SIZE, 1],
    );
  });
});

describe("retention cutoff", () => {
  const now = new Date("2026-08-07T12:00:00.000Z");

  it("keeps rows newer than the configured window", () => {
    assert.equal(
      resolveRetentionCutoff(30, now),
      "2026-07-08T12:00:00.000Z",
    );
  });

  it("disables pruning rather than pruning everything on a bad value", () => {
    // Wrong-direction failure here destroys the audit trail of real Gmail
    // mutations, which cannot be reconstructed. Keep too much, never too few.
    for (const days of [0, -1, NaN, Infinity, undefined]) {
      assert.equal(resolveRetentionCutoff(days, now), null);
    }
  });

  it("defaults to a full year of history", () => {
    assert.equal(defaultConfig.retention?.approvalQueueDays, 365);
  });
});

describe("dedupe of identical pending proposals", () => {
  function records(operations: Parameters<typeof toPendingOperationRecords>[0]["operations"]) {
    return toPendingOperationRecords({
      batchId: "batch-2",
      actionId: "junk",
      actionName: "Junk Detector",
      operations,
    });
  }

  it("treats account, message, type and label set as the identity", () => {
    const [a, b] = records([
      { emailId: "m1", type: "addLabels", labelIds: ["Work", "Later"] },
      { emailId: "m1", type: "addLabels", labelIds: ["Later", "Work"] },
    ]);
    assert.ok(a && b);
    // Label order is not part of the proposal.
    assert.equal(operationDedupeKey(a), operationDedupeKey(b));
  });

  it("keeps different proposals for the same message apart", () => {
    const [trash, archive, otherAccount] = records([
      { emailId: "m1", type: "trash" },
      { emailId: "m1", type: "removeLabels", labelIds: ["INBOX"] },
      { emailId: "m1", type: "trash", accountEmail: "work@example.com" },
    ]);
    assert.ok(trash && archive && otherAccount);
    const keys = new Set([trash, archive, otherAccount].map(operationDedupeKey));
    // The same Gmail id in two accounts is two different messages.
    assert.equal(keys.size, 3);
  });

  it("drops a re-proposal of something already awaiting approval", () => {
    // Re-running an action over the same unread mail before approving used to
    // enqueue a second identical row under a new batch.
    const existing = records([{ emailId: "m1", type: "trash" }]);
    const incoming = records([
      { emailId: "m1", type: "trash" },
      { emailId: "m2", type: "spam" },
    ]);
    assert.deepEqual(
      selectNewOperationIndexes(
        incoming,
        new Set(existing.map(operationDedupeKey)),
      ),
      [1],
    );
  });

  it("collapses duplicates inside one batch, keeping the first", () => {
    const incoming = records([
      { emailId: "m1", type: "trash" },
      { emailId: "m1", type: "trash" },
      { emailId: "m2", type: "trash" },
    ]);
    assert.deepEqual(selectNewOperationIndexes(incoming, new Set()), [0, 2]);
  });

  it("keeps everything when nothing is pending", () => {
    const incoming = records([
      { emailId: "m1", type: "trash" },
      { emailId: "m2", type: "spam" },
    ]);
    assert.deepEqual(selectNewOperationIndexes(incoming, new Set()), [0, 1]);
  });
});
