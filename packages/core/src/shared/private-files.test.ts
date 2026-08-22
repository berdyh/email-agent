/**
 * The permission story for everything under `~/.email-agent/`.
 *
 * These are mode assertions against files written by the PRODUCT'S OWN write
 * paths wherever one exists without a network call. Before 2026-08-22 every one
 * of them failed: `saveSettings()` and `saveTokens()` passed no `mode` at all,
 * so with the common `umask 022` the settings file and the Gmail OAuth refresh
 * token both landed at `0644` inside a `0755` directory.
 *
 * `saveTokens()` itself is only reachable through `exchangeCode()`/the refresh
 * path, both of which call Google — so the token file gets a SOURCE tripwire
 * here (the same shape `prompt.test.ts` uses for `rl.question()` and
 * `cross-process-claim.race.test.ts` uses for raw `table.update()`), not a
 * pretend end-to-end assertion.
 */

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, writeFile, chmod } from "node:fs/promises";
import { statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { useTempHome } from "../testing/index.js";

const home = await useTempHome("private-files");

const {
  PRIVATE_DIR_MODE,
  PRIVATE_FILE_MODE,
  ensurePrivateDir,
  ensurePrivateDirSync,
  filePermissions,
  writePrivateFile,
  writePrivateFileSync,
} = await import("./private-files.js");

function modeOf(path: string): number {
  return statSync(path).mode & 0o777;
}

async function scratch(label: string): Promise<string> {
  return mkdtemp(join(tmpdir(), `email-agent-privfiles-${label}-`));
}

test("writePrivateFile creates the file 0600 inside a 0700 directory", async () => {
  const dir = join(await scratch("create"), "nested", "deeper");
  const path = join(dir, "secret.json");

  await writePrivateFile(path, '{"a":1}');

  assert.equal(modeOf(path), PRIVATE_FILE_MODE);
  assert.equal(modeOf(dir), PRIVATE_DIR_MODE);
  assert.equal(await readFile(path, "utf-8"), '{"a":1}');
});

test("writePrivateFile TIGHTENS a file and directory that already exist loose", async () => {
  // The regression that actually happened: an install from before this change
  // already has a 0755 ~/.email-agent holding a 0644 settings.json. A `mode:`
  // option on writeFile/mkdir applies only on CREATE, so both would keep their
  // old bits forever.
  const dir = await scratch("tighten");
  const path = join(dir, "already-there.json");
  await chmod(dir, 0o755);
  await writeFile(path, "old");
  await chmod(path, 0o644);
  assert.equal(modeOf(dir), 0o755, "precondition: directory starts world-readable");
  assert.equal(modeOf(path), 0o644, "precondition: file starts world-readable");

  await writePrivateFile(path, "new");

  assert.equal(modeOf(path), PRIVATE_FILE_MODE);
  assert.equal(modeOf(dir), PRIVATE_DIR_MODE);
  assert.equal(await readFile(path, "utf-8"), "new");
});

test("writePrivateFileSync matches the async path, tightening included", async () => {
  const dir = await scratch("sync");
  const path = join(dir, "sync.json");
  await chmod(dir, 0o755);
  await writeFile(path, "old");
  await chmod(path, 0o644);

  writePrivateFileSync(path, "new");

  assert.equal(modeOf(path), PRIVATE_FILE_MODE);
  assert.equal(modeOf(dir), PRIVATE_DIR_MODE);
  assert.equal(await readFile(path, "utf-8"), "new");
});

test("neither writer leaves its temp file behind", async () => {
  const dir = await scratch("temps");
  await writePrivateFile(join(dir, "a.json"), "a");
  writePrivateFileSync(join(dir, "b.json"), "b");

  assert.deepEqual((await readdir(dir)).sort(), ["a.json", "b.json"]);
});

test("ensurePrivateDir and its sync twin tighten an existing loose directory", async () => {
  const asyncDir = join(await scratch("dirs"), "async");
  const syncDir = join(await scratch("dirs"), "sync");
  await mkdir(asyncDir, { recursive: true });
  await mkdir(syncDir, { recursive: true });
  await chmod(asyncDir, 0o777);
  await chmod(syncDir, 0o777);

  await ensurePrivateDir(asyncDir);
  ensurePrivateDirSync(syncDir);

  assert.equal(modeOf(asyncDir), PRIVATE_DIR_MODE);
  assert.equal(modeOf(syncDir), PRIVATE_DIR_MODE);
});

test("filePermissions answers undefined rather than throwing for an absent file", () => {
  assert.equal(filePermissions(join(home.path, "nope", "nothing.json")), undefined);
});

test("saveSettings writes ~/.email-agent/settings.json 0600 in a 0700 directory", async () => {
  const { saveSettings } = await import("../config/settings.js");
  const { defaultConfig, SETTINGS_PATH } = await import("../config/defaults.js");

  await saveSettings(defaultConfig);

  assert.ok(
    SETTINGS_PATH.startsWith(home.path),
    `SETTINGS_PATH is ${SETTINGS_PATH}, outside the temp home`,
  );
  assert.equal(filePermissions(SETTINGS_PATH), PRIVATE_FILE_MODE);
  assert.equal(filePermissions(join(home.path, ".email-agent")), PRIVATE_DIR_MODE);
});

test("saveSettings tightens a settings file an older version left world-readable", async () => {
  const { saveSettings } = await import("../config/settings.js");
  const { defaultConfig, SETTINGS_PATH } = await import("../config/defaults.js");
  const dir = join(home.path, ".email-agent");

  await mkdir(dir, { recursive: true });
  await writeFile(SETTINGS_PATH, "{}");
  await chmod(SETTINGS_PATH, 0o644);
  await chmod(dir, 0o755);

  await saveSettings(defaultConfig);

  assert.equal(filePermissions(SETTINGS_PATH), PRIVATE_FILE_MODE);
  assert.equal(filePermissions(dir), PRIVATE_DIR_MODE);
});

test("saveTokens goes through the private-file writer, not bare fs", async () => {
  // The OAuth refresh token IS the mailbox. Its only callers reach Google, so
  // this pins the write shape at the source instead of pretending to observe a
  // file no test in this repo can cause to be written.
  const source = await readFile(
    new URL("../gmail/account-manager.ts", import.meta.url),
    "utf-8",
  );
  const body = source.slice(source.indexOf("async function saveTokens("));
  const saveTokensBody = body.slice(0, body.indexOf("\n}"));

  assert.match(saveTokensBody, /writePrivateFile\(/);
  assert.match(saveTokensBody, /ensurePrivateDir\(/);
  assert.doesNotMatch(
    saveTokensBody,
    /\bwriteFile\(|\bmkdir\(/,
    "saveTokens must not fall back to bare writeFile/mkdir — they write 0644 under the default umask",
  );
});
