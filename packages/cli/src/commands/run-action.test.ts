import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { ActionRunResult } from "@email-agent/core";
import { describeRunOutcome } from "./run-action.js";

function result(overrides: Partial<ActionRunResult> = {}): ActionRunResult {
  return {
    actionId: "junk",
    status: "success",
    agentUsed: "claude",
    tokensUsed: 0,
    durationMs: 1,
    ...overrides,
  };
}

function text(lines: ReturnType<typeof describeRunOutcome>): string {
  return lines.map((line) => line.text).join("\n");
}

// The string core builds for an auto-apply that threw. Copied rather than
// imported so a change on either side is caught: the point of this branch is
// that the user reads core's wording unedited.
const AUTO_APPLY_FAILURE =
  'Auto-apply failed after the changes were queued: socket hang up. Some Gmail changes may ' +
  'already have been applied; their outcome could not be recorded. Review the approval queue ' +
  'for operations stuck in "applying" before re-running this action.';

describe("run-action outcome wording", () => {
  it("never says 'nothing was applied' when auto-apply threw after claiming rows", () => {
    // The shape core really returns here: rows queued fine (so `queueError` is
    // unset and `pendingOperations` is populated) and the apply threw after
    // claiming them. The CLI read only `queueError`, so on a single-chunk abort
    // it printed "nothing was applied" and on a multi-chunk abort it offered to
    // apply the remaining ids — both about mail that may really be in Trash.
    const lines = describeRunOutcome(
      result({
        pendingOperations: [{ emailId: "m1", type: "trash" }],
        batchId: "b1",
        applyError: AUTO_APPLY_FAILURE,
      }),
    );

    const printed = text(lines);
    assert.ok(printed.includes(AUTO_APPLY_FAILURE), "core's wording must reach the user verbatim");
    assert.equal(/nothing was applied/i.test(printed), false, printed);
    assert.equal(/await/i.test(printed), false, printed);
    assert.ok(printed.includes("approvals stranded"), "must point at the adjudication command");
    assert.equal(lines[0]?.tone, "error");
  });

  it("still says nothing was applied for a pre-Gmail queue failure", () => {
    const printed = text(describeRunOutcome(result({ queueError: "table is locked" })));
    assert.ok(printed.includes("could not be queued for approval — nothing was applied"));
    assert.ok(printed.includes("table is locked"));
  });

  it("prints core's unrecorded-batch sentence once", () => {
    const core =
      "The action result could not be recorded (disk full), so its Gmail changes were not " +
      "queued. Nothing was applied — re-run the action to propose them again.";
    const printed = text(
      describeRunOutcome(result({ queueError: core, persistError: "disk full" })),
    );
    assert.equal(printed.trim(), core);
    assert.equal(printed.match(/Nothing was applied/gi)?.length, 1);
  });

  it("surfaces a persist failure that queued nothing", () => {
    const printed = text(describeRunOutcome(result({ persistError: "disk full" })));
    assert.ok(printed.includes("could not be saved to history"));
    assert.ok(printed.includes("disk full"));
    assert.ok(printed.includes("nothing was applied"));
  });

  it("explains duplicates rather than silently queueing fewer rows", () => {
    const printed = text(
      describeRunOutcome(
        result({ pendingOperations: [{ emailId: "m1", type: "trash" }], duplicateOperations: 3 }),
      ),
    );
    assert.ok(printed.includes("3 identical changes were already awaiting approval"));

    const one = text(describeRunOutcome(result({ duplicateOperations: 1 })));
    assert.ok(one.includes("1 identical change was already awaiting approval"));
  });

  it("keeps the auto-apply notice, and says nothing at all for a plain run", () => {
    const printed = text(
      describeRunOutcome(
        result({ applyResult: { applied: 2, failed: 1, errors: [], outcomes: [] } }),
      ),
    );
    assert.ok(printed.includes("Auto-apply is ON — applied 2 Gmail changes without asking, 1 failed"));

    assert.deepEqual(describeRunOutcome(result({})), []);
  });
});
