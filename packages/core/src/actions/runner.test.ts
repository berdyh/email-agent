import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  deriveResultAccountId,
  describeAutoApplyFailure,
  describeUnrecordedBatchFailure,
} from "./runner.js";

describe("deriveResultAccountId", () => {
  it("returns the single account when every processed email resolves to it", () => {
    assert.equal(
      deriveResultAccountId(
        ["m1", "m2"],
        new Map([
          ["m1", "me@example.com"],
          ["m2", "me@example.com"],
        ]),
      ),
      "me@example.com",
    );
  });

  it("returns '' when the batch spans several accounts", () => {
    assert.equal(
      deriveResultAccountId(
        ["m1", "m2"],
        new Map([
          ["m1", "me@example.com"],
          ["m2", "work@example.com"],
        ]),
      ),
      "",
    );
  });

  it("returns '' when a processed email is ambiguous across accounts", () => {
    assert.equal(
      deriveResultAccountId(
        ["m1", "m2"],
        new Map<string, string | null>([
          ["m1", "me@example.com"],
          ["m2", null],
        ]),
      ),
      "",
    );
  });

  it("returns '' when a processed email id is missing from the lookup", () => {
    assert.equal(
      deriveResultAccountId(["m1", "missing"], new Map([["m1", "me@example.com"]])),
      "",
    );
  });

  it("preserves a single legacy/ADC sentinel account id", () => {
    assert.equal(
      deriveResultAccountId(
        ["m1", "m2"],
        new Map([
          ["m1", ""],
          ["m2", ""],
        ]),
      ),
      "",
    );
  });

  it("returns '' when there is no lookup at all", () => {
    assert.equal(deriveResultAccountId(["m1"], undefined), "");
  });

  it("returns '' for an empty batch", () => {
    assert.equal(deriveResultAccountId([], new Map()), "");
  });
});

describe("failure-message builders (strings only — NOT the message users see)", () => {
  // SCOPE, stated plainly so nobody reads more into these than they check.
  // These assert the text these two builders return, and nothing else.
  //
  // Both strings DO now reach the user: `describeAutoApplyFailure` through
  // `applyError` and `describeUnrecordedBatchFailure` through `queueError`,
  // printed verbatim by `describeActionRunOutcome` (web) and
  // `describeRunOutcome` (CLI), each of which has its own tests. But no test
  // anywhere goes THROUGH a surface, so nothing here fails if the page stops
  // calling its formatter, if the command stops printing, or if a route drops
  // the field. That gap is tracked in TODOS.md under "THE SURFACES WAVE",
  // item 3, and needs the integration harness.

  it("builds an auto-apply message that never says nothing was applied", () => {
    // `applyPendingOperationsByIds` claims rows BEFORE any Gmail call, so it
    // can throw after every mutation completed. The string must not be
    // definite in either direction.
    const message = describeAutoApplyFailure("connection reset");
    assert.match(message, /may already have been applied/);
    assert.equal(/nothing was applied/i.test(message), false);
    assert.match(message, /connection reset/);
    // Point the user at the rows the crash stranded.
    assert.match(message, /applying/);
  });

  it("builds a definite message for a batch that was never recorded", () => {
    // This one CAN be definite: queueing is skipped, so Gmail is untouched.
    // It also actually reaches the user, via `queueError`.
    const message = describeUnrecordedBatchFailure("disk full");
    assert.match(message, /Nothing was applied/);
    assert.match(message, /not queued/);
    assert.match(message, /disk full/);
  });
});
