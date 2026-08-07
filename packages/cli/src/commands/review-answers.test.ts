// The answer classification that used to be inlined in the two review loops,
// where no test could reach it without a terminal.
//
// The thing worth pinning is not the happy keys — it is the DEFAULT. Both
// loops mutate the user's mailbox on `y`, so a table that quietly widened
// "unrecognised" into "approve" would be the worst possible bug in this
// codebase, and the only way to see it is to enumerate what unrecognised
// actually covers.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyReviewAnswer,
  classifyStrandedAnswer,
  confirmedYes,
} from "./approvals.js";

/** Everything that is not a recognised key, including the empty answer. */
const UNRECOGNISED = ["", " ", "s", "S", "skip", "x", "yes", "no", "Y E S", "1", "\t"];

describe("classifyReviewAnswer", () => {
  it("recognises the four documented keys, case- and whitespace-insensitively", () => {
    assert.equal(classifyReviewAnswer("y"), "approve");
    assert.equal(classifyReviewAnswer("Y"), "approve");
    assert.equal(classifyReviewAnswer("  y  "), "approve");
    assert.equal(classifyReviewAnswer("n"), "reject");
    assert.equal(classifyReviewAnswer("N\n".trim()), "reject");
    assert.equal(classifyReviewAnswer("q"), "stop");
    assert.equal(classifyReviewAnswer("Q"), "stop");
  });

  it("keeps the change queued for anything else — never approves, never rejects", () => {
    for (const answer of UNRECOGNISED) {
      assert.equal(
        classifyReviewAnswer(answer),
        "skip",
        `${JSON.stringify(answer)} must not be a decision`,
      );
    }
    // "yes" in particular: it LOOKS like consent and is not `y`. Trashing mail
    // on a near miss is worse than asking again.
    assert.equal(classifyReviewAnswer("yes"), "skip");
  });

  it("treats EOF as `q` — stop asking, keep what was already decided", () => {
    // `null` is the input ending, not a keystroke. Anything other than "stop"
    // here reintroduces the bug where a piped review discarded every answer.
    assert.equal(classifyReviewAnswer(null), "stop");
  });
});

describe("classifyStrandedAnswer", () => {
  it("recognises the only two answers a person can actually give", () => {
    assert.equal(classifyStrandedAnswer("y"), "applied");
    assert.equal(classifyStrandedAnswer("  N "), "notApplied");
  });

  it("skips on anything else, and on EOF, leaving the row exactly as it was", () => {
    for (const answer of [...UNRECOGNISED, "q"]) {
      assert.equal(classifyStrandedAnswer(answer), "skip");
    }
    assert.equal(classifyStrandedAnswer(null), "skip");
  });

  it("has no retry answer, deliberately", () => {
    // Core claims the row before it mutates, so re-applying could be a second
    // trash of an already-trashed message and no check distinguishes "we did
    // this" from "it was already like that".
    assert.equal(classifyStrandedAnswer("r"), "skip");
    assert.equal(classifyStrandedAnswer("retry"), "skip");
  });
});

describe("confirmedYes", () => {
  it("accepts only `y`", () => {
    assert.equal(confirmedYes("y"), true);
    assert.equal(confirmedYes(" Y \n".trim()), true);
    for (const answer of ["", "n", "yes", "ok", "1"]) {
      assert.equal(confirmedYes(answer), false, `${JSON.stringify(answer)}`);
    }
  });

  it("treats EOF as No, which is what the [y/N] prompt already promised", () => {
    assert.equal(confirmedYes(null), false);
  });
});
