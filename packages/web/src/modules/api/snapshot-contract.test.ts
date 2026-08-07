import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeSnapshotAge,
  describeSnapshotRestoreFailure,
} from "./snapshot-contract.js";

describe("describeSnapshotRestoreFailure", () => {
  it("gives the specific rules for a source-guard refusal", () => {
    // THE CASE THIS EXISTS FOR. `restoreSnapshot` writes through
    // `saveUserAction`, which re-validates, so a snapshot taken before the
    // guard existed is refused. The CLI prints the rules; a web surface that
    // said "Failed to restore" would leave the user with an unrecoverable
    // action and nothing to act on.
    const failure = describeSnapshotRestoreFailure(422, {
      error: "junk.action.ts.2025-01-01T00-00-00-000Z.ts does not pass the action source guard.",
      violations: [
        { rule: "value-import", detail: "only `import type` is allowed (line 1:1)" },
        { rule: "computed-value", detail: "values may only be literals (line 4:7)" },
      ],
    });

    assert.match(failure.title, /source guard/);
    assert.equal(failure.details.length, 3, "one line per rule, plus the advice");
    assert.match(failure.details[0] ?? "", /value-import/);
    assert.match(failure.details[1] ?? "", /computed-value/);
    assert.match(failure.details[2] ?? "", /Nothing was changed/);
    assert.match(failure.details[2] ?? "", /by hand/);
  });

  it("still says nothing was changed for any other failure", () => {
    // The one fact a user needs before deciding what to try next, and it holds
    // on both branches because `restoreSnapshot` validates before writing.
    const failure = describeSnapshotRestoreFailure(500, {
      error: "Failed to restore action snapshot",
    });
    assert.equal(failure.title, "Failed to restore action snapshot");
    assert.deepEqual(failure.details, ["Nothing was changed."]);
  });

  it("does not claim rules it was not given", () => {
    // A 422 with no violations array must not render an empty rule list as if
    // the snapshot had been analysed.
    const failure = describeSnapshotRestoreFailure(422, { error: "nope" });
    assert.equal(failure.title, "nope");
    assert.deepEqual(failure.details, ["Nothing was changed."]);
  });

  it("falls back to a sentence rather than an empty title", () => {
    const failure = describeSnapshotRestoreFailure(500, { error: "" });
    assert.match(failure.title, /Failed to restore/);
  });
});

describe("describeSnapshotAge", () => {
  const now = new Date("2026-08-07T12:00:00.000Z");

  it("rounds down, in the units a person would use", () => {
    assert.equal(describeSnapshotAge("2026-08-07T11:59:30.000Z", now), "just now");
    assert.equal(describeSnapshotAge("2026-08-07T11:59:00.000Z", now), "1 minute ago");
    assert.equal(describeSnapshotAge("2026-08-07T11:30:00.000Z", now), "30 minutes ago");
    assert.equal(describeSnapshotAge("2026-08-07T09:00:00.000Z", now), "3 hours ago");
    assert.equal(describeSnapshotAge("2026-08-05T12:00:00.000Z", now), "2 days ago");
  });

  it("shows an unparseable stamp verbatim rather than `Invalid Date`", () => {
    // A hand-renamed snapshot must still be listed and restorable — the
    // timestamp is recovered from the filename and is not guaranteed to parse.
    assert.equal(describeSnapshotAge("not-a-timestamp", now), "not-a-timestamp");
  });
});
