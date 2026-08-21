import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { PendingOperationRecord } from "../db/schema.js";
import type { MessageLabelRead } from "../gmail/read.js";
import {
  verdictFromLabels,
  verifyStrandedApplyingOperations,
  type StrandedVerificationDeps,
} from "./verify-stranded.js";

function kindOf(
  type: string,
  labels: string[],
  operationLabels: string[] = [],
): string {
  return verdictFromLabels(type, labels, operationLabels).kind;
}

describe("the verdict table", () => {
  it("reads markRead and markUnread off UNREAD, in both directions", () => {
    assert.equal(kindOf("markRead", ["INBOX"]), "applied");
    assert.equal(kindOf("markRead", ["INBOX", "UNREAD"]), "notApplied");
    assert.equal(kindOf("markUnread", ["INBOX", "UNREAD"]), "applied");
    assert.equal(kindOf("markUnread", ["INBOX"]), "notApplied");
  });

  it("accepts TRASH alone, without requiring INBOX to be gone", () => {
    // Gmail removes INBOX implicitly on trash, but a message can still be
    // listed with both. Requiring INBOX absent would manufacture a false
    // negative and requeue a change that really happened — which is the
    // direction that can produce a second mutation. Pinned so a later
    // "tightening" to match the spam rule fails here.
    assert.equal(kindOf("trash", ["TRASH", "INBOX"]), "applied");
    assert.equal(kindOf("trash", ["TRASH"]), "applied");
    assert.equal(kindOf("trash", ["INBOX"]), "notApplied");
  });

  it("requires BOTH halves of the spam change, because it is one atomic modify", () => {
    // `markAsSpam` is ONE `modify` with addLabelIds:["SPAM"] AND
    // removeLabelIds:["INBOX"], so that pair is the intended end state. The
    // TODOS table said "SPAM present", and a naive implementation of that
    // returns `applied` for the first case here.
    assert.equal(kindOf("spam", ["SPAM", "INBOX"]), "notApplied");
    assert.equal(kindOf("spam", ["SPAM"]), "applied");
    assert.equal(kindOf("spam", ["INBOX"]), "notApplied");
    assert.equal(kindOf("spam", []), "notApplied");
  });

  it("needs every added label present, and every removed label gone", () => {
    assert.equal(kindOf("addLabels", ["Label_1"], ["Label_1", "Label_2"]), "notApplied");
    assert.equal(
      kindOf("addLabels", ["Label_1", "Label_2"], ["Label_1", "Label_2"]),
      "applied",
    );
    assert.equal(kindOf("removeLabels", ["INBOX"], ["INBOX"]), "notApplied");
    assert.equal(kindOf("removeLabels", ["UNREAD"], ["INBOX"]), "applied");
    assert.equal(
      kindOf("removeLabels", ["INBOX"], ["INBOX", "Label_9"]),
      "notApplied",
    );
  });

  it("compares label ids exactly and case-sensitively", () => {
    // No name->id resolution: system ids are uppercase, user labels are opaque
    // (`Label_123`), and an operation carrying a NAME would have had its apply
    // rejected by Gmail, so it never reached `applying` successfully.
    assert.equal(kindOf("addLabels", ["label_1"], ["Label_1"]), "notApplied");
    assert.equal(kindOf("removeLabels", ["inbox"], ["INBOX"]), "applied");
  });

  it("FAILS CLOSED on a label change that names no labels", () => {
    // THE VACUOUS-every() TRAP. `[].every(...)` is true, so a naive
    // implementation verifies these as APPLIED — and `applyOperations` THROWS
    // for them, so such a row can never have been applied by this app at all.
    for (const type of ["addLabels", "removeLabels"]) {
      const verdict = verdictFromLabels(type, ["INBOX"], []);
      assert.equal(verdict.kind, "unknown", type);
      assert.match(
        verdict.kind === "unknown" ? verdict.reason : "",
        /names no labels/,
      );
    }
  });

  it("FAILS CLOSED on a type this build does not know", () => {
    // Matching `applyOperations`'s `default: throw`. A future operation type
    // read by an older build must never be guessed at.
    const verdict = verdictFromLabels("archiveForever", ["INBOX"], []);
    assert.equal(verdict.kind, "unknown");
    assert.match(
      verdict.kind === "unknown" ? verdict.reason : "",
      /unrecognised kind/,
    );
    assert.equal(kindOf("", []), "unknown");
  });
});

// ---------------------------------------------------------------------------
// Orchestration, through injected deps. No DB, no Gmail.
// ---------------------------------------------------------------------------

