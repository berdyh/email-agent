import assert from "node:assert/strict";
import { describe, it } from "node:test";
import ora, { type Ora } from "ora";
import type { ActionApplyResult, PendingOperationRecord } from "@email-agent/core";
import {
  applyOperationIds,
  commitFailed,
  commitReviewDecisions,
  describeAbortedReview,
  describeApplyOutcome,
  describeOperation,
  describeRejectOutcome,
  describeReviewCommit,
  describeStrandedAge,
  describeStrandedHeader,
  describeStrandedResolution,
  type ApplyOutcome,
  type RejectOutcome,
} from "./approvals.js";

function record(
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
    status: "pending",
    error: "",
    claimToken: "",
    createdAt: "2026-07-31T10:00:00.000Z",
    // Required, matching the non-nullable Arrow column: "" is what an
    // unclaimed row really holds, never `undefined`.
    claimedAt: "",
    resolvedAt: "",
    approvedVia: "",
    // Required for the same reason: the Arrow column is non-nullable and an
    // unresolved row really holds "", never `undefined`.
    resolutionEvidence: "",
    ...overrides,
  };
}

describe("approval operation descriptions", () => {
  it("names each simple Gmail mutation in the user's terms", () => {
    assert.equal(describeOperation(record({ type: "trash" })), "Move to Trash");
    assert.equal(describeOperation(record({ type: "spam" })), "Mark as Spam");
    assert.equal(
      describeOperation(record({ type: "markRead" })),
      "Mark as Read",
    );
    assert.equal(
      describeOperation(record({ type: "markUnread" })),
      "Mark as Unread",
    );
  });

  it("renders a lone INBOX removal as an archive", () => {
    assert.equal(
      describeOperation(
        record({ type: "removeLabels", labelIds: '["INBOX"]' }),
      ),
      "Archive",
    );
  });

  it("lists the labels for any other label mutation", () => {
    // More than one label is a label edit, not an archive, even when INBOX is
    // among them — the user must see everything that is being removed.
    assert.equal(
      describeOperation(
        record({ type: "removeLabels", labelIds: '["INBOX","Promotions"]' }),
      ),
      "Remove labels: INBOX, Promotions",
    );
    assert.equal(
      describeOperation(
        record({ type: "removeLabels", labelIds: '["Promotions"]' }),
      ),
      "Remove labels: Promotions",
    );
    assert.equal(
      describeOperation(record({ type: "addLabels", labelIds: '["Later"]' })),
      "Add labels: Later",
    );
  });

  it("falls back to the raw type for an unrecognized operation", () => {
    // A queued row written by an older/newer build must still be displayable
    // rather than crashing the approvals list.
    assert.equal(describeOperation(record({ type: "warpDrive" })), "warpDrive");
  });
});

const HIDE_CURSOR = "\u001B[?25l";
const SHOW_CURSOR = "\u001B[?25h";

/**
 * A stream ora will treat as a real terminal, so the test drives the REAL
 * spinner — interval, cursor hiding and all — instead of a stand-in. The
 * previous test injected a bare throwing handler and never constructed a
 * spinner at all, which is why a hang that needs the spinner to exist went
 * unnoticed.
 */
function fakeTty(): { stream: NodeJS.WritableStream; output: () => string } {
  const writes: string[] = [];
  const stream = {
    isTTY: true,
    columns: 80,
    write(chunk: string) {
      writes.push(chunk);
      return true;
    },
    cursorTo() {},
    moveCursor() {},
    clearLine() {},
  };
  return {
    stream: stream as unknown as NodeJS.WritableStream,
    output: () => writes.join(""),
  };
}

function applyResult(overrides: Partial<ActionApplyResult> = {}): ActionApplyResult {
  return { applied: 0, failed: 0, errors: [], outcomes: [], ...overrides };
}

