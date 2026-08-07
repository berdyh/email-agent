// SCOPE: the PURE helpers only — the column probe and the addition builder.
// They map in-memory values and never touch LanceDB, so nothing here says
// anything about `addColumns` actually preserving rows. That claim is tested
// against a real temp-directory LanceDB in `schema-migration.test.ts`; this
// file is not a substitute for it.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildColumnAdditions, missingColumns } from "./migrations.js";

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
    // A column the schema dropped is not a reason to migrate. Nothing removes
    // it either: `addColumns` only adds, so a stale column is left in place
    // rather than being silently discarded by a table rewrite.
    assert.deepEqual(missingColumns(["id", "legacy"], ["id"]), []);
  });
});

describe("column addition builder (pure)", () => {
  const defaults = {
    claimToken: "CAST('' AS STRING)",
    claimedAt: "CAST('' AS STRING)",
  };

  it("pairs each absent column with its declared sentinel SQL", () => {
    assert.deepEqual(buildColumnAdditions(["claimToken", "claimedAt"], defaults), [
      { name: "claimToken", valueSql: "CAST('' AS STRING)" },
      { name: "claimedAt", valueSql: "CAST('' AS STRING)" },
    ]);
  });

  it("builds nothing for an up-to-date table", () => {
    assert.deepEqual(buildColumnAdditions([], defaults), []);
  });

  it("refuses to add a column that has no declared default", () => {
    // Filling an unknown column with NULL would put a null in a non-nullable
    // Arrow column and fail later with a message naming neither the table nor
    // the migration. A table missing `id` is not a legacy shape, it is a table
    // we do not recognise.
    assert.throws(
      () => buildColumnAdditions(["id"], defaults, "pending_operations"),
      /Cannot migrate pending_operations: column "id" is absent and has no migration default/,
    );
  });
});
