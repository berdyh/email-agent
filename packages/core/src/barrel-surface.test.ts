import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, it } from "node:test";
import * as rootBarrel from "./index.js";
import * as gmailBarrel from "./gmail/index.js";
import * as actionsBarrel from "./actions/index.js";
import * as gmailOps from "./gmail/operations.js";

// The approval gate rests on user actions (dynamically imported, in-process)
// having no public specifier that reaches Gmail mutation. These names must
// never come back to a public barrel; only core-internal relative imports may
// use them. The deny list is DERIVED from operations.ts so a newly added
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
    // User actions resolve through package.json `exports` to dist, not src.
    // `npm test` builds core first, so this asserts against the artifact a
    // dynamically imported action would actually receive — a stale dist that
    // still exports the write ops fails here even when the source is clean.
    const distRoot = (await import("@email-agent/core")) as object;
    const distGmail = (await import("@email-agent/core/gmail")) as object;
    const distActions = (await import("@email-agent/core/actions")) as object;
    assertAbsent(distRoot, "dist root barrel");
    assertAbsent(distGmail, "dist gmail barrel");
    assertAbsent(distActions, "dist actions barrel");
  });

  it("still exports the approval-enforcing surface", () => {
    // These stay public on purpose: they only act on queued rows, so the CLI
    // (barrel-only imports) and web approvals routes can drive the flow.
    assert.equal(typeof actionsBarrel.enqueueOperations, "function");
    assert.equal(typeof actionsBarrel.applyPendingOperationsByIds, "function");
    assert.equal(typeof actionsBarrel.rejectPendingOperationsByIds, "function");
    assert.equal(typeof actionsBarrel.mapResultToOperations, "function");
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
