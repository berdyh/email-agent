import { SESSION_BINDING_STORAGE_KEY } from "@/modules/api/auth-contract";

/**
 * The browser's half of the origin-scoped second factor.
 *
 * WHAT IT IS FOR. The session cookie is not enough on its own, because cookies
 * are scoped by HOST and never by PORT (RFC 6265 §8.5): every other loopback
 * port shares this app's cookie jar, so another local user who binds
 * `127.0.0.1:<anything>` can be handed the cookie by a cross-site top-level
 * GET and replay it as a bearer credential. `localStorage` IS scoped by
 * ORIGIN, and an origin includes the port, so a value kept here is unreachable
 * from that sibling port. `apiFetch` echoes it in `SESSION_BINDING_HEADER` and
 * the API guard requires both. The full argument lives on
 * `SESSION_BINDING_HEADER` in `packages/core/src/config/session.ts`.
 *
 * WHY `localStorage` AND NOT `sessionStorage`. Both are origin-scoped
 * including the port, so both defeat the sibling port equally — that is not
 * what separates them. `sessionStorage` is additionally scoped PER TAB, which
 * buys nothing here (the adversary is another ORIGIN, not another tab) and
 * costs the user real usability: a second tab, a middle-click, a restored
 * window, a browser restart — each one arrives with no value while the cookie
 * beside it is still perfectly good, so each one would need a fresh unlock
 * link from the terminal. `localStorage` matches the cookie's own lifetime
 * shape, which is the one that has to be matched.
 *
 * IT IS NOT A SECRET FROM SAME-ORIGIN SCRIPT, and choosing `sessionStorage`
 * would not have made it one — script on this app's own page reads either.
 * This closes exactly one hole: a cookie replayed from a different port.
 *
 * EVERY ACCESS IS WRAPPED. `localStorage` throws rather than returning null in
 * real situations a user can be in — Safari's private mode historically, and
 * any browser configured to block storage for a site. A throw here would take
 * out the whole fetch layer, turning "you need to unlock again" into a blank
 * page, so a failure degrades to "no factor", which is a 401 the user can act
 * on.
 */
export function readSessionBinding(): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return window.localStorage.getItem(SESSION_BINDING_STORAGE_KEY) ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * Records the second factor the unlock exchange just issued.
 *
 * MUST be called before the navigation that follows a successful unlock —
 * `window.location.replace` tears down the page, and anything still pending
 * never runs.
 *
 * A failure is swallowed for the reason above, and the consequence is stated
 * rather than hidden: the user reaches the app and every API call answers 401
 * `binding-required`, which routes them back to the unlock screen with copy
 * that names blocked site storage as a cause. That is a bad outcome; a thrown
 * exception in the unlock handler, which strands them on "Unlocking…" forever
 * with no message at all, is a worse one.
 */
export function storeSessionBinding(value: string): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(SESSION_BINDING_STORAGE_KEY, value);
  } catch {
    // See above.
  }
}
