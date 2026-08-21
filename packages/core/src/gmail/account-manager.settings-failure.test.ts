// `listAccounts()` must NOT convert an unusable settings.json into "no accounts".
//
// WHY THIS IS ITS OWN FILE. `account-manager.test.ts` statically imports
// `./account-manager.js` on line 3. Static imports are hoisted, so
// `config/defaults.ts` would have computed SETTINGS_PATH (and LANCEDB_DIR)
// against the developer's REAL `$HOME` before the file's first statement ran —
// which is exactly what `useTempHome()` asserts against, and it would throw.
// The `$HOME` redirect has to happen before the first core import, so this
// cannot live in the existing file.
//
// WHAT IS BEING PINNED. An empty account list is a MAILBOX DECISION, not a
// neutral "nothing to report": `getDefaultAccount()` answers `null` for it, and
// `gmail/client.ts` turns that `null` into the gcloud ADC branch of
// `createGmailClient()` and into `""` from `resolveAccountEmail()` — the value
// `syncEmails()` uses both as the fetch identity and as the stored `accountId`.
// So a swallowed read error silently re-pointed a whole fetch at whatever
// mailbox ADC is signed in as.
//
// The client.ts hop is asserted at `getDefaultAccount()` rather than end to end,
// on purpose: `createGmailClient(undefined)` on the old path spawns
// `gcloud auth application-default print-access-token`, a real subprocess that
// on a signed-in developer machine mints a real token.

import assert from "node:assert/strict";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, it } from "node:test";

// The ONLY permitted static core import in a file like this — the fixture
// itself imports nothing from core at module load. See lancedb-fixture.ts.
import { useTempHome } from "../testing/lancedb-fixture.js";

await useTempHome("list-accounts-settings-failure");

// Everything below is dynamic, and BELOW the fixture call.
const { SETTINGS_PATH } = await import("../config/defaults.js");
const { listAccounts, getDefaultAccount } = await import("./account-manager.js");
const { clearSettingsCache } = await import("../config/settings.js");

const CORRUPT_JSON =
  '{ "accounts": [{"email":"me@example.com","isDefault":true}], truncated';

describe("listAccounts() and an unusable settings file", () => {
  // DECLARATION ORDER MATTERS: node:test runs these in order and they share one
  // temp home, so the genuinely-absent case has to run before anything writes
  // the file.
  it("returns [] when there is genuinely no settings file (ENOENT)", async () => {
    clearSettingsCache();
    assert.deepEqual(await listAccounts(), []);
  });

  it("throws rather than returning [] when settings.json is not valid JSON", async () => {
    // The primary regression case, and it is content-based rather than
    // permission-based on purpose: mode bits are bypassed for root, so a
    // chmod-000 case would fail as root in BOTH the fixed and unfixed states —
    // a false RED, which is worse than a false green because it reads as "the
    // fix did not work".
    await mkdir(dirname(SETTINGS_PATH), { recursive: true });
    await writeFile(SETTINGS_PATH, CORRUPT_JSON);
    clearSettingsCache();

    // BEFORE THE FIX: this RESOLVES with [], so assert.rejects fails with
    // "Missing expected rejection".
    await assert.rejects(
      listAccounts(),
      /exist but are not valid JSON .*Refusing to fall back to default settings/s,
    );
  });

  it("propagates the failure through getDefaultAccount(), which selects the mailbox", async () => {
    // The hop that ties the unit under test to the harm. BEFORE THE FIX this
    // resolved `null`, and `null` is precisely what `createGmailClient()` reads
    // as "use gcloud ADC".
    await writeFile(SETTINGS_PATH, CORRUPT_JSON);
    clearSettingsCache();
    await assert.rejects(
      getDefaultAccount(),
      /Refusing to fall back to default settings/s,
    );
  });

  it("throws rather than returning [] when settings.json is unreadable (chmod 000)", async (t) => {
    // The scenario the TODO named. Self-skips as root, mirroring the existing
    // precedent in config/settings.test.ts so the two stay recognisably alike.
    if (typeof process.getuid === "function" && process.getuid() === 0) {
      t.skip("root bypasses mode bits");
      return;
    }
    await writeFile(
      SETTINGS_PATH,
      JSON.stringify({ accounts: [{ email: "me@example.com", isDefault: true }] }),
    );
    await chmod(SETTINGS_PATH, 0o000);
    clearSettingsCache();
    try {
      await assert.rejects(
        listAccounts(),
        /Could not read settings .*Refusing to fall back to default settings/s,
      );
    } finally {
      await chmod(SETTINGS_PATH, 0o600);
    }
  });
});
