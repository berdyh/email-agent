import assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as rootBarrel from "./index.js";
import * as gmailBarrel from "./gmail/index.js";
import * as actionsBarrel from "./actions/index.js";

// The approval gate rests on user actions (dynamically imported, in-process)
// having no public specifier that reaches Gmail mutation. These names must
// never come back to a public barrel; only ActionRunner's relative-import
// path may use them, after queue rows are claimed.
const mutatingGmailOps = [
  "markAsRead",
  "markAsUnread",
  "trashMessage",
  "markAsSpam",
  "addLabels",
  "removeLabels",
] as const;

describe("public barrel surface (approval-gate enforcement)", () => {
  it("root barrel exports no raw Gmail write operation", () => {
    for (const name of mutatingGmailOps) {
      assert.equal(name in rootBarrel, false, `root barrel exports ${name}`);
    }
  });

  it("root barrel does not export applyOperations", () => {
    assert.equal("applyOperations" in rootBarrel, false);
  });

  it("gmail sub-barrel exports no raw Gmail write operation", () => {
    for (const name of mutatingGmailOps) {
      assert.equal(name in gmailBarrel, false, `gmail barrel exports ${name}`);
    }
  });

  it("actions sub-barrel does not export applyOperations", () => {
    assert.equal("applyOperations" in actionsBarrel, false);
  });

  it("still exports the approval-enforcing surface", () => {
    // These stay public on purpose: they only act on queued rows, so the CLI
    // (barrel-only imports) and web approvals routes can drive the flow.
    assert.equal(typeof actionsBarrel.enqueueOperations, "function");
    assert.equal(typeof actionsBarrel.applyPendingOperationsByIds, "function");
    assert.equal(typeof actionsBarrel.rejectPendingOperationsByIds, "function");
    assert.equal(typeof actionsBarrel.mapResultToOperations, "function");
  });

  it("Node's exports map refuses the deep operations path", () => {
    // Web reaches gmail/operations through a webpack-only tsconfig path; the
    // same specifier must stay unresolvable for runtime import(), which is
    // how user actions are loaded.
    assert.throws(
      () => import.meta.resolve("@email-agent/core/gmail/operations"),
      (err: unknown) =>
        (err as NodeJS.ErrnoException).code === "ERR_PACKAGE_PATH_NOT_EXPORTED",
    );
    // Sanity check that self-resolution works at all, so the assertion above
    // cannot pass vacuously on a broken resolver.
    assert.ok(import.meta.resolve("@email-agent/core"));
  });
});
