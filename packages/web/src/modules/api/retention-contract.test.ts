import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  describeRetentionWindow,
  parseRetentionDraft,
  retentionDraftIsEmpty,
} from "./retention-contract.js";

describe("approval-queue retention field", () => {
  it("does not read a cleared field as zero", () => {
    // The regression: `Number("")` is 0, and 0 means "keep every record
    // forever" here. Clearing the field flipped the helper text to that
    // sentence mid-edit, and saving at that moment wrote 0.
    assert.equal(parseRetentionDraft(""), null);
    assert.equal(parseRetentionDraft("   "), null);
    assert.equal(retentionDraftIsEmpty(""), true);
    assert.equal(retentionDraftIsEmpty("0"), false);
  });

  it("treats an unreadable value the same as an empty one", () => {
    // Both mean "there is no value to save", and neither may be silently
    // rounded into one.
    assert.equal(parseRetentionDraft("abc"), null);
    assert.equal(parseRetentionDraft("1e999"), null);
  });

  it("keeps 0 as a real, distinct setting", () => {
    assert.equal(parseRetentionDraft("0"), 0);
    assert.equal(parseRetentionDraft("365"), 365);
  });

  it("gives the empty state its own sentence", () => {
    const empty = describeRetentionWindow(null);
    assert.ok(empty.includes("The field is empty"));
    assert.ok(empty.includes("not being changed"));
    // It may POINT AT 0, but it must not claim to be 0 — that sentence is what
    // used to appear while the user was mid-keystroke.
    assert.equal(empty.includes("0 disables deletion"), false);
    assert.ok(empty.includes("Type 0 if you want"));

    assert.ok(describeRetentionWindow(0).startsWith("0 disables deletion"));
    assert.ok(describeRetentionWindow(365).includes("older than 365 days"));
  });

  it("states no default of its own", () => {
    // The page seeds the field from the settings response, which
    // `sanitizeSettingsForResponse` already fills from core's `defaultConfig`.
    // A literal here would be a second copy free to drift from it.
    assert.equal(describeRetentionWindow(null).includes("365"), false);
  });
});
