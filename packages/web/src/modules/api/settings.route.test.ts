// `GET`/`PUT /api/settings` — real handlers, real temp `$HOME`, real files.
//
// No test previously drove these handlers directly (unlike approvals.route
// .test.ts, actions.route.test.ts, oauth-csrf.route.test.ts). This file
// covers the removal of the dead `oauth` settings field: `PUT` must reject
// it as an unknown key, a settings file that already carries it on disk
// (written by a pre-removal build) must have it purged on the next save, and
// `GET` must never echo it back.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRequest,
  callHandler,
  startRouteHarness,
} from "./testing/route-harness.js";

const harness = await startRouteHarness("settings");
const settingsDir = join(harness.home, ".email-agent");
const SETTINGS_PATH = join(settingsDir, "settings.json");

const route = await harness.load<{
  GET: (r: import("next/server").NextRequest) => Promise<Response>;
  PUT: (r: import("next/server").NextRequest) => Promise<Response>;
}>("app/api/settings/route.ts");

describe("PUT /api/settings", () => {
  it("rejects an oauth block as an unknown setting", async () => {
    const result = await callHandler<{ error: string }>(
      route.PUT,
      buildRequest("/api/settings", {
        method: "PUT",
        body: { oauth: { clientId: "x", clientSecret: "y" } },
      }),
    );

    assert.equal(result.status, 400);
    assert.match(result.body.error, /Unknown setting: oauth/);
  });

  it("purges a pre-existing on-disk oauth block on the next save, even an unrelated one", async () => {
    // Simulates a settings.json written by a pre-removal build: the field
    // used to round-trip to disk in plaintext. This is the empirical proof
    // the ticket asked for — that the next save purges it — rather than an
    // inspection of normalizeSettings alone.
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      SETTINGS_PATH,
      JSON.stringify({
        oauth: { clientId: "legacy-client", clientSecret: "legacy-secret" },
        ui: { fetchInterval: 5, fetchScope: "unread" },
      }),
    );

    const result = await callHandler<{ ok: boolean }>(
      route.PUT,
      buildRequest("/api/settings", {
        method: "PUT",
        body: { ui: { fetchInterval: 10 } },
      }),
    );
    assert.equal(result.status, 200);

    const onDisk = await readFile(SETTINGS_PATH, "utf-8");
    assert.equal(onDisk.includes("legacy-secret"), false, "the plaintext secret must be gone");
    assert.equal(onDisk.includes("oauth"), false);
    assert.equal(JSON.parse(onDisk).ui.fetchInterval, 10, "the unrelated update still landed");
  });
});

describe("GET /api/settings", () => {
  it("never returns a legacy oauth block, even when one is seeded on disk", async () => {
    await mkdir(settingsDir, { recursive: true });
    await writeFile(
      SETTINGS_PATH,
      JSON.stringify({
        oauth: { clientId: "legacy-client", clientSecret: "legacy-secret" },
      }),
    );

    const result = await callHandler<Record<string, unknown>>(
      route.GET,
      buildRequest("/api/settings"),
    );

    assert.equal(result.status, 200);
    assert.equal("oauth" in result.body, false);
  });
});