describe("applying approved operations", () => {
  it("stops the spinner and restores the cursor when the apply throws", async () => {
    const tty = fakeTty();
    let spinner: Ora | undefined;

    await assert.rejects(
      applyOperationIds(["a", "b"], {
        apply: async () => {
          throw new Error("network down");
        },
        createSpinner: (text) => {
          spinner = ora({ text, stream: tty.stream, isEnabled: true, hideCursor: true });
          return spinner;
        },
      }),
      /network down/,
    );

    try {
      // The hang: ora holds a referenced interval and a stdin discard while it
      // spins, so a spinner left running kept the CLI alive forever after it had
      // already printed its failure — with the cursor still hidden.
      assert.equal(spinner?.isSpinning, false, "spinner must not still be running");

      const output = tty.output();
      assert.ok(output.includes(HIDE_CURSOR), "spinner should have hidden the cursor");
      assert.ok(
        output.lastIndexOf(SHOW_CURSOR) > output.lastIndexOf(HIDE_CURSOR),
        "cursor must be restored after the failure, not left hidden",
      );
    } finally {
      // If the assertion above fails, the implementation left a live interval
      // behind — stop it here so the runner reports the failure instead of
      // hanging on it, which is the same symptom the user was getting.
      spinner?.stop();
    }
  });

  it("stops the spinner on the success path too", async () => {
    const tty = fakeTty();
    let spinner: Ora | undefined;

    const outcome = await applyOperationIds(["a"], {
      apply: async () => applyResult({ applied: 1 }),
      createSpinner: (text) => {
        spinner = ora({ text, stream: tty.stream, isEnabled: true, hideCursor: true });
        return spinner;
      },
    });

    try {
      assert.equal(spinner?.isSpinning, false);
      assert.deepEqual(outcome, { requested: 1, applied: 1, failed: 0, unclaimed: 0 });
      assert.ok(tty.output().lastIndexOf(SHOW_CURSOR) > tty.output().lastIndexOf(HIDE_CURSOR));
    } finally {
      spinner?.stop();
    }
  });

  it("returns the failed count core reports rather than only thrown errors", async () => {
    // Core catches per-operation Gmail errors — a 403 on a trash, say — and
    // returns them as `failed`. Nothing throws, so an exit code taken from a
    // thrown exception alone reported success to shell automation.
    const tty = fakeTty();
    const outcome = await applyOperationIds(["a", "b"], {
      apply: async () =>
        applyResult({
          applied: 1,
          failed: 1,
          errors: [{ emailId: "m2", error: "Insufficient Permission" }],
          outcomes: [
            { emailId: "m1", type: "trash", ok: true },
            { emailId: "m2", type: "trash", ok: false, error: "Insufficient Permission" },
          ],
        }),
      createSpinner: (text) =>
        ora({ text, stream: tty.stream, isEnabled: true, hideCursor: true }),
    });

    assert.equal(outcome.failed, 1);
    assert.equal(outcome.applied, 1);
    assert.equal(outcome.unclaimed, 0);
    assert.equal(
      commitFailed({ approvedIds: ["a", "b"], rejectedIds: [], applyOutcome: outcome }),
      true,
    );
  });

  it("treats an empty approval set as a no-op without starting a spinner", async () => {
    let built = false;
    const outcome = await applyOperationIds([], {
      apply: async () => {
        throw new Error("must not be called");
      },
      createSpinner: () => {
        built = true;
        return ora("unused");
      },
    });
    assert.equal(built, false);
    assert.deepEqual(outcome, { requested: 0, applied: 0, failed: 0, unclaimed: 0 });
  });
});

