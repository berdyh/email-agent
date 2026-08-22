/**
 * The printed unlock link, and the block of text around it.
 *
 * Shared by `email-agent serve` (which prints one on startup) and `email-agent
 * unlock` (which prints one on demand, for a server that is already running or
 * was never started by `serve` at all). Kept as pure functions so both commands
 * are testable without spawning anything.
 */

/**
 * `http://<host>:<port>/?token=<token>`, with an IPv6 host bracketed.
 *
 * The host is printed EXACTLY as the server bound it, and that matters more
 * than it looks: the session cookie carries no `Domain`, so it is host-only.
 * `localhost:3847` and `127.0.0.1:3847` hold separate sessions, and unlocking
 * one does not unlock the other. Printing the address the user should actually
 * use is what keeps that from costing them a second token.
 *
 * The token does travel in a query string, which is a real cost and worth
 * naming: it lands in the browser's history entry for that navigation, and in
 * any access log a future version might keep. Against that: the link is burned
 * on first use, it expires in ten minutes unused, and the alternative — asking
 * a person to copy a 43-character token out of a terminal into a form — is worse
 * for the same threat model. This is Jupyter's shape, for the same reasons.
 */
export function buildUnlockUrl(host: string, port: string, token: string): string {
  const authority = host.includes(":") ? `[${host}]` : host;
  return `http://${authority}:${port}/?token=${token}`;
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
 */
export function describeUnlockDisabledLines(): string[] {
  return [
    "The browser unlock gate is OFF for this run " +
      "(EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS=1). Anything that can reach this port",
    "can read your mail and approve queued Gmail changes without unlocking.",
    "",
  ];
}
