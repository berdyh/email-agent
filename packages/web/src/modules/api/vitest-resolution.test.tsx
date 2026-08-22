/**
 * "The three resolvers agree" as a TEST RESULT, on the vitest side.
 *
 * `module-aliases.test.ts` (node:test) reads `packages/web/tsconfig.json` and
 * checks the shared mapping function against it, and checks that
 * `vitest.config.ts` actually installs the plugin that calls it. That is a
 * check on FUNCTIONS. This file is the check on the RUNNING RESOLVER: it makes
 * vitest actually resolve specifiers and asserts what came back, so a config
 * that stopped applying the plugin — a renamed option, a `plugins` array
 * overwritten by a merge, an `enforce` that no longer runs first — fails here
 * even though every function still agrees with every other function.
 *
 * WHY THE SPECIFIERS ARE COMPUTED RATHER THAN WRITTEN INLINE. Vite's
 * `import-analysis` resolves a STATIC `import("literal")` at transform time, so
 * a literal bad specifier fails the whole file before any test runs and cannot
 * be asserted on. `/* @vite-ignore *\/` plus a variable defers it to the module
 * runner, which is the path a real import takes anyway. (Worth knowing on its
 * own: a static import of an unmappable core subpath in ANY component test
 * kills that file loudly at transform time. That is the desired outcome — it is
 * simply not the one you can write an assertion about.)
 *
 * This file lives under `modules/api/` because `check-module-boundaries.mjs`
 * refuses the string `@email-agent/core` anywhere else under `packages/web/src`.
 */

import { describe, expect, it } from "vitest";

const CORE_BARREL = "@email-agent/core/config";
const UNMAPPABLE_CORE_SUBPATH = "@email-agent/core/db/utils";

describe("vitest resolves what packages/web/tsconfig.json resolves", () => {
  it("refuses a core subpath the tsconfig also refuses, instead of finding it some other way", async () => {
    // `db/utils.ts` exists on disk. The tsconfig wildcard maps this to
    // `core/src/db/utils/index.ts`, which does not — so tsc and webpack both
    // refuse it, and a test runner that accepted it would let a test pass
    // against a module graph the app can never build. The message is the shared
    // resolver's own, which is what proves the plugin (not Vite's node
    // resolution, and not a fallback) answered.
    await expect(import(/* @vite-ignore */ UNMAPPABLE_CORE_SUBPATH)).rejects.toThrow(
      /\[module-aliases\]/,
    );
  });

  it("maps a core barrel to core/src, NOT to the dist build the package exports map names", async () => {
    // This is the failure mode with teeth. `@email-agent/core`'s `exports` map
    // lists `"./config": "./dist/config/index.js"`, and vitest is a Vite app
    // whose own node resolution would follow the workspace symlink and take it
    // — silently, successfully, and against a build that may be stale or absent.
    // The tsconfig maps it to SOURCE, so the plugin has to win.
    //
    // Proven by module identity: vite-node caches by resolved path, so the
    // barrel specifier and the source file are the same module object only if
    // they resolved to the same file.
    const viaAlias = await import(/* @vite-ignore */ CORE_BARREL);
    const viaSourcePath = await import(
      /* @vite-ignore */ new URL("../../../../core/src/config/index.ts", import.meta.url).pathname
    );
    expect(viaAlias).toBe(viaSourcePath);
  });
});
