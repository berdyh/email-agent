import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeApplyOutcome,
  describeRejectOutcome,
  isFullyStaleApply,
  staleApplyMessage,
  summarizeApplyResult,
} from "./approvals-contract.js";

describe("approvals apply accounting", () => {
  it("counts ids core never claimed as skipped", () => {
    // Core claims every row it will touch and reports one applied-or-failed
    // entry per claimed row, so the remainder was resolved elsewhere.
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

  it("distinguishes a fully stale apply from an empty request", () => {
    assert.equal(isFullyStaleApply(["a", "b"], { applied: 0, failed: 0 }), true);
    // Nothing submitted is not a conflict, it is a no-op.
    assert.equal(isFullyStaleApply([], { applied: 0, failed: 0 }), false);
    assert.equal(isFullyStaleApply(["a"], { applied: 1, failed: 0 }), false);
  });

  it("says what actually happened instead of 'Applied 0 changes'", () => {
    const message = staleApplyMessage(3);
    assert.match(message, /already applied or rejected somewhere else/);
    assert.match(message, /Nothing was sent to Gmail/);
    assert.equal(message.includes("Applied 0"), false);

    assert.match(staleApplyMessage(1), /None of the 1 selected change was still pending/);
  });
});

describe("approvals toast wording", () => {
  it("reports a clean apply as success", () => {
    assert.deepEqual(describeApplyOutcome({ applied: 2, failed: 0, skipped: 0 }), {
      tone: "success",
      message: "Applied 2 changes to Gmail",
    });
  });

  it("warns rather than celebrates when some ids were already resolved", () => {
    const outcome = describeApplyOutcome({ applied: 2, failed: 0, skipped: 3 });
    assert.equal(outcome.tone, "warning");
    assert.match(outcome.message, /3 were already resolved elsewhere/);
  });

  it("treats failures as errors even alongside skips", () => {
    const outcome = describeApplyOutcome({ applied: 1, failed: 2, skipped: 1 });
    assert.equal(outcome.tone, "error");
    assert.match(outcome.message, /2 failed/);
    assert.match(outcome.message, /1 were already resolved elsewhere/);
  });

  it("describes a reject that hit nothing", () => {
    const outcome = describeRejectOutcome({ rejected: 0, skipped: 2 });
    assert.equal(outcome.tone, "warning");
    assert.match(outcome.message, /Nothing changed/);

    assert.deepEqual(describeRejectOutcome({ rejected: 1, skipped: 0 }), {
      tone: "success",
      message: "Rejected 1 pending change",
    });
  });
});
