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
import { WEB_ALIAS_PLUGIN_NAME } from "./testing/vite-alias-plugin.mjs";
import webVitestConfig from "../../../vitest.config";

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

/**
 * THE THIRD RESOLVER.
 *
 * The block above pins the `node --test` hook against the tsconfig. Since the
 * component suite landed there is a third resolver in the repo — vitest — and
 * "it uses the same function" is exactly the kind of claim the hook's own
 * header used to make about the tsconfig while quietly being more permissive.
 *
 * So this drives the plugin instance OUT OF THE REAL EXPORTED CONFIG, not a
 * freshly constructed one: a `vitest.config.ts` that stopped installing the
 * plugin, or installed it without `enforce: "pre"` (which is what keeps the
 * tsconfig authoritative over Vite's own resolution of the `@email-agent/core`
 * workspace symlink to `dist`), fails here.
 *
 * `src/modules/api/vitest-resolution.test.tsx` is the other half and cannot be
 * replaced by this one: this checks the config object, that one makes the
 * RUNNING vitest resolve real specifiers.
 */
describe("packages/web/vitest.config.ts resolves the same way", () => {
  const CORE_SRC = join(WEB_ROOT, "..", "core", "src");

  interface MinimalPlugin {
    name: string;
    enforce?: string;
    resolveId: (
      this: { resolve: (id: string) => Promise<{ id: string } | null> },
      source: string,
      importer: string | undefined,
      options: Record<string, unknown>,
    ) => Promise<string | { id: string } | null>;
  }

  function aliasPlugin(): MinimalPlugin {
    const plugins = (webVitestConfig as { plugins?: unknown[] }).plugins ?? [];
    const found = plugins
      .flat()
      .find((plugin): plugin is MinimalPlugin =>
        Boolean(plugin && typeof plugin === "object" && "name" in plugin &&
          (plugin as { name: unknown }).name === WEB_ALIAS_PLUGIN_NAME));
    assert.ok(found, `vitest.config.ts must install the "${WEB_ALIAS_PLUGIN_NAME}" plugin`);
    return found;
  }

  // A stand-in for Vite's plugin context. `@/…` has no extension in the
  // tsconfig either, so both hosts finish that resolution themselves; this
  // records what the plugin handed over.
  const ctx = { resolve: async (id: string) => ({ id }) };

  it("is installed, and runs before Vite's own node resolution", () => {
    assert.equal(aliasPlugin().enforce, "pre");
  });

  it("maps core specifiers to exactly the files the tsconfig names", async () => {
    const paths = await tsconfigPaths();
    const plugin = aliasPlugin();

    assert.equal(
      await plugin.resolveId.call(ctx, "@email-agent/core", undefined, {}),
      join(CORE_SRC, "index.ts"),
    );
    // The wildcard, read off the tsconfig rather than restated.
    const [wildcard] = paths["@email-agent/core/*"] ?? [];
    assert.equal(wildcard, "../core/src/*/index.ts");
    assert.equal(
      await plugin.resolveId.call(ctx, "@email-agent/core/db", undefined, {}),
      join(CORE_SRC, "db", "index.ts"),
    );
    // Every explicit deep path, same set the hook carries.
    for (const rest of Object.keys(explicit)) {
      assert.equal(
        await plugin.resolveId.call(ctx, `@email-agent/core/${rest}`, undefined, {}),
        join(CORE_SRC, target(rest)),
      );
    }
  });

  it("maps @/ to the web source root, as the tsconfig does", async () => {
    const paths = await tsconfigPaths();
    assert.deepEqual(paths["@/*"], ["./src/*"]);
    assert.deepEqual(
      await aliasPlugin().resolveId.call(ctx, "@/modules/api/snapshot-contract", undefined, {}),
      { id: join(WEB_ROOT, "src", "modules", "api", "snapshot-contract") },
    );
  });

  it("THROWS on an unmappable core subpath rather than letting Vite find dist", async () => {
    // Returning null here is the dangerous outcome, not an error: Vite would
    // fall back to node resolution, follow the workspace symlink and resolve
    // through the package `exports` map — a different file set, under different
    // semantics, quietly.
    await assert.rejects(
      () => aliasPlugin().resolveId.call(ctx, "@email-agent/core/db/utils", undefined, {}),
      /\[module-aliases\]/,
    );
  });

  it("leaves every non-alias specifier to Vite", async () => {
    for (const specifier of ["react", "@testing-library/react", "./sibling", "node:fs"]) {
      assert.equal(
        await aliasPlugin().resolveId.call(ctx, specifier, undefined, {}),
        null,
        `${specifier} must not be claimed by the alias plugin`,
      );
    }
  });
});