function row(
  overrides: Partial<PendingOperationRecord> = {},
): PendingOperationRecord {
  const id = (overrides.id as string | undefined) ?? "op-1";
  return {
    id,
    batchId: "batch-1",
    actionId: "junk",
    actionName: "Junk Detector",
    accountId: "me@example.com",
    emailId: `msg-${id}`,
    type: "markRead",
    labelIds: "[]",
    status: "applying",
    error: "",
    claimToken: "tok",
    createdAt: "2026-08-01T00:00:00.000Z",
    claimedAt: "2026-08-01T00:00:00.000Z",
    resolvedAt: "",
    approvedVia: "cli",
    resolutionEvidence: "",
    ...overrides,
  };
}

interface Recorder {
  deps: StrandedVerificationDeps;
  readCalls: Array<[string, string]>;
  adjudications: Array<{ ids: string[]; decision: string; evidence: string }>;
  inFlightReads: number;
  maxConcurrentReads: number;
}

function recorder(
  rows: PendingOperationRecord[],
  reads: Record<string, MessageLabelRead>,
): Recorder {
  const state: Recorder = {
    readCalls: [],
    adjudications: [],
    inFlightReads: 0,
    maxConcurrentReads: 0,
    deps: {
      listStranded: async () => rows,
      readLabels: async (messageId, accountEmail) => {
        state.readCalls.push([messageId, accountEmail]);
        state.inFlightReads += 1;
        state.maxConcurrentReads = Math.max(
          state.maxConcurrentReads,
          state.inFlightReads,
        );
        await Promise.resolve();
        state.inFlightReads -= 1;
        return (
          reads[messageId] ?? { kind: "error", message: "no stub configured" }
        );
      },
      adjudicate: async (ids, decision, evidence) => {
        state.adjudications.push({ ids: [...ids], decision, evidence });
        return ids.length;
      },
    },
  };
  return state;
}

