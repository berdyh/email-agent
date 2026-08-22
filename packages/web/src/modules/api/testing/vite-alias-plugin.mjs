// The vitest half of "the test runner resolves exactly what the app resolves".
//
// It is a THIN WRAPPER over `resolveWebSpecifier` in `module-aliases.mjs`, and
// that is the entire point: the `node --test` resolve hook and this plugin call
// the same function, so `packages/web/tsconfig.json`, tsx and vitest cannot
// drift into three different module graphs. See that file's header for why a
// more permissive test resolver is a real defect rather than a tidiness
// complaint.
//
// TWO PROPERTIES THIS MUST KEEP:
//
// 1. `enforce: "pre"`. Vitest is a Vite app, and Vite's own node resolution
//    would find `@email-agent/core` through the workspace symlink and resolve
//    it via the package `exports` map to `packages/core/dist` — a stale build,
//    a different file set, and `exports`-map semantics instead of `paths`
//    semantics. Running before that is what makes the tsconfig authoritative.
//
// 2. It THROWS on a core specifier it cannot map, and never returns `null` for
//    one. Falling through would hand the specifier back to the resolution in
//    (1) and quietly succeed against the wrong files — which is exactly the
//    silent divergence the whole arrangement exists to prevent. A vitest-side
//    canary in `module-aliases.test.ts`'s sibling proves the RUNNING resolver
//    refuses `@email-agent/core/db/utils`, not merely that this function would.
//
// `resolveId` is deliberately a plain function on the plugin object rather than
// an object form with a `handler`, so `module-aliases.test.ts` can pull it off
// the real exported config and call it directly.

import { resolveWebSpecifier } from "./module-aliases.mjs";

export const WEB_ALIAS_PLUGIN_NAME = "email-agent-web-aliases";

/**
 * The JSDoc return type is load-bearing, not decoration: without it tsc infers
 * `enforce: string` and `packages/web/vitest.config.ts` fails `npm run lint`
 * because Vite's `Plugin` wants the `"pre" | "post"` literal.
 *
 * @returns {import("vite").Plugin}
 */
export function webAliasPlugin() {
  return {
    name: WEB_ALIAS_PLUGIN_NAME,
    enforce: "pre",
    async resolveId(source, importer, options) {
      // Throws for an unmappable `@email-agent/core/...`; returns null for
      // anything that is not one of the tsconfig's aliases.
      const target = resolveWebSpecifier(source);
      if (target === null) return null;
      // Core specifiers land on a concrete `.ts` file. `@/…` does not carry an
      // extension — the tsconfig does not give it one either — so hand it back
      // to Vite's resolver, which is the same thing the `node --test` hook does
      // by deferring to `nextResolve`.
      if (target.endsWith(".ts")) return target;
      const resolved = await this.resolve(target, importer, { ...options, skipSelf: true });
      return resolved ?? target;
    },
  };
}
