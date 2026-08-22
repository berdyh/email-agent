/**
 * The printed unlock link, and the block of text around it.
 *
 * Shared by `email-agent serve` (which prints one on startup) and `email-agent
 * unlock` (which prints one on demand, for a server that is already running or
 * was never started by `serve` at all). Kept as pure functions so both commands
 * are testable without spawning anything.
 */

import { UNLOCK_GATE_DISABLED_LINES } from "@email-agent/core";

/**
 * `http://<host>:<port>/unlock?exchange=1#token=<token>`, with an IPv6 host
 * bracketed.
 *
 * ─── THE TOKEN IS IN THE FRAGMENT, AND THAT IS THE WHOLE POINT ───────────────
 *
 * It was in the QUERY STRING until 2026-08-22, and the comment here argued for
 * that shape on the grounds that the cost was "any access log a future version
 * might keep". There was no future version: `email-agent serve` spawns `next
 * dev`, whose installed request logger prints the COMPLETE `request.url`
 * (`node_modules/next/dist/server/dev/log-requests.js`, `logIncomingRequests`),
 * so every unlock printed the live token a second time, into the same terminal
 * and into anything capturing that server's output.
 *
 * A fragment is never SENT to a server by any browser — not to this one, not to
 * a proxy, and not in a `Referer` header. So it cannot reach that logger, or any
 * other. The unlock page reads `location.hash` in the browser, POSTs the token
 * to the exchange route in a request BODY, and clears the hash.
 *
 * `?exchange=1` is a NON-SECRET marker that lets the server-rendered page know
 * this navigation is carrying a token it cannot see, so it renders the exchange
 * component directly instead of flashing the lock screen first. It is safe to
 * log, because it says only that somebody is unlocking.
 *
 * ─── WHAT A FRAGMENT DOES NOT FIX, STATED RATHER THAN GLOSSED ────────────────
 *
 * The token still reaches the browser, and the browser is on this machine. After
 * `history.replaceState` clears the hash, what remains is: the terminal
 * scrollback that printed the link; the clipboard, if it was copied; and the
 * browser's own history/omnibox database, which can record the navigated URL —
 * fragment included — at navigation commit, BEFORE any script runs, and
 * therefore before the page can clear it. `replaceState` rewrites the current
 * session-history entry, not necessarily every trace of the URL the browser has
 * already persisted. All of that is local to the user whose terminal printed the
 * token in the first place; what the fragment removes is the copy that reached a
 * SERVER.
 *
 * The host is printed EXACTLY as the server bound it, and that matters more
 * than it looks: the session cookie carries no `Domain`, so it is host-only.
 * `localhost:3847` and `127.0.0.1:3847` hold separate sessions, and unlocking
 * one does not unlock the other. Printing the address the user should actually
 * use is what keeps that from costing them a second token.
 */
export function buildUnlockUrl(host: string, port: string, token: string): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `http://${authority}:${port}/unlock?exchange=1#token=${token}`;
}

/**
 * The block `serve` and `unlock` print, as lines.
 *
 * `pendingServerStart` is `serve`'s case, and the sentence it adds is
 * DELIBERATE: `serve` spawns the Next child with `stdio: "inherit"` and cannot
 * watch it for a readiness line without switching to pipes and forwarding
 * everything — about thirty lines of machinery to avoid a two-second
 * "connection refused" for a user who clicks instantly. Saying so costs one
 * sentence. `unlock` omits it, because the server it is handing a link to is
 * usually already up.
 */
export function describeUnlockLines(
  url: string,
  { pendingServerStart = false }: { pendingServerStart?: boolean } = {},
): string[] {
  return [
    "",
    "Open this link to unlock the web UI in your browser:",
    "",
    `  ${url}`,
    "",
    ...(pendingServerStart ? ["It works once the server below reports it is ready."] : []),
    "The link can be used ONCE and expires in 10 minutes.",
    "Lost it? Run `npx email-agent unlock` for a fresh one.",
    "",
  ];
}

/**
 * What to print instead when the unlock gate is off for this run.
 *
 * `EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1` already means "I meant to expose this"
 * and turns the gate off along with the local-origin header checks. Printing a
 * token URL in that mode would misrepresent what is protecting the server —
 * nothing is.
 *
 * THE SENTENCES COME FROM CORE (`UNLOCK_GATE_DISABLED_LINES`), not from here,
 * because the web process now announces the same state itself — from
 * `instrumentation.ts` at startup and from the guard that reads the flag — so
 * that `npm run dev` and `npm run start`, which never reach this command, stop
 * disarming the gate in silence. Under `email-agent serve` the user therefore
 * sees this block from the parent and the same block again from the child, and
 * that is why they must be the SAME WORDS: one problem stated twice reads as
 * one problem, whereas two hand-written descriptions of one flag read as two.
 * The trailing line here says so outright.
 */
export function describeUnlockDisabledLines(): string[] {
  return [
    ...UNLOCK_GATE_DISABLED_LINES,
    "The web server repeats this once it starts — it is the same flag, not a second problem.",
    "",
  ];
}