describe("verifying stranded rows", () => {
  it("makes NO Gmail call and NO write when nothing is stranded", async () => {
    // THE CHEAP GATE. This runs automatically on paths the user did not ask to
    // pay for (a fetch, a server start), so an empty stale list must cost one
    // local query and nothing else. The stubs throw rather than count, so a
    // regression is a failure and not a silently different number.
    const result = await verifyStrandedApplyingOperations({
      listStranded: async () => [],
      readLabels: async () => {
        throw new Error("readLabels must not be called with nothing stranded");
      },
      adjudicate: async () => {
        throw new Error("adjudicate must not be called with nothing stranded");
      },
    });
    assert.deepEqual(result, {
      checked: 0,
      appliedIds: [],
      requeuedIds: [],
      appliedRecorded: 0,
      requeuedRecorded: 0,
      unresolved: [],
    });
  });

  it("partitions a mixed batch into exactly two disjoint adjudications", async () => {
    const rows = [
      row({ id: "a", type: "markRead" }),
      row({ id: "b", type: "markRead" }),
      row({ id: "c", type: "trash" }),
      row({ id: "d", type: "addLabels", labelIds: "[]" }),
      row({ id: "e", type: "trash" }),
    ];
    const state = recorder(rows, {
      "msg-a": { kind: "labels", labelIds: ["INBOX"] },
      "msg-b": { kind: "labels", labelIds: ["INBOX", "UNREAD"] },
      "msg-c": { kind: "labels", labelIds: ["TRASH"] },
      "msg-d": { kind: "labels", labelIds: ["INBOX"] },
      "msg-e": { kind: "notFound" },
    });

    const result = await verifyStrandedApplyingOperations(state.deps);

    assert.equal(result.checked, 5);
    assert.deepEqual(result.appliedIds, ["a", "c"]);
    assert.deepEqual(result.requeuedIds, ["b"]);
    assert.deepEqual(
      result.unresolved.map((entry) => `${entry.id}:${entry.reason}`),
      ["d:unverifiable-operation", "e:message-missing"],
    );
    assert.deepEqual(state.adjudications, [
      { ids: ["a", "c"], decision: "applied", evidence: "verified-api" },
      { ids: ["b"], decision: "notApplied", evidence: "verified-api" },
    ]);
    assert.equal(result.appliedRecorded, 2);
    assert.equal(result.requeuedRecorded, 1);
  });

  it("never adjudicates a row it could not read, whatever went wrong", async () => {
    // A 404 on a `trash` row is the sharp case: it can mean the trash SUCCEEDED
    // and Gmail purged the message, so treating it as `notApplied` would
    // re-propose a trash that already happened, and treating it as `applied`
    // would retire a row on nothing. Both are refused; a human decides.
    const rows = [
      row({ id: "missing", type: "trash" }),
      row({ id: "creds", type: "markRead" }),
      row({ id: "broke", type: "markRead" }),
    ];
    const state = recorder(rows, {
      "msg-missing": { kind: "notFound" },
      "msg-creds": { kind: "noCredentials", message: "Invalid Credentials" },
      "msg-broke": { kind: "error", message: "connect ECONNREFUSED" },
    });

    const result = await verifyStrandedApplyingOperations(state.deps);

    assert.deepEqual(state.adjudications, [], "nothing may be written");
    assert.deepEqual(result.appliedIds, []);
    assert.deepEqual(result.requeuedIds, []);
    assert.deepEqual(
      result.unresolved.map((entry) => entry.reason),
      ["message-missing", "credentials", "check-failed"],
    );
    // The reason a human is given must be specific enough to act on: "we could
    // not check" is not actionable.
    assert.match(result.unresolved[0]?.detail ?? "", /purged/);
    assert.equal(result.unresolved[1]?.detail, "Invalid Credentials");
    assert.equal(result.unresolved[2]?.detail, "connect ECONNREFUSED");
  });

  it("never records an unscoped ADC row as applied, only as requeued or residual", async () => {
    // `createGmailClient("")` resolves whatever identity gcloud ADC points at
    // NOW. A positive verdict could therefore come from a different mailbox and
    // would silently retire the row; a negative one only requeues a proposal
    // the user has to approve anyway. So the asymmetry, and it costs nothing.
    const rows = [
      row({ id: "adc-yes", accountId: "", type: "markRead" }),
      row({ id: "adc-no", accountId: "", type: "markRead" }),
      row({ id: "named", accountId: "me@example.com", type: "markRead" }),
    ];
    const state = recorder(rows, {
      "msg-adc-yes": { kind: "labels", labelIds: ["INBOX"] },
      "msg-adc-no": { kind: "labels", labelIds: ["INBOX", "UNREAD"] },
      "msg-named": { kind: "labels", labelIds: ["INBOX"] },
    });

    const result = await verifyStrandedApplyingOperations(state.deps);

    assert.deepEqual(result.appliedIds, ["named"], "no '' row may be applied");
    assert.deepEqual(result.requeuedIds, ["adc-no"], "requeue stays allowed");
    assert.deepEqual(
      result.unresolved.map((entry) => `${entry.id}:${entry.reason}`),
      ["adc-yes:unscoped-account"],
    );
    // The row IS checked, rather than skipped: skipping it would leave the user
    // no better off than before the verifier existed.
    assert.deepEqual(state.readCalls, [
      ["msg-adc-yes", ""],
      ["msg-adc-no", ""],
      ["msg-named", "me@example.com"],
    ]);
  });

  it("reads one message at a time, in order", async () => {
    // Serial on purpose. A burst raises the 429 risk, and a 429 here becomes an
    // unresolved row a person has to answer — strictly worse than being slow.
    const rows = [row({ id: "a" }), row({ id: "b" }), row({ id: "c" })];
    const state = recorder(rows, {
      "msg-a": { kind: "labels", labelIds: [] },
      "msg-b": { kind: "labels", labelIds: [] },
      "msg-c": { kind: "labels", labelIds: [] },
    });

    await verifyStrandedApplyingOperations(state.deps);

    assert.equal(state.maxConcurrentReads, 1, "reads must not overlap");
    assert.deepEqual(
      state.readCalls.map(([id]) => id),
      ["msg-a", "msg-b", "msg-c"],
    );
  });

  it("skips an adjudication call entirely when its side is empty", async () => {
    // `buildIdListFilter` throws on an empty list, and a write with nothing to
    // write is a claim-token stamp against no rows either way.
    const state = recorder([row({ id: "a", type: "markRead" })], {
      "msg-a": { kind: "labels", labelIds: ["INBOX"] },
    });
    await verifyStrandedApplyingOperations(state.deps);
    assert.deepEqual(
      state.adjudications.map((call) => call.decision),
      ["applied"],
    );
  });

  it("reports what the write actually recorded, not what it asked for", async () => {
    // A shortfall is information: a row an apply finished between the read and
    // the write is not matched by the write predicate. It must not be reported
    // as if the write had landed.
    const rows = [row({ id: "a", type: "markRead" }), row({ id: "b", type: "markRead" })];
    const state = recorder(rows, {
      "msg-a": { kind: "labels", labelIds: ["INBOX"] },
      "msg-b": { kind: "labels", labelIds: ["INBOX"] },
    });
    const result = await verifyStrandedApplyingOperations({
      ...state.deps,
      adjudicate: async () => 1,
    });
    assert.deepEqual(result.appliedIds, ["a", "b"]);
    assert.equal(result.appliedRecorded, 1);
  });
});