describe("apply and reject wording", () => {
  it("never claims an unclaimed row was applied or rejected elsewhere", () => {
    // `requested - (applied + failed)` means "this run did not claim it". The
    // row may be mid-flight in another apply, may have failed earlier, or may
    // not exist — so the sentence may not assert a resolution.
    const { tone, message } = describeApplyOutcome({
      requested: 2,
      applied: 0,
      failed: 0,
      unclaimed: 2,
    });

    assert.equal(tone, "warn");
    assert.match(message, /None of the 2 changes could be claimed/);
    // "may": the row could equally be mid-apply in another run.
    assert.match(message, /may already have been applied or rejected elsewhere/);
    assert.match(message, /another run may still be applying them/);
    assert.equal(/were already (applied|resolved)/.test(message), false);
  });

  it("labels a partial apply by what this run claimed", () => {
    const { message } = describeApplyOutcome({
      requested: 3,
      applied: 2,
      failed: 0,
      unclaimed: 1,
    });
    assert.match(message, /Applied 2 changes to Gmail/);
    assert.match(message, /1 not claimed by this run/);
  });

  it("reports a clean apply as a success", () => {
    const { tone, message } = describeApplyOutcome({
      requested: 2,
      applied: 2,
      failed: 0,
      unclaimed: 0,
    });
    assert.equal(tone, "success");
    assert.equal(message, "Applied 2 changes to Gmail");
  });

  it("says what the reject actually claimed", () => {
    assert.equal(
      describeRejectOutcome({ requested: 2, rejected: 2, unclaimed: 0 }),
      "Rejected 2 pending changes.",
    );
    const partial = describeRejectOutcome({ requested: 2, rejected: 1, unclaimed: 1 });
    assert.match(partial, /Rejected 1 pending change\./);
    assert.match(partial, /could not be claimed/);
  });
});

