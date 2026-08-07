// An ESM resolve hook implementing the tsconfig `paths` aliases that the web
// package's route handlers are written against.
//
// WHY THIS EXISTS. `packages/web/tsconfig.json` maps `@/*` to `./src/*` and
// `@email-agent/core/*` to the core package's SOURCE. Next's bundler honours
// both; `node --test` does not. tsx can read `paths`, but only from a
// `tsconfig.json` it finds from the CWD, and the repo root has none — so a test
// that imports `app/api/auth/callback/route.ts` dies on
// `Cannot find package '@/modules'`. That single unresolved specifier is the
// entire reason TODOS.md described the API routes as "structurally untestable:
// no HTTP harness". There is no HTTP involved and never was.
//
// Registered through `module.register()`, so it applies to dynamic imports made
// AFTER the call and runs ahead of tsx's own resolver (later registrations sit
// earlier in the chain), handing tsx a concrete file URL to compile.
//
// IT MIRRORS THE TSCONFIG AND NOTHING MORE, and that is now literally true
// rather than aspirational. The wildcard maps `@email-agent/core/<rest>` to
// `<rest>/index.ts` — a DIRECTORY BARREL — exactly as the tsconfig's
// `"@email-agent/core/*": ["../core/src/*/index.ts"]` does. There is one
// explicit non-barrel entry, `gmail/operations`, and it is listed here for the
// same reason the tsconfig lists it above the wildcard.
//
// The earlier version fell back to `<rest>.ts` for any subpath that had no
// `index.ts`. That made the hook STRICTLY MORE PERMISSIVE than the resolver the
// app uses: a test-only `import "@email-agent/core/db/utils"` resolved happily
// here while tsc and webpack would both refuse it, so a test could pass against
// a module graph the application can never build. A specifier this hook cannot
// map now THROWS, naming the two ways to fix it, because a loud failure in one
// test is cheap and a silent divergence between the harness and the app is not.
// `packages/web/src/modules/api/module-aliases.test.ts` reads the tsconfig and
// fails if the two ever disagree.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// .../packages/web/src/modules/api/testing -> .../packages/web/src
const WEB_SRC = join(here, "..", "..", "..");
// -> .../packages/core/src
const CORE_SRC = join(WEB_SRC, "..", "..", "core", "src");

const CORE_PREFIX = "@email-agent/core/";

/**
 * Subpaths the tsconfig maps explicitly, ABOVE the `@email-agent/core/*`
 * wildcard. Keep this in step with `packages/web/tsconfig.json`; the test
 * asserts it.
 */
export const EXPLICIT_CORE_SUBPATHS = {
  "gmail/operations": join("gmail", "operations.ts"),
};

/**
 * The wildcard: `@email-agent/core/<rest>` is a directory barrel, never a bare
 * file. No `<rest>.ts` fallback — see the header.
 */
export function coreSubpathTarget(rest) {
  const explicit = EXPLICIT_CORE_SUBPATHS[rest];
  return explicit === undefined ? join(rest, "index.ts") : explicit;
}

export async function resolve(specifier, context, nextResolve) {
  if (specifier.startsWith("@/")) {
    const target = join(WEB_SRC, specifier.slice(2));
    return nextResolve(pathToFileURL(target).href, context);
  }
  if (specifier === "@email-agent/core") {
    return nextResolve(pathToFileURL(join(CORE_SRC, "index.ts")).href, context);
  }
  if (specifier.startsWith(CORE_PREFIX)) {
    const rest = specifier.slice(CORE_PREFIX.length);
    const target = join(CORE_SRC, coreSubpathTarget(rest));
    if (!existsSync(target)) {
      throw new Error(
        `[module-aliases] "${specifier}" does not resolve. This hook maps ` +
          `@email-agent/core/<x> to core/src/<x>/index.ts, which is exactly what ` +
          `packages/web/tsconfig.json does — so a specifier that fails here would ` +
          `also be refused by tsc and by webpack. Import the barrel ` +
          `(@email-agent/core/${rest.split("/")[0]}), or add the deep path to BOTH ` +
          `the tsconfig paths and EXPLICIT_CORE_SUBPATHS in this file.`,
      );
    }
    return nextResolve(pathToFileURL(target).href, context);
  }
  return nextResolve(specifier, context);
}
