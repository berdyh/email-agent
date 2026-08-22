/**
 * The web process's startup entry point for "this server's unlock gate is off".
 *
 * WHY IT IS A FILE OF ITS OWN rather than one more export from
 * `validation.ts`. `src/instrumentation.ts` imports this, and Next compiles the
 * instrumentation hook for the EDGE runtime as well as the node one, tracing
 * its dynamic import chain in both. `validation.ts` reaches core's config
 * barrel, which reaches `node:crypto`/`node:fs`, so importing it from the hook
 * made every `next dev` start print
 * `⨯ node:crypto  Module build failed: UnhandledSchemeError` (measured
 * 2026-08-22 against Next 15.5.19; a `NEXT_RUNTIME` early return does not
 * prevent it — webpack traces the import whatever the branch does at runtime).
 *
 * So this file's import chain must stay free of `node:` builtins:
 * `@email-agent/core/unlock-gate` exists precisely to be that chain, and core's
 * own `unlock-gate.test.ts` fails if a builtin appears in it.
 *
 * This is NOT the only announcement. `remoteAccessAllowed()` in
 * `validation.ts` — the single place the web package reads the flag on the
 * request path — calls the same primitive, so observing the flag announces it
 * even if Next never calls `register()`. The two share one `globalThis`
 * once-flag, so between them they print exactly once per process.
 */

import { warnIfUnlockGateDisabled } from "@email-agent/core/unlock-gate";

/** Announces a disarmed gate, at most once per process. */
export function reportUnlockGateState(): void {
  warnIfUnlockGateDisabled();
}
