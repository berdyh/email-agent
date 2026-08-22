/**
 * Modes on `~/.email-agent/actions` and the files in it.
 *
 * `saveUserAction()` used a bare `mkdir` and a bare `writeFile`, so under the
 * common `umask 022` a user's actions were a 0755 directory of 0644 files —
 * the same shape of defect the mail database had, and another of the places
 * that made AGENTS.md's "everything under `~/.email-agent/` is 0600 inside
 * 0700" false. An action file is not a credential, but its prompt says what the
 * user watches their mailbox for and what they do about it.
 *
 * The umask is pinned to 022 and restored, for the reason spelled out in
 * `shared/private-dir-tree.test.ts`: under `umask 077` these assertions pass
 * against the bug itself. `node --test` gives each file its own process, so the
 * pin cannot leak.
 */

import assert from "node:assert/strict";
import { chmodSync, mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";

import { useTempHome } from "../testing/lancedb-fixture.js";

const home = await useTempHome("user-action-permissions");

const { ACTIONS_DIR } = await import("../config/defaults.js");
const { filePermissions } = await import("../shared/private-files.js");
const { saveUserAction } = await import("./user-actions.js");

const ROOT = join(home.path, ".email-agent");
const SNAPSHOTS = join(ACTIONS_DIR, ".snapshots");

const SOURCE = (note: string) =>
  `const action = { id: "p", name: "P", prompt: ${JSON.stringify(note)} };\n` +
  `export default action;\n`;

let runnerUmask = 0o022;
before(() => {
  runnerUmask = process.umask(0o022);
});
after(() => {
  process.umask(runnerUmask);
});

test("saveUserAction writes 0600 files into a 0700 chain", async () => {
  await saveUserAction("probe.action.ts", SOURCE("first"));

  assert.equal(filePermissions(ROOT), 0o700, "~/.email-agent");
  assert.equal(filePermissions(ACTIONS_DIR), 0o700, "~/.email-agent/actions");
  assert.equal(
    filePermissions(join(ACTIONS_DIR, "probe.action.ts")),
    0o600,
    "the action file",
  );
});

test("a snapshot is written privately too, not copied at the source's mode", async () => {
  // `copyFile` reproduces the SOURCE's mode, so a snapshot of a file an older
  // version left at 0644 would have been created at 0644 — the loose modes
  // would keep propagating forward one version at a time.
  await saveUserAction("probe.action.ts", SOURCE("second"));

  assert.equal(filePermissions(SNAPSHOTS), 0o700, "the .snapshots directory");
  const snapshots = readdirSync(SNAPSHOTS);
  assert.equal(snapshots.length, 1, "the overwrite should have snapshotted");
  assert.equal(
    filePermissions(join(SNAPSHOTS, snapshots[0] ?? "")),
    0o600,
    "the snapshot file",
  );
});

test("saving tightens an actions directory an older version left at 0755", async () => {
  // The upgrade case: `mkdir`'s mode never touches a directory that already
  // exists, so this is repaired by the chmod walk or by nothing.
  for (const dir of [ROOT, ACTIONS_DIR, SNAPSHOTS]) chmodSync(dir, 0o755);
  mkdirSync(ACTIONS_DIR, { recursive: true, mode: 0o755 });
  assert.equal(filePermissions(ACTIONS_DIR), 0o755, "precondition");

  await saveUserAction("probe.action.ts", SOURCE("third"));

  assert.equal(filePermissions(ROOT), 0o700);
  assert.equal(filePermissions(ACTIONS_DIR), 0o700);
  assert.equal(filePermissions(SNAPSHOTS), 0o700);
});
