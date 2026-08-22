/**
 * Next's server-startup hook. It exists for exactly one thing: to make the web
 * process SAY when its browser unlock gate has been switched off.
 *
 * WHY IT HAS TO BE HERE, and not only in the CLI. `email-agent serve` prints a
 * warning when it starts a disarmed server, and for a while that was the whole
 * story — but `npm run dev` and `npm run start` never reach
 * `packages/cli/src/commands/serve.ts`, and `packages/web/next.config.ts` calls
 * `process.loadEnvFile(<repoRoot>/.env)` before Next boots. So a repo-root
 * `.env` carrying `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` — never typed into a
 * shell, and `.env.example` ships a commented line for it — disarmed the
 * local-origin header checks, the API session requirement and the page gate all
 * at once, with nothing printed anywhere. Measured against a real `next dev`:
 * unauthenticated `GET /api/settings` answered 200 with the settings body,
 * `GET /mail` answered 200 with no redirect, a `Host: evil.example` request
 * carrying neither `Origin` nor `Sec-Fetch-Site` reached the handler, and a grep
 * of the server log for any warning found nothing. A security control that can
 * be turned off without saying so is the class of failure this repo refuses.
 *
 * WHY A STARTUP HOOK AS WELL AS THE GUARD. `remoteAccessAllowed()` in
 * `modules/api/validation.ts` announces too, so anything that OBSERVES the flag
 * has announced it — but that only fires once somebody asks the server for
 * something. Announcing at boot puts the warning next to the "ready" line, where
 * the person who just started the server is looking.
 *
 * IT CANNOT SPAM. The underlying `warnIfUnlockGateDisabled()` prints at most
 * once per process, keyed on a `globalThis` symbol rather than a module-level
 * boolean, because Next does not guarantee one module instance per process
 * (AGENTS.md, measured from a production build). Under `email-agent serve` the
 * parent prints the same sentences from core's `UNLOCK_GATE_DISABLED_LINES`, so
 * the repeat reads as one problem stated twice rather than two problems.
 *
 * WHY IT IMPORTS `unlock-gate-notice` AND NOT `validation`. Next compiles this
 * hook for the EDGE runtime as well as the node one and traces its dynamic
 * import chain in BOTH — the `NEXT_RUNTIME` early return below does not stop
 * that, because webpack traces the import whatever the branch does at runtime.
 * `validation.ts` reaches core's config barrel, which reaches `node:crypto` and
 * `node:fs`, so pointing this at it made every `next dev` start print:
 *
 *     ⨯ node:crypto
 *     Module build failed: UnhandledSchemeError: Reading from "node:crypto"
 *     is not handled by plugins (Unhandled scheme).
 *
 * (Measured 2026-08-22 against Next 15.5.19; `next build` survived it with a
 * warning, `next dev` printed it on every start.) The notice module's chain is
 * deliberately free of `node:` builtins and a core test keeps it that way. The
 * `NEXT_RUNTIME` guard stays regardless — it is what keeps the edge runtime
 * from doing pointless work — but it is not what makes the chain safe.
 *
 * The dynamic import is what keeps the module out of the graph on the other
 * branch. Note also that this file names no core specifier even in prose: it is
 * not one of the two directories `scripts/check-module-boundaries.mjs` sanctions
 * for a direct core import, and that check is a TEXT scan.
 *
 * WHY IT NEVER THROWS. This hook runs before the server accepts a request. A
 * failure here must never be the reason a server does not start — the same rule
 * `serve`'s stranded-operations check follows.
 */
export async function register(): Promise<void> {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;
  try {
    const { reportUnlockGateState } = await import("@/modules/api/unlock-gate-notice");
    reportUnlockGateState();
  } catch (err) {
    console.warn(
      `Could not check whether the browser unlock gate is armed: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
