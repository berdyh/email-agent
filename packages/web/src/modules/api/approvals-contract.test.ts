import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  claimedNothing,
  describeApplyOutcome,
  describeRejectOutcome,
  describeResidualReason,
  describeStrandedAge,
  describeStrandedPanelCopy,
  describeStrandedResolution,
  describeVerifyResolution,
  strandedPanelStatus,
  summarizeApplyResult,
  unclaimedApplyMessage,
  type VerifyStrandedResult,
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

describe("stranded row wording", () => {
  const NOW = new Date("2026-08-07T12:00:00.000Z");

  it("rounds an age down and never below a minute", () => {
    assert.equal(describeStrandedAge("2026-08-07T11:59:59.000Z", NOW), "stuck for about a minute");
    assert.equal(describeStrandedAge("2026-08-07T11:00:00.000Z", NOW), "stuck for 1 hour");
    assert.equal(describeStrandedAge("2026-08-07T11:29:00.000Z", NOW), "stuck for 31 minutes");
    assert.equal(describeStrandedAge("2026-08-05T11:00:00.000Z", NOW), "stuck for 2 days");
  });

  it("says so rather than printing NaN for a stamp it cannot parse", () => {
    // Core lists exactly such a row on purpose — a row it cannot age is the row
    // a crash left behind — so this must render, not break.
    assert.equal(describeStrandedAge("not a date", NOW), "stuck for an unknown length of time");
  });

  it("never claims the app verified anything about the mailbox", () => {
    const applied = describeStrandedResolution({
      decision: "applied",
      requested: 2,
      resolved: 2,
      skipped: 0,
    });
    assert.equal(applied.tone, "success");
    assert.ok(applied.message.includes("on your word"));
    assert.ok(applied.message.includes("did not check Gmail"));

    const notApplied = describeStrandedResolution({
      decision: "notApplied",
      requested: 1,
      resolved: 1,
      skipped: 0,
    });
    assert.ok(notApplied.message.includes("back in the approval queue"));
    assert.ok(notApplied.message.includes("on your word"));
  });

  it("keeps whatever was already recorded when the row moved on", () => {
    const none = describeStrandedResolution({
      decision: "applied",
      requested: 1,
      resolved: 0,
      skipped: 1,
    });
    assert.equal(none.tone, "warning");
    assert.ok(none.message.includes("Nothing was recorded"));
    assert.ok(none.message.includes("no longer stuck mid-apply"));
    assert.ok(none.message.includes("whatever was already recorded stayed"));

    const partial = describeStrandedResolution({
      decision: "notApplied",
      requested: 3,
      resolved: 2,
      skipped: 1,
    });
    assert.equal(partial.tone, "warning");
    assert.ok(partial.message.includes("1 row was not written"));
  });

  it("never states a cause for a skipped row as fact", () => {
    // The regression: the wording said an apply that was still running had
    // finished the row "and the outcome it recorded was kept". A row can
    // equally have been answered by another adjudication — in which case what
    // was kept is another person's unverified assertion, not a real apply's
    // record — or have been requeued and re-claimed, which makes it too new to
    // adjudicate at all. Same rule `unclaimedApplyMessage` already follows.
    for (const message of [
      describeStrandedResolution({
        decision: "applied",
        requested: 1,
        resolved: 0,
        skipped: 1,
      }).message,
      describeStrandedResolution({
        decision: "applied",
        requested: 2,
        resolved: 1,
        skipped: 1,
      }).message,
    ]) {
      assert.ok(message.includes("may have finished"), message);
      assert.ok(message.includes("requeued"), message);
      assert.equal(message.includes("has since finished"), false, message);
      assert.equal(message.includes("the outcome it recorded was kept"), false, message);
      assert.equal(message.includes("real outcome was kept"), false, message);
    }
  });

  it("offers a background verification pass as a SEPARATE cause from another person answering", () => {
    // A user who pressed nothing themselves cannot guess that an automatic
    // Gmail check exists — folding it into "another answer" would read as
    // impossible to them. The two must be distinct sentences.
    const message = describeStrandedResolution({
      decision: "applied",
      requested: 1,
      resolved: 0,
      skipped: 1,
    }).message;
    assert.ok(message.includes("another person"), message);
    assert.ok(message.includes("automatic"), message);
  });
});

