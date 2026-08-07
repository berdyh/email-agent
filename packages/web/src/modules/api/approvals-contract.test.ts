import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimedNothing,
  describeApplyOutcome,
  describeRejectOutcome,
  summarizeApplyResult,
  unclaimedApplyMessage,
} from "./approvals-contract.js";

describe("approvals apply accounting", () => {
  it("counts ids core never claimed as skipped", () => {
    // Core claims every row it will touch and reports one applied-or-failed
    // entry per claimed row, so the remainder is exactly what this call did
    // not claim — which is all the arithmetic establishes about it.
    assert.deepEqual(summarizeApplyResult(["a", "b", "c"], { applied: 1, failed: 1 }), {
      requested: 3,
      skipped: 1,
      claimed: 2,
    });
    assert.deepEqual(summarizeApplyResult(["a"], { applied: 1, failed: 0 }), {
      requested: 1,
      skipped: 0,
      claimed: 1,
    });
  });

  it("never reports a negative skip if core over-reports", () => {
    assert.equal(summarizeApplyResult(["a"], { applied: 2, failed: 0 }).skipped, 0);
  });

  it("distinguishes claiming nothing from an empty request", () => {
    assert.equal(claimedNothing(["a", "b"], { applied: 0, failed: 0 }), true);
    // Nothing submitted is not a conflict, it is a no-op.
    assert.equal(claimedNothing([], { applied: 0, failed: 0 }), false);
    assert.equal(claimedNothing(["a"], { applied: 1, failed: 0 }), false);
  });

  it("offers reasons for an unclaimed apply without asserting one", () => {
    // The 409 used to state that the rows "were already applied or rejected
    // somewhere else". A row that another tab is mid-way through applying is
    // neither, so the sentence may only assert what this call observed.
    const message = unclaimedApplyMessage(3);
    assert.match(message, /None of the 3 selected changes could be claimed/);
    assert.match(message, /nothing was sent to Gmail/);
    assert.match(message, /may already have been applied or rejected somewhere else/);
    assert.match(message, /another apply may still be working on them/);
    assert.equal(message.includes("Applied 0"), false);
    assert.equal(/were already applied or rejected/.test(message), false);
    assert.equal(message.includes("still pending"), false);

    assert.match(unclaimedApplyMessage(1), /None of the 1 selected change could be claimed/);
    assert.match(unclaimedApplyMessage(1), /It may already have been/);
  });
});

describe("approvals toast wording", () => {
  it("reports a clean apply as success", () => {
    assert.deepEqual(describeApplyOutcome({ applied: 2, failed: 0, skipped: 0 }), {
      tone: "success",
      message: "Applied 2 changes to Gmail",
    });
  });

  it("warns rather than celebrates when some ids were not claimed", () => {
    const outcome = describeApplyOutcome({ applied: 2, failed: 0, skipped: 3 });
    assert.equal(outcome.tone, "warning");
    assert.match(outcome.message, /3 could not be claimed and were not touched by this run/);
    assert.equal(/already resolved/.test(outcome.message), false);
  });

  it("treats failures as errors even alongside unclaimed ids", () => {
    const outcome = describeApplyOutcome({ applied: 1, failed: 2, skipped: 1 });
    assert.equal(outcome.tone, "error");
    assert.match(outcome.message, /2 failed/);
    assert.match(outcome.message, /1 could not be claimed/);
  });

  it("describes a reject that claimed nothing without asserting why", () => {
    const outcome = describeRejectOutcome({ rejected: 0, skipped: 2 });
    assert.equal(outcome.tone, "warning");
    assert.match(outcome.message, /None of the 2 selected changes could be claimed/);
    assert.match(outcome.message, /another run had already claimed or resolved them/);
    assert.match(outcome.message, /Nothing was rejected here/);
    assert.equal(/already applied or rejected somewhere else/.test(outcome.message), false);

    assert.deepEqual(describeRejectOutcome({ rejected: 1, skipped: 0 }), {
      tone: "success",
      message: "Rejected 1 pending change",
    });
  });
});
