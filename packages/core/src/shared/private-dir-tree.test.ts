/**
 * The `0700` walk in `shared/private-files.ts`.
 *
 * WHY A SECOND FILE beside `private-files.test.ts`: that one covers the atomic
 * `0600` file writer against arbitrary temp directories, deliberately OUTSIDE
 * `~/.email-agent`. This one is about the app's OWN tree, so it needs a
 * redirected `$HOME` — and `useTempHome()` may only be called with every core
 * import below it.
 *
 * THE UMASK, HANDLED RATHER THAN HOPED ABOUT. A mode assertion is only
 * meaningful against a known umask: `mkdir` masks the mode it is given, so under
 * `umask 077` a directory lands at `0700` whether or not this code asks for it,
 * and these tests would pass against the very bug they exist to catch. Every
 * test here therefore pins `umask 022` — the common default, and the umask the
 * defect was measured under — and restores the runner's own umask afterwards.
 * `node --test` runs each file in its own process, so the pin cannot leak into
 * another file.
 */

import assert from "node:assert/strict";
import { mkdirSync, symlinkSync, chmodSync, rmSync } from "node:fs";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

import { useTempHome } from "../testing/lancedb-fixture.js";

const home = await useTempHome("private-dir-tree");

const {
  appPrivateRoot,
  ensurePrivateDir,
  ensurePrivateDirSync,
  filePermissions,
  privateDirChain,
  resetSymlinkNoticesForTest,
} = await import("./private-files.js");

const ROOT = appPrivateRoot();

let runnerUmask = 0o022;
before(() => {
  runnerUmask = process.umask(0o022);
});
after(() => {
  process.umask(runnerUmask);
});

beforeEach(() => {
  // Each test starts from a root an OLDER VERSION would have left behind, so
  // "the walk tightened it" is what is being observed and not a leftover from
  // the previous test.
  rmSync(ROOT, { recursive: true, force: true });
  mkdirSync(ROOT, { recursive: true, mode: 0o755 });
  chmodSync(ROOT, 0o755);
  resetSymlinkNoticesForTest();
});

test("privateDirChain names every level from the app root down, outermost first", () => {
  assert.deepEqual(privateDirChain(join(ROOT, "data", "lancedb")), [
    ROOT,
    join(ROOT, "data"),
    join(ROOT, "data", "lancedb"),
  ]);
  assert.deepEqual(privateDirChain(ROOT), [ROOT]);
});

test("privateDirChain never walks up out of the app's own tree", () => {
  // The bound that makes "never chmod something outside this app's tree" a
  // property of the code. A `startsWith(root)` containment test would have
  // matched the first of these and chmod-ed a backup directory nobody asked
  // about.
  const sibling = `${ROOT}-backup`;
  assert.deepEqual(privateDirChain(sibling), [sibling]);
  assert.deepEqual(privateDirChain(home.path), [home.path]);
  assert.deepEqual(privateDirChain("/tmp/somewhere-else"), [
    "/tmp/somewhere-else",
  ]);
});

test("ensurePrivateDir tightens EVERY pre-existing 0755 level, not just the leaf", async () => {
  // The upgrade case. `mkdir(..., { recursive: true, mode })` applies the mode
  // only to levels it CREATES, so a tree an earlier version left at 0755 is
  // repaired by the chmod walk or by nothing at all.
  const leaf = join(ROOT, "data", "lancedb");
  mkdirSync(leaf, { recursive: true, mode: 0o755 });
  for (const dir of [join(ROOT, "data"), leaf]) chmodSync(dir, 0o755);

  await ensurePrivateDir(leaf);

  assert.equal(filePermissions(ROOT), 0o700);
  assert.equal(filePermissions(join(ROOT, "data")), 0o700);
  assert.equal(filePermissions(leaf), 0o700);
});

test("ensurePrivateDirSync tightens the same chain as its async twin", () => {
  const leaf = join(ROOT, "data", "lancedb");
  mkdirSync(leaf, { recursive: true, mode: 0o755 });
  for (const dir of [join(ROOT, "data"), leaf]) chmodSync(dir, 0o755);

  ensurePrivateDirSync(leaf);

  assert.equal(filePermissions(ROOT), 0o700);
  assert.equal(filePermissions(join(ROOT, "data")), 0o700);
  assert.equal(filePermissions(leaf), 0o700);
});

test("ensurePrivateDir creates a fresh chain at 0700 with no chmod needed", async () => {
  rmSync(ROOT, { recursive: true, force: true });

  await ensurePrivateDir(join(ROOT, "data", "lancedb"));

  assert.equal(filePermissions(ROOT), 0o700);
  assert.equal(filePermissions(join(ROOT, "data")), 0o700);
  assert.equal(filePermissions(join(ROOT, "data", "lancedb")), 0o700);
});

test("the walk STOPS at a symlinked level and leaves its target's mode alone", async () => {
  // `chmod()` resolves symlinks and Linux has no `lchmod()`, so tightening a
  // symlinked level would set a mode on a directory outside this app's tree —
  // and every level below it resolves through the same link, so those are
  // outside too. Someone whose data directory is deliberately a symlink onto
  // another volume must not have the app refuse to start over it either.
  const elsewhere = join(home.path, "other-volume");
  mkdirSync(elsewhere, { recursive: true, mode: 0o755 });
  chmodSync(elsewhere, 0o755);
  symlinkSync(elsewhere, join(ROOT, "data"));

  const warnings: string[] = [];
  const realWarn = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args.join(" "));
  };
  try {
    await ensurePrivateDir(join(ROOT, "data", "lancedb"));
    // Called twice; the notice is once per process so a request-path caller
    // cannot spam it.
    await ensurePrivateDir(join(ROOT, "data", "lancedb"));
  } finally {
    console.warn = realWarn;
  }

  assert.equal(
    filePermissions(elsewhere),
    0o755,
    "the symlink target is outside the app's tree and must not be chmod-ed",
  );
  assert.equal(filePermissions(ROOT), 0o700, "levels above the link are ours");
  assert.equal(warnings.length, 1, "the notice is once per path per process");
  assert.match(warnings[0] ?? "", /symlink/);
});
