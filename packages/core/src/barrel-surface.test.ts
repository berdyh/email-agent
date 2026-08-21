import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import * as rootBarrel from "./index.js";
import * as gmailBarrel from "./gmail/index.js";
import * as actionsBarrel from "./actions/index.js";
import * as gmailOps from "./gmail/operations.js";

// Defense in depth, NOT a sandbox — and no longer the layer the approval gate
// rests on. User action files are now PARSED as pure data and never imported
// (`extractActionData`), so no code from `ACTIONS_DIR` runs in this process at
// all; every caller of the approval surface below is therefore the repo's own
// code. That is what makes the surface safe: not that callers prove who they
// are — inside one process they cannot — but that there is no untrusted caller
// in the process to begin with. Malicious local code OUTSIDE the action
// pathway is still out of scope: it can read the stored OAuth tokens and call
// the Gmail REST API directly, touching nothing in this repo (see TODOS.md).
//
// What this file pins is the naive route: no public specifier resolves to
// Gmail mutation, so anything that imports the mutating surface by name fails
// loudly instead of silently mutating a mailbox. These names must never come
// back to a public barrel; only
// core-internal relative imports may use them. The deny list is DERIVED from
// operations.ts so a newly added
// write op is denied by construction, plus the raw client factories (every
// write op is a one-line wrapper over createGmailClient) and applyOperations.
const deniedNames = [
  ...Object.keys(gmailOps),
  "createGmailClient",
  "createGmailClientForAccount",
  "applyOperations",
] as const;

// The exports map is the only resolution surface Node consults for user-action
// imports. Any new key is a new public surface and must be a deliberate,
// reviewed change.
const allowedExportKeys = [
  ".",
  "./actions",
  "./agents",
  "./analysis",
  "./config",
  "./db",
  "./gmail",
] as const;

function assertAbsent(barrel: object, barrelName: string): void {
  for (const name of deniedNames) {
    assert.equal(name in barrel, false, `${barrelName} exports ${name}`);
  }
}

describe("public barrel surface (approval-gate enforcement)", () => {
  it("source barrels export no Gmail-mutating surface", () => {
    assertAbsent(rootBarrel, "root barrel");
    assertAbsent(gmailBarrel, "gmail barrel");
    assertAbsent(actionsBarrel, "actions barrel");
  });

  it("dist barrels served by the exports map export no Gmail-mutating surface", async () => {
    // Anything resolving this package by name gets dist through the
    // package.json `exports` map, not src. `npm test` builds core first, so this
    // asserts against the artifact such a caller actually receives — a stale
    // dist that still exports the write ops fails here even when the source is
    // clean. (User action files are not such a caller any more: they are parsed
    // as data and never imported. In-tree and web callers are.)
    const distRoot = (await import("@email-agent/core")) as object;
    const distGmail = (await import("@email-agent/core/gmail")) as object;
    const distActions = (await import("@email-agent/core/actions")) as object;
    assertAbsent(distRoot, "dist root barrel");
    assertAbsent(distGmail, "dist gmail barrel");
    assertAbsent(distActions, "dist actions barrel");
  });

  it("keeps the Gmail label READER out of every barrel, without denying it as a mutator", () => {
    // Deliberately its own case rather than an entry in `deniedNames`. That
    // list is derived from `Object.keys(gmailOps)` and means "this writes to a
    // mailbox"; putting a read-only name in it would make the assertion say
    // something it does not mean. What is asserted here is narrower and true:
    // the reader hands back mailbox content by message id, so it stays
    // core-internal and reachable only through the verification function that
    // needs it.
    for (const [name, barrel] of [
      ["root barrel", rootBarrel],
      ["gmail barrel", gmailBarrel],
      ["actions barrel", actionsBarrel],
    ] as const) {
      assert.equal(
        "readMessageLabels" in barrel,
        false,
        `${name} exports readMessageLabels`,
      );
      assert.equal(
        "readMessageLabelsFromGmail" in barrel,
        false,
        `${name} exports readMessageLabelsFromGmail`,
      );
    }
  });

  it("still exports the queue-driving surface the approval UIs need", () => {
    // These stay public on purpose: the CLI (barrel-only imports) and the web
    // approvals routes drive the flow through them. They are NOT an
    // enforcement boundary — `applyPendingOperationsByIds` takes row ids and
    // checks only that the rows are `pending`, carrying no approval
    // provenance, and it never could: ESM module identity is process-global,
    // so any function the CLI can call, in-process code can call with
    // identical standing. The protection is upstream — action files are parsed
    // as data, so nothing untrusted is in the process to make the call.
    assert.equal(typeof actionsBarrel.enqueueOperations, "function");
    assert.equal(typeof actionsBarrel.applyPendingOperationsByIds, "function");
    assert.equal(typeof actionsBarrel.rejectPendingOperationsByIds, "function");
    assert.equal(typeof actionsBarrel.mapResultToOperations, "function");
    // The verification pass is the surfaces' entry point for checking a
    // stranded apply against Gmail. Listed here so a barrel cleanup cannot
    // strip it silently — the reader it uses stays private, this does not.
    assert.equal(
      typeof actionsBarrel.verifyStrandedApplyingOperations,
      "function",
    );
    assert.equal(typeof actionsBarrel.verdictFromLabels, "function");
  });

  it("package exports map stays the pinned allowlist", async () => {
    // A targeted new entry (e.g. "./gmail/operations" or "./actions/apply")
    // would re-open a mutation path without touching any barrel; pin the keys
    // so that surface change has to be made here, consciously.
    const pkg = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { exports: Record<string, string> };
    assert.deepEqual(
      Object.keys(pkg.exports).sort(),
      [...allowedExportKeys].sort(),
    );
  });

  it("Node's exports map refuses the deep operations path", () => {
    // Web reaches gmail/operations through a webpack-only tsconfig path; the
    // same specifier must stay unresolvable for a runtime import(). Note the
    // parent context matters and this test's is the workspace: from the real
    // ACTIONS_DIR (~/.email-agent/actions) NO bare specifier resolves at all,
    // not even `googleapis`. So this pins the workspace-resolvable case (web
    // bundling, future in-tree action loading), not the user-action path.
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
