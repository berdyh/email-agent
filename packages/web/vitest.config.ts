/**
 * The React-component half of this repo's test suite.
 *
 * WHY IT EXISTS. Everything else here is `node --test` through tsx, and that
 * covers route handlers, contracts, hooks-as-pure-functions and the CLI end to
 * end. What it has never covered is a component actually RENDERING — three
 * TODOS.md entries say so, and the components carry headers admitting they are
 * "verified by reading only". Reading does not catch a branch that renders the
 * wrong sentence for the state it is in, which is the failure this suite is for.
 *
 * WHY VITEST AND NOT node:test + jsdom BY HAND. Node's test runner has no
 * transform for `.tsx` (tsx the loader could do it, but nothing wires the
 * automatic JSX runtime), no DOM lifecycle, and no module mocking — and React
 * Testing Library's supported story is a Vitest/Jest environment. Bolting the
 * three together by hand is a harness nobody would maintain.
 *
 * WHY jsdom AND NOT happy-dom. Measured on this repo, not from folklore:
 *  - `window.confirm` in jsdom EXISTS and returns `undefined` (a documented
 *    no-op), so an unstubbed confirm-gated path silently early-returns rather
 *    than throwing. That is knowable and stubbable; the components here gate
 *    destructive actions on it (`SnapshotRestoreDialog`, `ApprovalPanel`), so
 *    knowing exactly what it does matters more than the milliseconds happy-dom
 *    would save.
 *  - `window.location` is jsdom's least forgiving corner and several components
 *    navigate (`UnlockScreen`, `apiFetch`'s 401 handling). jsdom's behaviour
 *    there is the one every RTL answer on the internet is written against;
 *    happy-dom's is not.
 *  - Speed is not a tiebreaker at this size: the whole component suite adds
 *    seconds, and `npm test` already spends ~26s in node:test plus two builds.
 * If the component suite ever grows to the point where startup dominates,
 * revisit — but revisit with a measurement, and re-check `confirm`, `location`
 * and focus behaviour, because those are what would change underneath.
 *
 * WHAT THIS CONFIG MUST NOT DO. `include` is `.test.tsx` ONLY. Vitest's default
 * include matches `*.test.ts` as well, which would drag every route, contract
 * and core test into a jsdom environment resolved by a different resolver — the
 * exact inverse of the divergence `webAliasPlugin` exists to prevent. A `.ts`
 * test stays with `node --test`; a component test is `.test.tsx`. A component
 * test misnamed `.test.ts` is picked up by `node --test` instead and fails
 * loudly on the first RTL import, which is the outcome we want.
 */

import { defineConfig } from "vitest/config";
import { webAliasPlugin } from "./src/modules/api/testing/vite-alias-plugin.mjs";

export default defineConfig({
  // `enforce: "pre"` inside the plugin is what keeps the tsconfig's `paths`
  // authoritative over Vite's own node resolution of the `@email-agent/core`
  // workspace symlink. See `vite-alias-plugin.mjs`.
  plugins: [webAliasPlugin()],
  // `packages/web/tsconfig.json` sets `jsx: "preserve"` for Next, which would
  // leave esbuild handing raw JSX to Node. The app's runtime JSX transform is
  // the automatic one (no `import React` anywhere in `src`), so say so here.
  esbuild: { jsx: "automatic" },
  test: {
    environment: "jsdom",
    include: ["src/**/*.test.tsx"],
    setupFiles: ["./src/testing/setup.ts"],
    // No implicit globals: a component test imports `describe`/`it`/`expect`
    // exactly as the `node --test` files import them from `node:test`, so the
    // two suites read the same way and nothing depends on ambient types.
    globals: false,
    restoreMocks: true,
    // `setup.ts` replaces `fetch` with one that throws; this is what puts the
    // real one back between files rather than leaving the trap installed.
    unstubGlobals: true,
  },
});