describe("describeResidualReason", () => {
  it("passes message-missing and unscoped-account through unchanged — core already wrote complete sentences", () => {
    assert.equal(
      describeResidualReason("message-missing", "Gmail has no message with this id."),
      "Gmail has no message with this id.",
    );
    assert.equal(
      describeResidualReason("unscoped-account", "Labels match, but no named account."),
      "Labels match, but no named account.",
    );
  });

  it("frames credentials and check-failed with a headline, keeping core's detail verbatim", () => {
    const credentials = describeResidualReason("credentials", "invalid_grant");
    assert.ok(credentials.includes("Gmail access"));
    assert.ok(credentials.includes("invalid_grant"));

    const checkFailed = describeResidualReason("check-failed", "ETIMEDOUT");
    assert.ok(checkFailed.includes("check itself failed"));
    assert.ok(checkFailed.includes("ETIMEDOUT"));
    assert.ok(checkFailed.includes("may resolve"), "check-failed may fix itself");
  });

  it("says unverifiable-operation will NOT resolve itself — the opposite of check-failed", () => {
    const message = describeResidualReason(
      "unverifiable-operation",
      'a change of an unrecognised kind ("foo")',
    );
    assert.ok(message.includes("will not resolve on its own"));
    assert.equal(message.includes("may resolve"), false, message);
  });
});

describe("describeVerifyResolution", () => {
  function result(overrides: Partial<VerifyStrandedResult>): VerifyStrandedResult {
    return {
      checked: 0,
      appliedRecorded: 0,
      requeuedRecorded: 0,
      unresolved: [],
      ...overrides,
    };
  }

  it("says nothing at all when nothing was stale", () => {
    assert.equal(describeVerifyResolution(result({ checked: 0 })), null);
  });

  it("reports success and 'nothing left for you' when verification cleared everything", () => {
    const { tone, message } = describeVerifyResolution(
      result({ checked: 2, appliedRecorded: 1, requeuedRecorded: 1 }),
    )!;
    assert.equal(tone, "success");
    assert.ok(message.includes("Checked 2"));
    assert.ok(message.includes("1 had landed"));
    assert.ok(message.includes("1 had not"));
    assert.ok(message.includes("Nothing left for you to do"));
  });

  it("reports warning and names the residual count when rows remain", () => {
    const { tone, message } = describeVerifyResolution(
      result({
        checked: 3,
        appliedRecorded: 1,
        requeuedRecorded: 0,
        unresolved: [
          { id: "a", emailId: "m1", accountId: "x", reason: "credentials", detail: "d" },
          { id: "b", emailId: "m2", accountId: "x", reason: "check-failed", detail: "d" },
        ],
      }),
    )!;
    assert.equal(tone, "warning");
    assert.ok(message.includes("2 still need you"));
  });
});

describe("strandedPanelStatus", () => {
  it("is 'checked' only on isSuccess, whatever else is also true", () => {
    assert.equal(
      strandedPanelStatus({ isSuccess: true, isPending: false, isError: false }),
      "checked",
    );
  });

  it("is 'check-failed' when the POST itself errored — never folded into 'checking'", () => {
    // THE BUG: the old code branched on `verify.isSuccess ? ... : ...`, so an
    // errored mutation (isSuccess: false, isError: true) fell into the same
    // branch as "still checking" and kept claiming a check was in progress
    // that had already failed and, because of the panel's once-per-mount
    // guard, would never run again this session.
    assert.equal(
      strandedPanelStatus({ isSuccess: false, isPending: false, isError: true }),
      "check-failed",
    );
  });

  it("is 'checking' for both idle and in-flight — neither success nor error yet", () => {
    assert.equal(
      strandedPanelStatus({ isSuccess: false, isPending: true, isError: false }),
      "checking",
    );
    assert.equal(
      strandedPanelStatus({ isSuccess: false, isPending: false, isError: false }),
      "checking",
    );
  });
});

