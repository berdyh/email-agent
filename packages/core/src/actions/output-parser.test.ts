import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseActionOutput } from "./output-parser.js";

describe("parseActionOutput", () => {
  it("extracts a JSON array from agent prose", () => {
    const output = parseActionOutput(
      'Here is the result:\n[{"emailId":"a","recommendation":"spam"}]',
      ["a"],
    );

    assert.equal(output.rawText.includes("Here is the result"), true);
    assert.deepEqual(output.results, [
      { emailId: "a", recommendation: "spam" },
    ]);
  });

  it("falls back to one raw result per requested email when JSON is invalid", () => {
    const output = parseActionOutput("not json", ["a", "b"]);

    assert.deepEqual(output.results, [
      { emailId: "a", rawResult: "not json" },
      { emailId: "b", rawResult: "not json" },
    ]);
  });
});
