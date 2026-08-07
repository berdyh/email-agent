// `GET`/`POST /api/actions/user/snapshots` — the route the new "Versions"
// control on the actions page calls.
//
// The route existed and had no test; the UI that would have exercised it did
// not exist at all, so the restore path was reachable only from the CLI. The
// case that matters here is the REFUSAL: `restoreSnapshot` writes through
// `saveUserAction`, which re-validates, so a snapshot taken before the source
// guard existed is refused — and that used to arrive as a 500 "Failed to
// restore action snapshot", which tells a user with an unrecoverable action
// nothing at all.
//
// Real handler, real temp `$HOME`, real files. No HTTP, no mocking layer.

import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRequest,
  callHandler,
  startRouteHarness,
} from "./testing/route-harness.js";

const harness = await startRouteHarness("snapshots");
const actionsDir = join(harness.home, ".email-agent", "actions");
const snapshotsDir = join(actionsDir, ".snapshots");
await mkdir(snapshotsDir, { recursive: true });

const action = (marker: string) => `import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "junk",
  name: "Junk ${marker}",
  description: "${marker}",
  prompt: "p",
  requiresConfirmation: false,
  mutatesGmail: true,
};

export default action;
`;

const PRE_GUARD = `import { readFileSync } from "node:fs";
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "junk",
  name: "Junk PRE-GUARD",
  description: readFileSync("/etc/hostname", "utf-8"),
  prompt: "p",
  requiresConfirmation: false,
  mutatesGmail: true,
};

export default action;
`;

const GOOD_SNAPSHOT = "junk.action.ts.2026-01-01T00-00-00-000Z.ts";
const BAD_SNAPSHOT = "junk.action.ts.2025-01-01T00-00-00-000Z.ts";

await writeFile(join(actionsDir, "junk.action.ts"), action("CURRENT"), "utf-8");
await writeFile(join(snapshotsDir, GOOD_SNAPSHOT), action("OLD"), "utf-8");
await writeFile(join(snapshotsDir, BAD_SNAPSHOT), PRE_GUARD, "utf-8");

const route = await harness.load<{
  GET: (r: import("next/server").NextRequest) => Promise<Response>;
  POST: (r: import("next/server").NextRequest) => Promise<Response>;
}>("app/api/actions/user/snapshots/route.ts");

const currentSource = () => readFile(join(actionsDir, "junk.action.ts"), "utf-8");

describe("GET /api/actions/user/snapshots", () => {
  it("lists an action's snapshots newest first", async () => {
    const result = await callHandler<Array<{ filename: string; timestamp: string }>>(
      route.GET,
      buildRequest("/api/actions/user/snapshots", {
        query: { filename: "junk.action.ts" },
      }),
    );

    assert.equal(result.status, 200);
    assert.deepEqual(
      result.body.map((entry) => entry.filename),
      [GOOD_SNAPSHOT, BAD_SNAPSHOT],
      "2026 before 2025 — the UI renders this order as given",
    );
  });

  it("refuses a filename that tries to walk out of the actions directory", async () => {
    const result = await callHandler(
      route.GET,
      buildRequest("/api/actions/user/snapshots", {
        query: { filename: "../../../etc/passwd" },
      }),
    );
    assert.equal(result.status, 400);
  });
});

describe("POST /api/actions/user/snapshots", () => {
  it("refuses a pre-guard snapshot with 422 AND the rules it broke", async () => {
    const before = await currentSource();

    const result = await callHandler<{ error: string; violations?: Array<{ rule: string }> }>(
      route.POST,
      buildRequest("/api/actions/user/snapshots", {
        method: "POST",
        body: { snapshotFilename: BAD_SNAPSHOT, originalFilename: "junk.action.ts" },
      }),
    );

    assert.equal(
      result.status,
      422,
      "a source-guard refusal is not a server error; 500 told the user nothing",
    );
    assert.ok(
      (result.body.violations ?? []).length > 0,
      "the rules must reach the browser — the CLI already prints them",
    );
    assert.ok(
      (result.body.violations ?? []).some((v) => v.rule === "value-import"),
      `expected the value-import rule, got ${JSON.stringify(result.body.violations)}`,
    );
    assert.equal(await currentSource(), before, "nothing was changed");
  });

  it("restores a good snapshot and snapshots what it replaced", async () => {
    const result = await callHandler<{ success: boolean }>(
      route.POST,
      buildRequest("/api/actions/user/snapshots", {
        method: "POST",
        body: { snapshotFilename: GOOD_SNAPSHOT, originalFilename: "junk.action.ts" },
      }),
    );

    assert.equal(result.status, 200);
    assert.match(await currentSource(), /OLD/);

    // The property that makes restoring safe to try: the version just replaced
    // is itself recoverable.
    const listed = await callHandler<Array<{ filename: string }>>(
      route.GET,
      buildRequest("/api/actions/user/snapshots", {
        query: { filename: "junk.action.ts" },
      }),
    );
    assert.ok(
      listed.body.length >= 3,
      `expected a new snapshot of the replaced version, saw ${listed.body.length}`,
    );
  });

  it("refuses a snapshot that belongs to a different action", async () => {
    const result = await callHandler<{ error: string }>(
      route.POST,
      buildRequest("/api/actions/user/snapshots", {
        method: "POST",
        body: { snapshotFilename: GOOD_SNAPSHOT, originalFilename: "other.action.ts" },
      }),
    );
    assert.equal(result.status, 500);
    assert.match(await currentSource(), /OLD/, "still the restored version");
  });

  it("is behind the mutation guard", async () => {
    const result = await callHandler(
      route.POST,
      buildRequest("/api/actions/user/snapshots", {
        method: "POST",
        body: { snapshotFilename: GOOD_SNAPSHOT, originalFilename: "junk.action.ts" },
        sameOrigin: false,
      }),
    );
    assert.equal(result.status, 403);
  });
});
