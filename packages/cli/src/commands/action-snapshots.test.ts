import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { originalFilenameFromSnapshot } from "./action-snapshots.js";

describe("action snapshot filenames", () => {
  it("recovers the action a snapshot belongs to", () => {
    assert.equal(
      originalFilenameFromSnapshot("junk.action.ts.2026-02-28T12-00-00-000Z.ts"),
      "junk.action.ts",
    );
    assert.equal(
      originalFilenameFromSnapshot("legacy.action.js.2026-02-28T12-00-00-000Z.ts"),
      "legacy.action.js",
    );
  });

  it("returns undefined for anything that is not a snapshot name", () => {
    assert.equal(originalFilenameFromSnapshot("junk.action.ts"), undefined);
    assert.equal(originalFilenameFromSnapshot("notes.ts"), undefined);
    assert.equal(originalFilenameFromSnapshot("junk.action.ts.ts"), undefined);
  });

  it("does not sanitize — core's normalizers are the path guard", () => {
    // Deliberate: this helper only parses the name shape. `restoreSnapshot`
    // runs both halves through `normalizeSnapshotFilename` /
    // `normalizeUserActionFilename`, which is where traversal is refused, so
    // duplicating that check here would create a second place to keep in sync.
    assert.equal(
      originalFilenameFromSnapshot("../escape.action.ts.2026-01-01T00-00-00-000Z.ts"),
      "../escape.action.ts",
    );
  });
});
