/**
 * THE SETTINGS-FIRST ORDERING, AND THE UPGRADE CASE — together, because they
 * are the same user: somebody who already ran an older version, so
 * `~/.email-agent` is already `0700` (a settings write put it there) while
 * `data/` and `data/lancedb/` were left at `0755` by the bare `mkdir` that used
 * to be in `getDb()`.
 *
 * This is the case a fix that only sets a mode at creation time would MISS
 * entirely: `mkdir(..., { recursive: true, mode })` never changes a level that
 * already exists (measured, node 26.7.0). A tightening that helps nobody who has
 * already run the app is not a fix, so the repair has to be a chmod walk and
 * this test is what says so.
 *
 * Separate process from the fresh case — `getDb()` caches its `connect()`
 * promise module-locally, so a process gets one observable `initDb()`.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { useTempHome } from "../testing/lancedb-fixture.js";

const home = await useTempHome("db-upgrade-permissions");

const runnerUmask = process.umask(0o022);

const { LANCEDB_DIR, DATA_DIR } = await import("../config/defaults.js");
const { filePermissions } = await import("../shared/private-files.js");
const { loadSettings, saveSettings } = await import("../config/settings.js");
const { initDb } = await import("./connection.js");

const ROOT = join(home.path, ".email-agent");

test("initDb() repairs a data tree an older version left at 0755", async (t) => {
  t.after(() => process.umask(runnerUmask));

  // Settings-first: this is what already put the root at 0700 on the machine
  // where the defect was originally measured, and it is why the leak there was
  // one loose `chmod` away rather than immediately exploitable.
  await saveSettings(await loadSettings());
  assert.equal(filePermissions(ROOT), 0o700, "settings write hardens the root");

  // ...and this is the tree the old bare mkdir left behind.
  mkdirSync(LANCEDB_DIR, { recursive: true, mode: 0o755 });
  for (const dir of [DATA_DIR, LANCEDB_DIR]) chmodSync(dir, 0o755);
  assert.equal(filePermissions(DATA_DIR), 0o755, "precondition");
  assert.equal(filePermissions(LANCEDB_DIR), 0o755, "precondition");

  await initDb();

  assert.equal(filePermissions(ROOT), 0o700, "~/.email-agent");
  assert.equal(filePermissions(DATA_DIR), 0o700, "~/.email-agent/data");
  assert.equal(
    filePermissions(LANCEDB_DIR),
    0o700,
    "~/.email-agent/data/lancedb — the mail bodies and their embeddings",
  );
});