describe("describeStrandedPanelCopy", () => {
  it("checking: present tense, and never claims a check failed", () => {
    const { headline, description } = describeStrandedPanelCopy("checking", {
      totalCount: 2,
      explainedCount: 0,
      thresholdMinutes: 15,
    });
    assert.match(headline, /^2 Gmail changes stuck mid-apply$/);
    assert.match(description, /is checking Gmail.s current state/);
    assert.match(description, /Listed after 15 minutes/);
    assert.equal(description.includes("failed"), false, description);
  });

  it("check-failed: never claims present-tense 'is checking... now' — the honesty defect finding 4 names", () => {
    const { headline, description } = describeStrandedPanelCopy("check-failed", {
      totalCount: 1,
      explainedCount: 0,
    });
    assert.match(headline, /^1 Gmail change stuck mid-apply$/);
    assert.equal(
      description.includes("is checking Gmail’s current state for it now"),
      false,
      description,
    );
    assert.match(description, /the check itself failed/);
    assert.match(description, /reload to try again/i);
  });

  it("checked, fully explained: headline and lead both size off explainedCount", () => {
    const { headline, description } = describeStrandedPanelCopy("checked", {
      totalCount: 3,
      explainedCount: 3,
      checked: 3,
    });
    assert.match(headline, /^3 Gmail changes Email Agent checked/);
    assert.match(description, /checked Gmail’s current state for 3 stuck changes/);
    assert.equal(description.includes("more"), false, description);
  });

  it("checked, with rows the check did not explain: headline sizes off explainedCount, not totalCount — finding 5", () => {
    // The exact scenario finding 5 names: a fresh crash appears in the live
    // list after the verify pass ran, or a row lost its write to the same
    // race `strandedRowsRemaining` catches on the CLI side. Either way the
    // headline must not claim Email Agent checked all 3 of these.
    const { headline, description } = describeStrandedPanelCopy("checked", {
      totalCount: 3,
      explainedCount: 2,
      checked: 2,
    });
    assert.match(headline, /^2 Gmail changes Email Agent checked/);
    assert.equal(headline.includes("3 Gmail"), false, headline);
    assert.match(description, /1 more is listed below without an explanation/);
  });

  it("checked, with NOTHING explained and the pass made zero Gmail calls: does not claim a read happened", () => {
    // `checked: 0` from a successful verify pass means the cheap DB gate
    // found nothing stale — zero Gmail calls were made. Rows shown here
    // arrived after that. Claiming "Email Agent checked Gmail just now" would
    // be exactly the defect this function exists to close.
    const { headline, description } = describeStrandedPanelCopy("checked", {
      totalCount: 1,
      explainedCount: 0,
      checked: 0,
    });
    assert.equal(headline.includes("checked"), false, headline);
    assert.match(headline, /^1 Gmail change stuck mid-apply$/);
    assert.equal(description.includes("checked Gmail just now"), false, description);
    assert.match(description, /made no Gmail calls/);
  });

  it("checked, with nothing explained but the pass DID call Gmail: honest about the check having run, just not over these rows", () => {
    const { description } = describeStrandedPanelCopy("checked", {
      totalCount: 1,
      explainedCount: 0,
      checked: 4,
    });
    assert.match(description, /checked Gmail just now, but that check did not cover/);
  });

  it("every branch carries the 'nothing applied for you' promise", () => {
    for (const status of ["checking", "checked", "check-failed"] as const) {
      const { description } = describeStrandedPanelCopy(status, {
        totalCount: 1,
        explainedCount: status === "checked" ? 1 : 0,
        checked: 1,
      });
      assert.match(description, /Nothing below will be applied or undone for you\./);
    }
  });
});
