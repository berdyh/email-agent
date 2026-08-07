import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeActionRunOutcome,
  describeDuplicateOperations,
} from "./action-run-contract.js";

// The exact string core builds for an auto-apply that threw. Copied rather than
// imported so this test fails if either side changes independently — the point
// of the branch is that the user reads core's wording, unedited.
const AUTO_APPLY_FAILURE =
  'Auto-apply failed after the changes were queued: socket hang up. Some Gmail changes may ' +
  'already have been applied; their outcome could not be recorded. Review the approval queue ' +
  'for operations stuck in "applying" before re-running this action.';

describe("action run wording", () => {
  it("reports an auto-apply failure as 'may already have been applied', never as awaiting approval", () => {
    // The shape core really returns on this path: the rows queued fine, so
    // `pendingOperations` and `batchId` are populated and `queueError` is unset.
    // The page used to read only `queueError`, fall through, and announce the
    // now-`applying` rows as awaiting approval.
    const { tone, message } = describeActionRunOutcome("Junk cleanup", {
      pendingOperations: [{}, {}, {}],
      applyError: AUTO_APPLY_FAILURE,
    });

    assert.equal(tone, "error");
    assert.ok(message.includes(AUTO_APPLY_FAILURE), "core's wording must reach the user verbatim");
    assert.ok(message.includes("Junk cleanup"));
    assert.ok(!/await/i.test(message), `must not claim the rows await approval: ${message}`);
    assert.ok(!/nothing was applied/i.test(message), `must not claim nothing happened: ${message}`);
  });

  it("prints a queue failure with the reason, and says nothing was applied", () => {
    const { tone, message } = describeActionRunOutcome("Junk cleanup", {
      queueError: "table is locked",
    });
    assert.equal(tone, "error");
    assert.ok(message.includes("nothing was applied"));
    assert.ok(message.includes("table is locked"));
  });

  it("prints core's unrecorded-batch sentence once, without repeating its claim", () => {
    const core =
      "The action result could not be recorded (disk full), so its Gmail changes were not " +
      "queued. Nothing was applied — re-run the action to propose them again.";
    const { tone, message } = describeActionRunOutcome("Junk cleanup", {
      queueError: core,
      persistError: "disk full",
    });
    assert.equal(tone, "error");
    assert.equal(message, `“Junk cleanup”: ${core}`);
    assert.equal(message.match(/Nothing was applied/gi)?.length, 1);
  });

  it("surfaces a persist failure that queued nothing", () => {
    const { tone, message } = describeActionRunOutcome("Digest", {
      persistError: "disk full",
    });
    assert.equal(tone, "warning");
    assert.ok(message.includes("could not be saved to history"));
    assert.ok(message.includes("disk full"));
    assert.ok(message.includes("nothing was applied"));
  });

  it("names duplicates so the queue showing fewer rows is explained", () => {
    const { tone, message } = describeActionRunOutcome("Junk cleanup", {
      pendingOperations: [{}],
      duplicateOperations: 3,
    });
    assert.equal(tone, "success");
    assert.ok(message.includes("1 Gmail change awaits your approval"));
    assert.ok(message.includes("3 identical changes were already awaiting approval"));
  });

  it("explains a run whose every proposal was already queued", () => {
    const { message } = describeActionRunOutcome("Junk cleanup", {
      pendingOperations: [],
      duplicateOperations: 2,
    });
    assert.ok(message.includes("no new Gmail changes were queued"));
    assert.ok(message.includes("2 identical changes were already awaiting approval"));
  });

  it("keeps the auto-applied and plain-success wording", () => {
    const applied = describeActionRunOutcome("Junk cleanup", {
      applyResult: { applied: 4, failed: 1 },
    });
    assert.equal(applied.tone, "warning");
    assert.ok(applied.message.includes("auto-applied 4 Gmail changes, 1 failed"));

    const plain = describeActionRunOutcome("Digest", {});
    assert.equal(plain.tone, "success");
    assert.equal(plain.message, "Action “Digest” completed");
  });

  it("agrees with itself on singular and plural duplicates", () => {
    assert.equal(
      describeDuplicateOperations(1),
      "1 identical change was already awaiting approval and was not queued again",
    );
    assert.equal(
      describeDuplicateOperations(2),
      "2 identical changes were already awaiting approval and were not queued again",
    );
  });
});
