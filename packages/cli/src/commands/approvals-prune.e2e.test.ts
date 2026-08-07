// `approvals prune` through the BUILT binary.
//
// WHY THE COMMAND EXISTS. `retention.approvalQueueDays` has been configurable
// since wave 7, but the sweep it governs ran only as a side effect of the next
// apply or reject and reported to nobody. A user could not answer "what has
// already been deleted from my audit trail, and what goes next?" — and a
// retention policy nothing can inspect is indistinguishable from data loss.
//
// Rows are seeded through the product's own write path and read back from the
// real table, so what is asserted is which rows survive, not what was printed.

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { startCli } from "../testing/cli-harness.js";

const cli = await startCli("approvals-prune");

/** Long enough ago to be outside any window these cases use. */
const ANCIENT = "2020-01-01T00:00:00.000Z";
const RECENT = new Date(Date.now() - 60_000).toISOString();

async function ids(): Promise<Set<string>> {
  return new Set((await cli.queue()).map((row) => row.id));
}

await cli.seed({
  pendingOperations: [
    { id: "p-applied-old", status: "applied", resolvedAt: ANCIENT },
    { id: "p-rejected-old", status: "rejected", resolvedAt: ANCIENT },
    { id: "p-applied-new", status: "applied", resolvedAt: RECENT },
    { id: "p-failed-old", status: "failed", resolvedAt: ANCIENT },
    { id: "p-pending", status: "pending", resolvedAt: "" },
    { id: "p-applying", status: "applying", resolvedAt: "" },
  ],
});

describe("email-agent approvals prune", () => {
  it("reports what a run would delete without deleting it", async () => {
    const before = await ids();
    const result = await cli.run([
      "approvals",
      "prune",
      "--older-than-days",
      "30",
      "--dry-run",
    ]);

    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Dry run/);
    assert.match(result.output, /2 rows are eligible/);
    assert.deepEqual(await ids(), before, "a dry run must delete nothing");
  });

  it("deletes only resolved rows past the window, and says which statuses can go", async () => {
    const result = await cli.run(["approvals", "prune", "--older-than-days", "30"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Deleted 2 resolved approval-queue rows/);
    // The promise a user needs before running this: what is NEVER eligible.
    assert.match(result.output, /pending, applying and failed rows are never pruned/);

    const left = await ids();
    assert.equal(left.has("p-applied-old"), false);
    assert.equal(left.has("p-rejected-old"), false);
    assert.ok(left.has("p-applied-new"), "inside the window");
    assert.ok(left.has("p-failed-old"), "a failed row is the diagnostic record of an attempt");
    assert.ok(left.has("p-pending"));
    assert.ok(left.has("p-applying"), "unresolved: pruning it would destroy the only evidence");
  });

  it("says nothing was eligible rather than printing a bare 0", async () => {
    const result = await cli.run(["approvals", "prune", "--older-than-days", "30"]);
    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Nothing to prune/);
  });

  it("treats 0 days as KEEP FOREVER, never as delete everything", async () => {
    // The direction that matters. `Number("")` is 0 and 0 is the documented
    // opt-out, so a command that read 0 as "cutoff = now" would delete the
    // whole audit trail of the user who most explicitly asked to keep it.
    const before = await ids();
    const result = await cli.run(["approvals", "prune", "--older-than-days", "0"]);

    assert.equal(result.exitCode, 0);
    assert.match(result.output, /Retention is disabled/);
    assert.match(result.output, /kept forever/);
    assert.deepEqual(await ids(), before);
  });

  it("refuses a window that is not a whole number of days", async () => {
    for (const bad of ["-1", "3.5", "thirty", ""]) {
      const result = await cli.run(["approvals", "prune", "--older-than-days", bad]);
      assert.equal(result.exitCode, 1, `${JSON.stringify(bad)} must be refused`);
      assert.match(result.output, /whole number of days/);
    }
  });

  it("falls back to the configured window when none is given", async () => {
    await cli.writeSettings({ retention: { approvalQueueDays: 0 } });
    const result = await cli.run(["approvals", "prune"]);
    assert.equal(result.exitCode, 0);
    assert.match(
      result.output,
      /retention\.approvalQueueDays = 0/,
      "the command must report the window it actually used",
    );
  });
});
