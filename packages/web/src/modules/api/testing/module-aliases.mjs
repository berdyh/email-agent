// An ESM resolve hook implementing the two tsconfig `paths` aliases that the
// web package's route handlers are written against.
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
// It mirrors the tsconfig deliberately and nothing more: if the two ever
// disagree, a route resolves differently under test than in the app, which is
// exactly the class of divergence a harness must not introduce. The
// index-then-file fallback matches the tsconfig's own two entries for
// `@email-agent/core/*` and `@email-agent/core/gmail/operations`.

import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
// .../packages/web/src/modules/api/testing -> .../packages/web/src
const WEB_SRC = join(here, "..", "..", "..");
// -> .../packages/core/src
const CORE_SRC = join(WEB_SRC, "..", "..", "core", "src");

const CORE_PREFIX = "@email-agent/core/";

function firstExisting(candidates) {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  return candidates[0];
}

function resolveCoreSubpath(rest) {
  return firstExisting([
    join(CORE_SRC, rest, "index.ts"),
    join(CORE_SRC, `${rest}.ts`),
  ]);
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
    return nextResolve(pathToFileURL(resolveCoreSubpath(rest)).href, context);
  }
  return nextResolve(specifier, context);
}
