import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeUserActionFilename,
  resolveUserActionFilePath,
} from "./user-action-paths.js";

describe("user action path helpers", () => {
  it("accepts only local .action.ts or .action.js filenames", () => {
    assert.equal(normalizeUserActionFilename("triage.action.ts"), "triage.action.ts");
    assert.equal(normalizeUserActionFilename("triage.action.js"), "triage.action.js");
  });

  it("rejects traversal, nested paths, and wrong suffixes", () => {
    assert.throws(() => normalizeUserActionFilename("../secret.action.ts"), /simple filename/);
    assert.throws(() => normalizeUserActionFilename("nested/secret.action.ts"), /simple filename/);
    assert.throws(() => normalizeUserActionFilename("secret.ts"), /\.action\.(ts|js)$/);
  });

  it("resolves files inside the configured actions directory", () => {
    const resolved = resolveUserActionFilePath("/tmp/actions", "triage.action.ts");

    assert.equal(resolved, "/tmp/actions/triage.action.ts");
  });
});
