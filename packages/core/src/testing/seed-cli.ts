/**
 * Seeds and reads a temp-directory LanceDB from ANOTHER process.
 *
 * The CLI end-to-end tests run the built `email-agent` binary against a seeded
 * database, and they cannot seed it in-process: `packages/cli` may only import
 * the `@email-agent/core` barrel (enforced by `scripts/check-module-boundaries.mjs`),
 * and this fixture is deliberately not on the barrel. Rather than weaken that
 * rule for tests or hand-copy a fourth seeding helper, the CLI harness shells
 * out to this entry point — which is the same fixture core's own tests use,
 * against the same `$HOME` the CLI under test will see.
 *
 * Usage (the harness passes `$HOME` through the environment):
 *   node dist/testing/seed-cli.js seed '<json spec>'
 *   node dist/testing/seed-cli.js read        # every pending_operations row, as JSON
 *   node dist/testing/seed-cli.js init        # create the tables and stop
 *
 * Test-only, like the rest of this directory: not on the barrel, not in the
 * package `exports` map.
 */

import type {
  ActionResultRecord,
  EmailRecord,
  PendingOperationRecord,
} from "../db/schema.js";

export interface SeedSpec {
  emails?: Array<Partial<EmailRecord>>;
  pendingOperations?: Array<Partial<PendingOperationRecord>>;
  actionResults?: Array<Partial<ActionResultRecord>>;
  /** Ages claimed rows so they read as stranded rather than in flight. */
  backdateClaims?: { ids: string[]; ms: number };
}

async function main(): Promise<void> {
  // `$HOME` is already whatever the parent set, so importing the fixture here
  // resolves LANCEDB_DIR inside the temp home — the same mechanism a real
  // second process uses.
  const fixture = await import("./lancedb-fixture.js");
  const { initTempDb } = fixture;

  const command = process.argv[2] ?? "seed";
  await initTempDb();

  if (command === "init") return;

  if (command === "read") {
    const rows = await fixture.readAllPendingOperations();
    process.stdout.write(JSON.stringify(rows));
    return;
  }

  const spec = JSON.parse(process.argv[3] ?? "{}") as SeedSpec;
  if (spec.emails?.length) await fixture.seedEmails(spec.emails);
  if (spec.pendingOperations?.length) {
    await fixture.seedPendingOperations(spec.pendingOperations);
  }
  if (spec.actionResults?.length) {
    await fixture.seedActionResults(spec.actionResults);
  }
  if (spec.backdateClaims) {
    await fixture.backdateClaim(spec.backdateClaims.ids, spec.backdateClaims.ms);
  }
}

await main();
