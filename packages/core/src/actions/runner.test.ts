import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveResultAccountId } from "./runner.js";

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
