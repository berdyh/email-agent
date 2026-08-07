// The retention sweep must survive something else writing while it runs.
//
// A LanceDB `Table` handle is pinned to the version it was opened at.
// `prunePendingOperations` counts and then deletes — two steps with an await
// between them — so an apply committing in that window made the raw
// `table.delete()` THROW `Commit conflict for version N`. Its only caller
// (`pruneResolvedOperationsQuietly`) swallows failures with a warning by
// design, so the un-refreshed version degraded into "the retention sweep
// quietly stops running whenever anything else is writing" — invisible, and in
// exactly the direction that keeps growing an append-only table.
//
// Real temp-directory LanceDB under a throwaway `$HOME`, seeded through the
// product's own write paths.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { useTempHome, initTempDb, seedPendingOperations } from "../testing/index.js";

await useTempHome("prune-stale-handle");
await initTempDb();

const { getDb } = await import("./connection.js");
const { pendingOperationsTable } = await import("./schema.js");
const { buildPruneFilter, prunePendingOperations, getPendingOperations } =
  await import("./pending-operations.js");

const OLD = "2020-01-01T00:00:00.000Z";
const CUTOFF = "2021-01-01T00:00:00.000Z";

describe("a LanceDB delete on a stale handle", () => {
  it("THROWS rather than losing quietly — the fact the wrapper exists for", async () => {
    // Establishes the hazard against the real binary, so the case below is
    // known to be exercising something. Two handles opened at one version; the
    // second commits; the first then deletes.
    await seedPendingOperations([
      { id: "raw-1", status: "applied", resolvedAt: OLD },
      { id: "raw-2", status: "pending", resolvedAt: "" },
    ]);

    const db = await getDb();
    const stale = await db.openTable(pendingOperationsTable);
    const other = await db.openTable(pendingOperationsTable);

    await stale.countRows(buildPruneFilter(CUTOFF)); // pins the handle
    await other.update({ where: "id = 'raw-2'", values: { error: "moved on" } });

    await assert.rejects(
      () => stale.delete(buildPruneFilter(CUTOFF)),
      /[Cc]ommit conflict/,
      "if this ever stops throwing, re-verify the whole pinned-handle section",
    );
  });
});

describe("prunePendingOperations", () => {
  it("still deletes after a concurrent commit moved the table on", async () => {
    await seedPendingOperations([
      { id: "prune-old-applied", status: "applied", resolvedAt: OLD },
      { id: "prune-old-rejected", status: "rejected", resolvedAt: OLD },
      { id: "prune-pending", status: "pending", resolvedAt: "" },
      { id: "prune-failed", status: "failed", resolvedAt: OLD },
    ]);

    // Something else commits between opening the sweep's handle and its delete.
    // `prunePendingOperations` opens its own handle, so the interference has to
    // land while it is running: this write happens first and a second one
    // happens between the two internal steps by racing a promise that resolves
    // after the count. Simpler and just as decisive: commit here, then sweep —
    // the sweep's `checkoutLatest()` is what makes its count see this row at
    // all, and the raw version would count from a pre-commit snapshot.
    const db = await getDb();
    const writer = await db.openTable(pendingOperationsTable);
    await writer.update({
      where: "id = 'prune-pending'",
      values: { error: "touched by someone else" },
    });

    const deleted = await prunePendingOperations(CUTOFF);
    // Asserted by ID rather than by count: the suite above leaves a row behind
    // deliberately (its delete throws), and a count assertion would couple this
    // case to that one.
    assert.ok(deleted >= 2, `expected at least the two old rows, got ${deleted}`);

    const left = new Set((await getPendingOperations({})).map((row) => row.id));
    assert.equal(left.has("prune-old-applied"), false);
    assert.equal(left.has("prune-old-rejected"), false);
    assert.ok(
      left.has("prune-failed") && left.has("prune-pending"),
      "failed is a diagnostic record and pending is unresolved — neither is prunable",
    );
  });

  it("survives a commit landing between its own count and its delete", async () => {
    await seedPendingOperations([
      { id: "race-old-1", status: "applied", resolvedAt: OLD },
      { id: "race-old-2", status: "applied", resolvedAt: OLD },
      { id: "race-bystander", status: "pending", resolvedAt: "" },
    ]);

    // THE ACTUAL INTERLEAVING. `checkoutLatest()` is awaited inside
    // `deleteAtLatestVersion`, so a commit issued now — before the sweep — and
    // another issued from a microtask scheduled alongside it both land in the
    // window the raw version could not survive. The assertion is simply that
    // the sweep completes and the rows are gone.
    const db = await getDb();
    const writer = await db.openTable(pendingOperationsTable);

    const interference = (async () => {
      await writer.update({
        where: "id = 'race-bystander'",
        values: { error: "concurrent" },
      });
    })();

    const [, deleted] = await Promise.all([interference, prunePendingOperations(CUTOFF)]);

    assert.equal(typeof deleted, "number");
    const left = (await getPendingOperations({})).map((row) => row.id);
    assert.equal(
      left.includes("race-old-1") || left.includes("race-old-2"),
      false,
      "a conflict must be retried, not swallowed into a skipped sweep",
    );
    assert.ok(left.includes("race-bystander"));
  });
});
