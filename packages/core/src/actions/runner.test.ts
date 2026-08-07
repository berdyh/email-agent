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
  // These assert the text these two builders return. They do NOT reach any
  // surface, and therefore do NOT pin what a user is told when an auto-apply
  // fails.
  //
  // `describeAutoApplyFailure` is assigned to `ActionRunResult.applyError`,
  // which nothing reads: the web result type omits the field. What the
  // surfaces do instead is NOT "print the `queueError` copy" — on an auto-apply
  // failure `queueError` is unset, because the rows queued fine.
  // `packages/web/src/app/actions/page.tsx` falls through to its success branch
  // and reports "N changes await your approval" for rows that are now
  // `applying`; `packages/cli/src/commands/run-action.ts` prompts on whatever
  // is still `status: "pending"` for the batch, printing "nothing was applied"
  // only when nothing is left pending, and otherwise offering to apply the
  // later ids without mentioning the chunk that may already have hit Gmail.
  // Either way the user is not told that mail may really have been trashed.
  // Only the adoption pass tracked in TODOS.md ("⚠ THE SURFACES WAVE", item 1)
  // can make this string reach anyone, and only a test that goes through a
  // surface can pin it.
  //
  // `describeUnrecordedBatchFailure` is the exception: it is assigned to
  // `queueError`, which the surfaces do read, so its text does reach the user.

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