describe("committing review decisions", () => {
  function apply(ids: string[], overrides: Partial<ApplyOutcome> = {}): ApplyOutcome {
    return {
      requested: ids.length,
      applied: ids.length,
      failed: 0,
      unclaimed: 0,
      ...overrides,
    };
  }

  function reject(ids: string[], overrides: Partial<RejectOutcome> = {}): RejectOutcome {
    return { requested: ids.length, rejected: ids.length, unclaimed: 0, ...overrides };
  }

  function tracker() {
    const order: string[] = [];
    return {
      order,
      applyIds: async (ids: string[]) => {
        order.push(`apply:${ids.join(",")}`);
        return apply(ids);
      },
      rejectIds: async (ids: string[]) => {
        order.push(`reject:${ids.join(",")}`);
        return reject(ids);
      },
    };
  }

  it("records rejections before it touches Gmail", async () => {
    const handlers = tracker();
    await commitReviewDecisions({ approved: ["a"], rejected: ["b"] }, handlers);
    assert.deepEqual(handlers.order, ["reject:b", "apply:a"]);
  });

  it("keeps the user's rejections when the apply throws mid-batch", async () => {
    const order: string[] = [];
    const commit = await commitReviewDecisions(
      { approved: ["a", "b"], rejected: ["c"] },
      {
        rejectIds: async (ids) => {
          order.push(`reject:${ids.join(",")}`);
          return reject(ids);
        },
        applyIds: async () => {
          throw new Error("network down");
        },
      },
    );

    // The rejection ran, and it ran first — the regression this covers is the
    // old order, where the throw happened before any "no" was written.
    assert.deepEqual(order, ["reject:c"]);
    assert.equal(commit.rejectError, undefined);
    assert.equal((commit.applyError as Error).message, "network down");
  });

  it("still applies approvals when recording rejections fails", async () => {
    const order: string[] = [];
    const commit = await commitReviewDecisions(
      { approved: ["a"], rejected: ["b"] },
      {
        rejectIds: async () => {
          throw new Error("db locked");
        },
        applyIds: async (ids) => {
          order.push(`apply:${ids.join(",")}`);
          return apply(ids);
        },
      },
    );

    assert.deepEqual(order, ["apply:a"]);
    assert.equal((commit.rejectError as Error).message, "db locked");
    assert.equal(commit.applyError, undefined);
  });

  it("says nothing at all when both halves succeed", async () => {
    const commit = await commitReviewDecisions(
      { approved: ["a"], rejected: ["b"] },
      tracker(),
    );
    assert.deepEqual(describeReviewCommit(commit), []);
  });

  it("tells the user their rejections survived an apply failure", () => {
    const lines = describeReviewCommit({
      approvedIds: ["a", "b"],
      rejectedIds: ["c"],
      rejectOutcome: { requested: 1, rejected: 1, unclaimed: 0 },
      applyError: new Error("network down"),
    });

    const text = lines.join("\n");
    assert.match(text, /Failed to apply 2 approved changes: network down/);
    assert.match(text, /Your 1 rejection was recorded before the apply ran/);
  });

  it("does not claim a rejection was recorded when nothing was claimed", () => {
    // Another tab claimed the row first, so `rejectPendingOperationsByIds`
    // returned 0. Reporting off the REQUESTED ids used to print "Your 1
    // rejection was already recorded" about a row that may have been mid-apply.
    const text = describeReviewCommit({
      approvedIds: ["a"],
      rejectedIds: ["c"],
      rejectOutcome: { requested: 1, rejected: 0, unclaimed: 1 },
      applyError: new Error("network down"),
    }).join("\n");

    assert.equal(text.includes("already recorded"), false);
    assert.equal(text.includes("was recorded before the apply ran"), false);
    assert.match(text, /None of your 1 rejection could be recorded/);
    assert.match(text, /another\s+run had already claimed or resolved it/);
  });

  it("reports a partly-claimed reject by the number actually recorded", () => {
    const text = describeReviewCommit({
      approvedIds: ["a"],
      rejectedIds: ["c", "d", "e"],
      rejectOutcome: { requested: 3, rejected: 2, unclaimed: 1 },
      applyError: new Error("network down"),
    }).join("\n");

    assert.match(text, /2 of your 3 rejections were recorded/);
    assert.match(text, /the other 1 could not be claimed/);
  });

  it("never says the unapplied changes stay queued after an apply failure", () => {
    // Core claims rows as `applying` BEFORE it calls Gmail, and the write-back
    // that resolves them can itself fail, so rows can be left in a state
    // `approvals list` does not show. "The rest stay queued" was an assertion
    // the CLI had no way to make.
    const text = describeReviewCommit({
      approvedIds: ["a", "b"],
      rejectedIds: [],
      applyError: new Error("network down"),
    }).join("\n");

    assert.equal(text.includes("stay queued"), false);
    assert.match(text, /Their state could not be confirmed/);
    assert.match(text, /left mid-apply/);
    assert.match(text, /approvals\s+list/);
  });

  it("does not claim rejections were recorded when the reject itself failed", () => {
    const text = describeReviewCommit({
      approvedIds: ["a"],
      rejectedIds: ["c"],
      rejectError: new Error("db locked"),
      applyError: new Error("network down"),
    }).join("\n");

    assert.match(text, /Failed to record 1 rejection: db locked/);
    assert.match(text, /Their state could not be confirmed/);
    assert.equal(text.includes("already recorded"), false);
    assert.equal(text.includes("was recorded before the apply ran"), false);
  });

  it("fails the command on a Gmail failure that never threw", () => {
    // The `approvals apply` regression: core reports per-operation Gmail
    // errors as `failed` and resolves, so nothing was thrown and the command
    // exited 0 while printing "1 failed".
    assert.equal(
      commitFailed({
        approvedIds: ["a"],
        rejectedIds: [],
        applyOutcome: { requested: 1, applied: 0, failed: 1, unclaimed: 0 },
      }),
      true,
    );
    assert.equal(
      commitFailed({
        approvedIds: ["a"],
        rejectedIds: [],
        applyOutcome: { requested: 1, applied: 1, failed: 0, unclaimed: 0 },
      }),
      false,
    );
    assert.equal(
      commitFailed({ approvedIds: [], rejectedIds: ["b"], rejectError: new Error("x") }),
      true,
    );
  });
});

