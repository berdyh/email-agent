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

describe("honest failure wording", () => {
  it("never claims nothing was applied when the auto-apply threw", () => {
    // The bug: auto-apply failures reused `queueError`, whose comment claimed
    // "the rows stay queued". `applyPendingOperationsByIds` claims rows BEFORE
    // any Gmail call, so it can also throw after every mutation completed —
    // and the surfaces printed "nothing was applied" for mail that had really
    // been trashed.
    const message = describeAutoApplyFailure("connection reset");
    assert.match(message, /may already have been applied/);
    assert.equal(/nothing was applied/i.test(message), false);
    assert.match(message, /connection reset/);
    // Point the user at the rows the crash stranded.
    assert.match(message, /applying/);
  });

  it("does state plainly that nothing happened when the batch was never recorded", () => {
    // This one CAN be definite: queueing is skipped, so Gmail is untouched.
    const message = describeUnrecordedBatchFailure("disk full");
    assert.match(message, /Nothing was applied/);
    assert.match(message, /not queued/);
    assert.match(message, /disk full/);
  });
});
