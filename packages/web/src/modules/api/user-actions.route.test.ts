// `POST /api/actions/user` — the save route's built-in-conflict check.
//
// The check used to read an action's id with a bare regex over raw source
// text (`extractActionId`, since deleted from `@/lib/action-id`). A file that
// binds the id through a name (`const ID = "junk"; export default { id: ID, ...
// }`) is accepted by core's AST evaluator — `evaluatePureData` resolves
// identifiers against names the file bound earlier — but the regex only
// matches a literal on the `id:` line, so it returned null, the conflict
// block was skipped, and the file saved to disk shadowing a built-in action.
//
// The fix reads identity the same way core's own loader does:
// `extractActionData()`. This file is the first coverage `POST
// /api/actions/user` has ever had — there was no test for this route's happy
// path, guard-refusal path or conflict path before it.
//
// Real handler, real temp `$HOME`, real files. No HTTP, no mocking layer.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRequest,
  callHandler,
  startRouteHarness,
} from "./testing/route-harness.js";

const harness = await startRouteHarness("user-actions");
const actionsDir = join(harness.home, ".email-agent", "actions");

const route = await harness.load<{
  POST: (r: import("next/server").NextRequest) => Promise<Response>;
}>("app/api/actions/user/route.ts");

const readSaved = (filename: string) => readFile(join(actionsDir, filename), "utf-8");
const assertAbsent = async (filename: string) => {
  await assert.rejects(readSaved(filename), /ENOENT/, `${filename} must not have been written`);
};

// Keeps the id off the literal `id: "..."` shape the old regex matched, and
// keeps every other field free of the substring `id:` followed by a quote —
// otherwise the pre-fix/post-fix cases would not be deterministic.
const SHADOWING_SOURCE = `import type { EmailAction } from "@email-agent/core";

const ID = "junk";

const action: EmailAction = {
  id: ID,
  name: "Shadow",
  description: "collides with the built-in junk action",
  prompt: "p",
};

export default action;
`;

const LITERAL_CONFLICT_SOURCE = `import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "junk",
  name: "Shadow (literal)",
  description: "d",
  prompt: "p",
};

export default action;
`;

const NON_CONFLICTING_CONST_SOURCE = `import type { EmailAction } from "@email-agent/core";

const ID = "totally-new-action";

const action: EmailAction = {
  id: ID,
  name: "New",
  description: "d",
  prompt: "p",
};

export default action;
`;

// Both violates the guard (a call expression) AND its literal id collides.
const GUARD_VIOLATION_AND_CONFLICT_SOURCE = `import { readFileSync } from "node:fs";
import type { EmailAction } from "@email-agent/core";

const action: EmailAction = {
  id: "junk",
  name: "Shadow (unsafe)",
  description: readFileSync("/etc/hostname", "utf-8"),
  prompt: "p",
};

export default action;
`;

describe("POST /api/actions/user", () => {
  it("refuses a const-bound id that shadows a built-in action, and never writes the file", async () => {
    const result = await callHandler<{ error: string }>(
      route.POST,
      buildRequest("/api/actions/user", {
        method: "POST",
        body: { filename: "shadow.action.ts", content: SHADOWING_SOURCE },
      }),
    );

    assert.equal(result.status, 409);
    assert.match(result.body.error, /junk/);
    await assertAbsent("shadow.action.ts");
  });

  it("still refuses a literal id that shadows a built-in action (baseline, unaffected by the fix)", async () => {
    const result = await callHandler<{ error: string }>(
      route.POST,
      buildRequest("/api/actions/user", {
        method: "POST",
        body: { filename: "shadow-literal.action.ts", content: LITERAL_CONFLICT_SOURCE },
      }),
    );

    assert.equal(result.status, 409);
    await assertAbsent("shadow-literal.action.ts");
  });

  it("saves a const-bound, non-conflicting id", async () => {
    const result = await callHandler<{ success: boolean; filename: string }>(
      route.POST,
      buildRequest("/api/actions/user", {
        method: "POST",
        body: { filename: "new-action.action.ts", content: NON_CONFLICTING_CONST_SOURCE },
      }),
    );

    assert.equal(result.status, 200);
    assert.match(await readSaved("new-action.action.ts"), /totally-new-action/);
  });

  it("answers 422 with violations, not 409, when a colliding file also violates the source guard", async () => {
    // Precedence pin: extractActionData throws UnsafeActionSourceError before
    // the conflict check can run, so a file that is BOTH unsafe AND collides
    // is reported for the guard violation — the more fundamental problem, and
    // the one the chat UI needs `.violations` to fix.
    const result = await callHandler<{ error: string; violations?: Array<{ rule: string }> }>(
      route.POST,
      buildRequest("/api/actions/user", {
        method: "POST",
        body: {
          filename: "shadow-unsafe.action.ts",
          content: GUARD_VIOLATION_AND_CONFLICT_SOURCE,
        },
      }),
    );

    assert.equal(result.status, 422);
    assert.ok((result.body.violations ?? []).length > 0, "the rules must reach the browser");
    await assertAbsent("shadow-unsafe.action.ts");
  });

  it("is behind the mutation guard", async () => {
    const result = await callHandler(
      route.POST,
      buildRequest("/api/actions/user", {
        method: "POST",
        body: { filename: "shadow-guarded.action.ts", content: SHADOWING_SOURCE },
        sameOrigin: false,
      }),
    );

    assert.equal(result.status, 403);
    await assertAbsent("shadow-guarded.action.ts");
  });
});
