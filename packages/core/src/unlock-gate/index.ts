/**
 * Whether the browser unlock gate is armed, and saying so when it is not.
 *
 * ─── WHY THIS IS ITS OWN MODULE, AND WHY IT MUST STAY `node:`-FREE ───────────
 *
 * Three exports, all of which read only `process.env`, `globalThis` and a log
 * function. They used to live in `../config/session.ts` beside everything else
 * about the gate, and they were moved out for one measured reason:
 * `packages/web/src/instrumentation.ts` (Next's server-startup hook — the thing
 * that makes `npm run dev` and `npm run start` announce a disarmed gate at all)
 * is compiled for the EDGE runtime as well as the node one, and webpack traces
 * its dynamic import chain in BOTH. `session.ts` imports `node:crypto` and
 * `node:fs` at the top, so a chain reaching it produced, on every `next dev`
 * start (verified 2026-08-22 against Next 15.5.19):
 *
 *     ⨯ node:crypto
 *     Module build failed: UnhandledSchemeError: Reading from "node:crypto"
 *     is not handled by plugins (Unhandled scheme).
 *
 * A `process.env.NEXT_RUNTIME !== "nodejs"` early return does NOT prevent this
 * — webpack traces the import regardless of what the branch does at runtime.
 * The fix is a clean chain, not a cleverer guard. So: NOTHING in this file may
 * import a `node:` builtin, or anything that transitively does, and a test
 * fails if one appears.
 *
 * `config/session.ts` re-exports all three, so every existing importer — the
 * API guards, `email-agent serve`, `email-agent unlock`, the CLI barrel — is
 * unaffected by where they live.
 */

/**
 * Whether the unlock gate applies to this process at all.
 *
 * `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` already means "I meant to expose this"
 * — it turns off the API's local-origin header checks and opens `serve`'s bind —
 * and it turns this off in the same breath. The alternative would leave the LAN
 * browser that flag exists for staring at an unlock screen for a token printed
 * on a machine it cannot see.
 *
 * This is the ONLY environment variable the unlock mechanism reads anywhere.
 * There is deliberately no "arming" variable: the gate is on unless this flag
 * says otherwise, whether the server was started by `email-agent serve`, `npm
 * run dev` or `npm run start`. That is what makes a stale `.env` harmless in
 * the ARMING direction — see `../config/session.ts`'s header — and it is also
 * why the DISARMING direction needs `warnIfUnlockGateDisabled` below: the one
 * variable this does read is a disarming one, and `.env.example` ships a
 * commented line for it.
 */
export function isUnlockGateEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"] !== "1";
}

/**
 * The one wording for "this server is running with its gate off", so the CLI
 * parent and the web process cannot describe the same state two different ways.
 *
 * It names the `.env` explicitly, and that is the whole point of the sentence:
 * the measured way to reach this state is a repo-root `.env` carrying
 * `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` — copied from `.env.example`, which
 * ships a commented line for it — and loaded into the server by
 * `packages/web/next.config.ts`'s `process.loadEnvFile` before Next boots. A
 * user who never typed the variable into a shell has nowhere to look otherwise,
 * and would grep their shell profile forever.
 */
export const UNLOCK_GATE_DISABLED_LINES: readonly string[] = [
  "SECURITY: the browser unlock gate is OFF for this run " +
    "(EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1).",
  "Anything that can reach this port can read your mail and approve queued Gmail",
  "changes without unlocking, and the API's local-origin header checks are off too.",
  "If you did not set that variable yourself, look in the repo-root `.env`:",
  "packages/web/next.config.ts loads it into this process before Next boots, and",
  ".env.example ships a commented line for it.",
];

/**
 * The once-per-process marker for the warning below, deliberately parked on
 * `globalThis` under a REGISTERED symbol rather than in a module-level `let`.
 *
 * This is not defensive style, it is the documented behaviour of the host:
 * AGENTS.md records (measured from a production build) that Next does NOT
 * guarantee one module instance per process — `app/api/auth/callback/route.js`
 * carries its own inlined copy of `config/defaults.ts` + `config/settings.ts`,
 * and the same literals appear in two shared chunks besides. A module-level
 * boolean in THIS file can therefore exist several times over in one server,
 * and "warn once" would become "warn once per copy": three or four identical
 * blocks, which reads as three or four problems and trains the reader to skip
 * them. `Symbol.for` resolves through the cross-realm registry and `globalThis`
 * is shared by every copy in one isolate, so all of them see one flag.
 *
 * Since the instrumentation split above, this is load-bearing across BUNDLES
 * and not merely across duplicated route chunks: Next compiles the startup hook
 * into its own bundle, which carries its own copy of this module, while the
 * route handlers carry another. The registry symbol is the only thing those two
 * copies share, and it is what makes them warn once between them rather than
 * once each.
 *
 * The name is a test seam as much as an implementation detail — a test resets
 * the state by deleting this key — so it is pinned by `session.test.ts` and
 * must not be renamed casually.
 */
const UNLOCK_GATE_WARNED = Symbol.for("email-agent.unlock-gate-disabled-warned");

/**
 * Says out loud, ONCE per process, that the gate is disarmed. Returns whether
 * this call was the one that printed.
 *
 * WHY THIS EXISTS. `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` turns off the header
 * checks, the session requirement AND the page gate in one move, and until this
 * function existed the ONLY thing that ever said so was `email-agent serve` —
 * a process that `npm run dev` and `npm run start` never go anywhere near. So a
 * `.env` file nobody typed into a shell disarmed the whole gate in total
 * silence: measured against a real `next dev`, an unauthenticated
 * `GET /api/settings` returned 200 with the settings body, `GET /mail` returned
 * 200 with no redirect, a `Host: evil.example` request with neither `Origin` nor
 * `Sec-Fetch-Site` reached the handler, and the server log said nothing at all.
 * A security control that can be switched off without announcing it is the same
 * class of failure as a settings cache that keeps auto-applying after the user
 * turns it off — this repo refuses that class.
 *
 * WHY THE WARNING RATHER THAN A REFUSAL: the flag is a supported, documented
 * escape hatch (a LAN deployment, a headless local client, `curl` debugging).
 * Refusing to start would break the people it exists for. Being loud costs them
 * six lines once per server.
 *
 * DELIBERATE, AND NOT A BUG TO FIX LATER: under `email-agent serve` with the
 * flag set only in the repo-root `.env`, the CLI parent does not see it —
 * `loadEnvFile` runs in the CHILD — so the parent prints an unlock link while
 * the child warns the gate is off. That contradiction is the residual
 * SURFACING, exactly as intended: before this, the same run printed the link
 * and said nothing. The last line below tells the reader which half wins.
 */
export function warnIfUnlockGateDisabled(
  env: NodeJS.ProcessEnv = process.env,
  log: (message: string) => void = console.warn,
): boolean {
  if (isUnlockGateEnabled(env)) return false;
  const global = globalThis as Record<symbol, unknown>;
  if (global[UNLOCK_GATE_WARNED] === true) return false;
  global[UNLOCK_GATE_WARNED] = true;
  log(
    [
      "",
      ...UNLOCK_GATE_DISABLED_LINES,
      "Any unlock link printed for this run is unnecessary while the flag is set.",
      "",
    ].join("\n"),
  );
  return true;
}
