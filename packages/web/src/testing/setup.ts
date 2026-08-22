/**
 * Per-file setup for the component suite (`vitest.config.ts` → `setupFiles`).
 *
 * THREE THINGS, each of which is a bug if it is missing.
 *
 * 1. jest-dom matchers. `toBeInTheDocument`, `toHaveTextContent` and friends
 *    are not part of vitest's `expect`; without this import they are silent
 *    `undefined is not a function` at best and, with a loose assertion style,
 *    a test that cannot fail at worst.
 *
 * 2. EXPLICIT CLEANUP. React Testing Library only registers its own
 *    `afterEach(cleanup)` when the test globals are ambient. This config sets
 *    `globals: false` on purpose (a component test imports `describe`/`it`
 *    from `vitest` exactly as the node:test files import them from
 *    `node:test`), so auto-cleanup does NOT happen and the second test in a
 *    file would find two copies of the component mounted — `getByRole` then
 *    throws "found multiple elements" and the failure reads like a component
 *    bug rather than a harness one.
 *
 * 3. A FETCH TRAP. jsdom ships a real `fetch`, so a component test that forgets
 *    to stub it does not fail — it makes an actual request to a relative URL
 *    against jsdom's `about:blank`-ish origin and reports something confusing.
 *    Worse, in a repo whose whole subject is a local server, a stray absolute
 *    URL would be a real network call from a test run. Every test states what
 *    the server said; one that does not gets told so by name.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      throw new Error(
        `Unstubbed fetch in a component test: ${String(input)}. Component tests must ` +
          `stub \`globalThis.fetch\` (see packages/web/src/testing/render.tsx) — a real ` +
          `request from a test run is never what was meant.`,
      );
    }),
  );
});

afterEach(() => {
  cleanup();
});
