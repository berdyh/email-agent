// SCOPE: these cover the PURE helpers only — the column probe and the row
// projection. They map in-memory objects and never touch LanceDB, so nothing
// here says anything about the read → snapshot → drop → create → add sequence
// that consumes them. That sequence, its crash recovery and its lock are
// covered against a real temp-directory LanceDB in
// `pending-operations-migration.test.ts`; this file is not a substitute for it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  missingColumns,
  projectRowToSchema,
  projectRowsToSchema,
} from "./migrations.js";

describe("column probe", () => {
  it("reports only the columns the table on disk lacks", () => {
    assert.deepEqual(
      missingColumns(["id", "status"], ["id", "status", "claimToken", "claimedAt"]),
      ["claimToken", "claimedAt"],
    );
  });

  it("reports nothing for an up-to-date table", () => {
    assert.deepEqual(missingColumns(["id", "status"], ["id", "status"]), []);
  });

  it("ignores extra columns the current schema no longer declares", () => {
    // A dropped column is not a reason to migrate; the projection below is
    // what keeps it out of the re-insert.
    assert.deepEqual(missingColumns(["id", "legacy"], ["id"]), []);
  });
});

describe("row projection helper for a drop/recreate migration (pure)", () => {
  const fields = ["id", "status", "claimToken", "claimedAt"];
  const defaults = { claimToken: "", claimedAt: "" };

  it("preserves existing values and fills the new columns", () => {
    assert.deepEqual(
      projectRowToSchema({ id: "op-1", status: "applied" }, fields, defaults),
      { id: "op-1", status: "applied", claimToken: "", claimedAt: "" },
    );
  });

  it("drops columns the current schema does not declare", () => {
    // LanceDB rejects an add() carrying fields the schema has no place for.
    assert.deepEqual(
      projectRowToSchema(
        { id: "op-1", status: "rejected", legacyColumn: "gone" },
        fields,
        defaults,
      ),
      { id: "op-1", status: "rejected", claimToken: "", claimedAt: "" },
    );
  });

  it("treats a null or undefined stored value as absent", () => {
    assert.deepEqual(
      projectRowToSchema(
        { id: "op-1", status: "applied", claimToken: null, claimedAt: undefined },
        fields,
        defaults,
      ),
      { id: "op-1", status: "applied", claimToken: "", claimedAt: "" },
    );
  });

  it("refuses to invent a value for a column with no migration default", () => {
    // Guessing at an audit-trail row is worse than refusing to migrate, and a
    // null in a non-nullable Arrow field fails later with a message that says
    // nothing about which migration produced it.
    assert.throws(
      () => projectRowToSchema({ status: "applied" }, fields, defaults),
      /column "id" is absent and has no migration default/,
    );
  });

  it("projects every row's status through unchanged", () => {
    // NOT a claim that the migration preserves the audit trail — this maps
    // three plain objects and never runs a migration. It pins only that the
    // projection is status-blind and fills the new columns. The preservation
    // claim is tested for real in `pending-operations-migration.test.ts`.
    const rows = [
      { id: "a", status: "applied" },
      { id: "b", status: "rejected" },
      { id: "c", status: "pending" },
    ];
    const migrated = projectRowsToSchema(rows, fields, defaults);
    assert.deepEqual(
      migrated.map((row) => row["status"]),
      ["applied", "rejected", "pending"],
    );
    // Queued rows come back unclaimed, i.e. exactly as a fresh enqueue writes
    // them — nothing is silently approved by the migration.
    assert.equal(migrated[2]?.["claimToken"], "");
    assert.equal(migrated[2]?.["claimedAt"], "");
  });

  it("handles an empty legacy table", () => {
    assert.deepEqual(projectRowsToSchema([], fields, defaults), []);
  });
});
