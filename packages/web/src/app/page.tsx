import { redirect } from "next/navigation";
import { cookies } from "next/headers";
import { isSessionUnlocked, SESSION_COOKIE_NAME } from "@/modules/api/validation";

/**
 * The root dispatcher: already unlocked -> `/mail`, otherwise -> `/unlock`.
 *
 * ─── IT NO LONGER HANDLES THE UNLOCK TOKEN, AND MUST NOT AGAIN ───────────────
 *
 * It used to accept `?token=…` and mount the exchange component. Two things
 * killed that, in order:
 *
 *  1. A token in the query string is SENT TO THE SERVER, and `email-agent
 *     serve` runs `next dev`, whose request logger prints the complete
 *     `request.url` — so every unlock echoed the live token into the terminal.
 *     The token now travels in the URL FRAGMENT, which no browser ever sends,
 *     and a fragment is invisible to a server component. There is nothing left
 *     here to dispatch ON. See `packages/cli/src/unlock-url.ts`.
 *  2. Handling it here forced an awkward ordering. Because a top-level
 *     navigation carries no custom header, this page cannot know whether the
 *     browser in front of it holds the origin-scoped second factor, so a
 *     cookie-first branch order sent every factorless browser into a loop
 *     (`/mail` -> 401 `binding-required` -> `/unlock` -> "click the printed
 *     link" -> here -> `/mail` -> …), and a token-first order made a stale link
 *     fail for a browser that was working fine.
 *
 * Redemption now happens on `/unlock`, which renders without a session, makes
 * no guarded calls, and — unlike this page — never redirects a valid-cookie
 * browser away before its script has read the hash. Both problems go with it:
 * there is no branch order left to get wrong, and a factorless browser that
 * clicks the printed link is redeemed where it lands.
 *
 * `isSessionUnlocked` is the PAGE gate's predicate — the cookie alone, bypass
 * included, and deliberately NOT the same predicate `sessionViolation` uses.
 * See `hasValidSession` in core for why that split is safe here.
 */
export default async function Home() {
  const jar = await cookies();
  if (isSessionUnlocked(jar.get(SESSION_COOKIE_NAME)?.value)) {
    redirect("/mail");
  }
  redirect("/unlock");
}
