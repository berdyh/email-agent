import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveAccountEmail } from "./client.js";

describe("Gmail account resolution", () => {
  it("preserves an explicit empty account id for gcloud ADC rows", async () => {
    assert.equal(await resolveAccountEmail(""), "");
  });
});
