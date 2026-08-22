/**
 * THE DB-FIRST ORDERING: `email-agent fetch` on a clean box, where `initDb()`
 * is the first thing that ever writes under `~/.email-agent`.
 *
 * This is the ordering that made the defect worse than it looked. The mail
 * database is protected by its ancestors' modes — LanceDB creates the `*.lance`
 * table directories itself and their bits are not ours to set — and here
 * `initDb()` creates every one of those ancestors, the ROOT included. With a
 * bare `mkdir(LANCEDB_DIR, { recursive: true })` all of them landed at the
 * process umask, so on a fresh install the `0700` shield `private-files.ts` puts
 * on `~/.email-agent` did not exist yet and every message body was readable by
 * any other local user.
 *
 * A SEPARATE FILE from the settings-first/upgrade case because `getDb()` caches
 * its `connect()` promise module-locally: one `initDb()` per process is all a
 * test can observe, and `node --test` gives each FILE its own process.
 *
 * The umask is pinned to 022 for the reason spelled out in
 * `shared/private-dir-tree.test.ts` — under `umask 077` these assertions would
 * pass against the bug itself.
 */

import assert from "node:assert/strict";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { useTempHome } from "../testing/lancedb-fixture.js";

const home = await useTempHome("db-first-permissions");

const runnerUmask = process.umask(0o022);

const { LANCEDB_DIR, DATA_DIR } = await import("../config/defaults.js");
const { filePermissions } = await import("../shared/private-files.js");
const { initDb } = await import("./connection.js");

const ROOT = join(home.path, ".email-agent");

test("initDb() on a clean home creates the WHOLE chain at 0700", async (t) => {
  t.after(() => process.umask(runnerUmask));

  assert.equal(
    existsSync(ROOT),
    false,
    "this test is only meaningful if initDb() is what creates the root",
  );

  await initDb();

  assert.equal(filePermissions(ROOT), 0o700, "~/.email-agent");
  assert.equal(filePermissions(DATA_DIR), 0o700, "~/.email-agent/data");
  assert.equal(filePermissions(LANCEDB_DIR), 0o700, "~/.email-agent/data/lancedb");
});

test("the *.lance table directories are protected by their ancestors, not by their own bits", () => {
  // Stated as a test rather than as a comment somewhere, because it is the
  // honest limit of this fix. LanceDB creates these and sets their modes; this
  // app does not touch them and must not claim to have hardened them. What
  // makes them unreachable to another local user is 0700 on every level above,
  // asserted in the test before this one.
  const tables = readdirSync(LANCEDB_DIR).filter((n) => n.endsWith(".lance"));
  assert.ok(tables.length > 0, "initDb() should have created the tables");
  assert.equal(
    filePermissions(LANCEDB_DIR),
    0o700,
    "the parent is the entire protection for these",
  );
});
