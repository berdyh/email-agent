// `POST /api/actions` must not answer 404 for a file it FOUND.
//
// Two different situations reached one flat `{ error: "Action not found" }`:
// no file answers to the id, and a file answers to it and could not be loaded.
// The second was warned in the SERVER LOG and nowhere else, so a user looking
// at the action on the page was told it does not exist — which is exactly how a
// tightened source-guard rule goes silent.
//
// Real route handler, real temp `$HOME`, real files in `~/.email-agent/actions`.
// There is no HTTP and no mocking layer; a handler is a plain async function.

import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRequest,
  callHandler,
  startRouteHarness,
} from "./testing/route-harness.js";

const harness = await startRouteHarness("actions");
const actionsDir = join(harness.home, ".email-agent", "actions");
await mkdir(actionsDir, { recursive: true });

// A file that PRESENTS the id `broken` and cannot load: a value import is code,
// which the source evaluator refuses outright.
await writeFile(
  join(actionsDir, "broken.action.ts"),
  `import { readFileSync } from "node:fs";
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "broken",
  name: "Broken",
  description: readFileSync("/etc/hostname", "utf-8"),
  prompt: "p",
  requiresConfirmation: false,
  mutatesGmail: false,
};

export default action;
`,
  "utf-8",
);

// A file that loads fine, so the listing is not trivially all-broken.
await writeFile(
  join(actionsDir, "fine.action.ts"),
  `import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "fine",
  name: "Fine",
  description: "loads",
  prompt: "p",
  requiresConfirmation: false,
  mutatesGmail: false,
};

export default action;
`,
  "utf-8",
);

const route = await harness.load<{
  GET: (r: import("next/server").NextRequest) => Promise<Response>;
  POST: (r: import("next/server").NextRequest) => Promise<Response>;
}>("app/api/actions/route.ts");

const post = (actionId: string) =>
  callHandler<{ error?: string }>(
    route.POST,
    buildRequest("/api/actions", { method: "POST", body: { actionId } }),
  );

describe("POST /api/actions", () => {
  it("answers 404 only for an id nothing on disk presents", async () => {
    const result = await post("no-such-action-anywhere");
    assert.equal(result.status, 404);
    assert.match(result.body.error ?? "", /not found/i);
  });

  it("answers 422 with the real reason for a file that WAS found", async () => {
    const result = await post("broken");

    assert.equal(
      result.status,
      422,
      "a file presenting this id exists; 404 would tell the user it does not",
    );
    // The reason must reach the browser, not just the server log.
    assert.match(result.body.error ?? "", /broken/);
    assert.match(
      result.body.error ?? "",
      /import|refus|guard/i,
      `the 422 must carry UserActionMeta.problem; got: ${result.body.error ?? ""}`,
    );
  });

  it("still lists the unloadable file, so it can be edited or deleted", async () => {
    // The 422 is only useful if the action is visible. `listUserActions` keeps
    // a file that yields no action, carrying `problem` instead of a scraped
    // name — that is what makes the id in the 422 something the user can act on.
    const listed = await callHandler<Array<{ id: string; filename?: string }>>(
      route.GET,
      buildRequest("/api/actions"),
    );
    assert.equal(listed.status, 200);
    const ids = listed.body.map((entry) => entry.id);
    assert.ok(ids.includes("broken"), "the unloadable file stays listed");
    assert.ok(ids.includes("fine"), "and it does not hide the ones that load");
  });
});
