// The test resolve hook must resolve exactly what the APP resolves.
//
// This is the check the hook's own comment used to assert without evidence. It
// claimed to "mirror the tsconfig deliberately and nothing more" while falling
// back to `<rest>.ts` for any core subpath with no `index.ts` — strictly more
// permissive than `packages/web/tsconfig.json`, which maps the wildcard to
// `*/index.ts` and lists exactly one explicit deep path. A test-only import
// like `@email-agent/core/db/utils` therefore resolved under test and would be
// refused by tsc and by webpack: tests passing against a module graph the
// application can never build.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it } from "node:test";
// The hook is a `.mjs` (it is loaded by `module.register()`, which needs plain
// JS). `allowJs` lets tsc infer its exports; the casts below pin the shapes
// this test relies on.
import { EXPLICIT_CORE_SUBPATHS, coreSubpathTarget } from "./testing/module-aliases.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = join(HERE, "..", "..", "..");

interface TsconfigPaths {
  compilerOptions: { paths: Record<string, string[]> };
}

async function tsconfigPaths(): Promise<Record<string, string[]>> {
  const raw = await readFile(join(WEB_ROOT, "tsconfig.json"), "utf-8");
  return (JSON.parse(raw) as TsconfigPaths).compilerOptions.paths;
}

const explicit = EXPLICIT_CORE_SUBPATHS as Record<string, string>;
const target = coreSubpathTarget as (rest: string) => string;

describe("the test resolve hook mirrors packages/web/tsconfig.json", () => {
  it("maps the wildcard to a directory barrel, exactly as the tsconfig does", async () => {
    const paths = await tsconfigPaths();
    assert.deepEqual(
      paths["@email-agent/core/*"],
      ["../core/src/*/index.ts"],
      "if the tsconfig wildcard changes, coreSubpathTarget must change with it",
    );
    assert.equal(target("db"), join("db", "index.ts"));
    assert.equal(target("config"), join("config", "index.ts"));
  });

  it("carries every explicit deep path the tsconfig lists, and no others", async () => {
    const paths = await tsconfigPaths();
    const CORE_PREFIX = "@email-agent/core/";

    // Every `@email-agent/core/...` key that is not the wildcard and not the
    // bare barrel is a deep path the app can resolve; the hook must know it.
    const deepPaths = Object.keys(paths).filter(
      (key) => key.startsWith(CORE_PREFIX) && !key.endsWith("/*"),
    );
    assert.deepEqual(
      deepPaths.sort(),
      Object.keys(explicit)
        .map((rest) => `${CORE_PREFIX}${rest}`)
        .sort(),
      "the hook's EXPLICIT_CORE_SUBPATHS and the tsconfig's deep paths must match set-for-set",
    );

    for (const key of deepPaths) {
      const rest = key.slice(CORE_PREFIX.length);
      const [tsTarget] = paths[key] ?? [];
      assert.ok(tsTarget, `${key} has no tsconfig target`);
      // "../core/src/gmail/operations.ts" -> "gmail/operations.ts"
      const relativeToCoreSrc = tsTarget.replace("../core/src/", "");
      assert.equal(
        target(rest),
        join(...relativeToCoreSrc.split("/")),
        `${key} must resolve to the same file under test as in the app`,
      );
    }
  });

  it("does NOT invent a bare-file fallback, which is the regression", () => {
    // `db/utils.ts` exists on disk. Under the old hook this resolved; under
    // tsc and webpack it never did. The hook maps it to `db/utils/index.ts`,
    // which does not exist, and `resolve` throws on a missing target — so the
    // test that reached for it fails loudly instead of passing against a graph
    // the app cannot build.
    assert.equal(target("db/utils"), join("db", "utils", "index.ts"));
    assert.notEqual(target("db/utils"), join("db", "utils.ts"));
  });
});
