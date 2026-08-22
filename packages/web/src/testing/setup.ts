/**
 * Per-file setup for the component suite (`vitest.config.ts` → `setupFiles`).
 *
 * FOUR THINGS, each of which is a bug if it is missing.
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
 *
 * 4. A WORKING `localStorage`, installed AT MODULE TOP LEVEL rather than in a
 *    hook. Measured on this Node/jsdom combination: `window.localStorage` is
 *    `undefined`, NOT jsdom's usual real `Storage` — Node 22+ predefines its
 *    OWN global `localStorage` accessor (gated behind `--localstorage-file`,
 *    returning `undefined` without it), and jsdom's environment setup
 *    installs its `window.localStorage` by plain assignment, which runs
 *    Node's existing SETTER instead of replacing the property. Harmless for
 *    every component so far, but `action-chat-store.ts`'s zustand `persist`
 *    middleware calls `createJSONStorage(() => window.localStorage)` and
 *    reads it EXACTLY ONCE, synchronously, at module-import time — so a fix
 *    applied in `beforeEach` (proven by hand: still crashes) is already too
 *    late, and the property must be redefined (not assigned — the same
 *    setter problem) before ANY test file's own imports run. `setupFiles`
 *    load before the test file does, which is what makes top level here
 *    early enough. `beforeEach` below only CLEARS it between tests; it must
 *    never redefine the property, or later tests keep the first test's
 *    reference and inherit its persisted `action-chat` conversation state.
 */

import "@testing-library/jest-dom/vitest";
import { afterEach, beforeEach, vi } from "vitest";
import { cleanup } from "@testing-library/react";

class MemoryStorage implements Storage {
  private store = new Map<string, string>();
  get length(): number {
    return this.store.size;
  }
  clear(): void {
    this.store.clear();
  }
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.store.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
  setItem(key: string, value: string): void {
    this.store.set(key, String(value));
  }
}

const memoryLocalStorage = new MemoryStorage();
// `Object.defineProperty`, not `globalThis.localStorage = ...`: Node's
// existing descriptor is a getter/setter pair, and a plain assignment
// invokes that setter rather than replacing it — see point 4 above.
Object.defineProperty(globalThis, "localStorage", {
  value: memoryLocalStorage,
  configurable: true,
  writable: true,
});

beforeEach(() => {
  memoryLocalStorage.clear();
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