describe("stranded rows (`approvals stranded`)", () => {
  const NOW = new Date("2026-08-07T12:00:00.000Z");

  it("states the uncertainty, and that the CLI has not and cannot check", () => {
    const [headline, explanation, footnote] = describeStrandedHeader(2);
    assert.ok(headline?.includes("we do not know whether they reached Gmail"));
    assert.ok(explanation?.includes("has not checked and it cannot"));
    assert.ok(/open gmail, look/i.test(explanation ?? ""));
    // These rows are `applying`; every other approvals command lists `pending`.
    assert.ok(footnote?.includes("`approvals list`, `apply` and `reject` do not see them"));
  });

  it("agrees with the singular", () => {
    const [headline] = describeStrandedHeader(1);
    assert.ok(headline?.includes("1 Gmail change is stuck mid-apply"));
    assert.ok(headline?.includes("whether it reached Gmail"));
  });

  it("ages a row down to the minute and survives an unparsable stamp", () => {
    assert.equal(describeStrandedAge("2026-08-07T11:00:00.000Z", NOW), "stuck for 1 hour");
    assert.equal(describeStrandedAge("2026-08-06T11:59:00.000Z", NOW), "stuck for 1 day");
    assert.equal(describeStrandedAge("", NOW), "stuck for an unknown length of time");
  });

  it("records the user's word, never a verification", () => {
    const applied = describeStrandedResolution("applied", 1, 1);
    assert.ok(applied.includes("on your word"));
    assert.ok(applied.includes("did not check Gmail"));

    const requeued = describeStrandedResolution("notApplied", 2, 2);
    assert.ok(requeued.includes("back in the approval queue"));
    assert.ok(requeued.includes("on your word"));
  });

  it("keeps whatever was already recorded when the answer arrives too late", () => {
    // The ids came from a snapshot; the row may have moved on since.
    assert.ok(
      describeStrandedResolution("applied", 1, 0).includes(
        "whatever was already recorded stayed",
      ),
    );
    assert.ok(
      describeStrandedResolution("applied", 3, 2).includes("1 row was not written"),
    );
  });

  it("never states a cause for a skipped row as fact", () => {
    // The regression: the wording said an apply that was still running had
    // finished the row "and the outcome it recorded was kept". A row can
    // equally have been answered by another adjudication — in which case what
    // was kept is another person's unverified assertion, not a real apply's
    // record — or have been requeued and re-claimed, which makes it too new to
    // adjudicate at all. Same rule `describeApplyOutcome` already follows.
    for (const message of [
      describeStrandedResolution("applied", 1, 0),
      describeStrandedResolution("notApplied", 2, 1),
    ]) {
      assert.ok(message.includes("may have finished"), message);
      assert.ok(message.includes("another answer"), message);
      assert.ok(message.includes("requeued"), message);
      assert.equal(message.includes("has since finished"), false, message);
      assert.equal(message.includes("the outcome it recorded was kept"), false, message);
      assert.equal(message.includes("real outcome was kept"), false, message);
    }
  });
});

// ---------------------------------------------------------------------------
// The abort wording
// ---------------------------------------------------------------------------
//
// Pure for the same reason every other sentence in this file is: it makes a
// PROMISE — that nothing was written — and that promise is the entire value of
// aborting. A wording that hedged it would undo the guarantee even though the
// code kept it. It cannot be reached by the e2e tests, because `^C` is not
// something a pipe can deliver (see `prompt.ts` on why the piped case is
// covered by the process dying instead).

describe("describeAbortedReview", () => {
  it("promises both halves: nothing applied AND nothing rejected", () => {
    const message = describeAbortedReview(3);
    assert.match(message, /nothing was applied to Gmail/i);
    assert.match(message, /nothing was rejected/i);
  });

  it("says the changes are still queued, and how to come back to them", () => {
    // The reason an abort is cheap. A user who is told only "aborted" does not
    // know whether their queue survived.
    const message = describeAbortedReview(3);
    assert.match(message, /All 3 changes are still queued/);
    assert.match(message, /approvals review/);
  });

  it("reads correctly for a single change", () => {
    assert.match(describeAbortedReview(1), /The change is still queued/);
  });
});
