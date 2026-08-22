/**
 * The unlock-exchange wire contract, kept CORE-FREE on purpose.
 *
 * `@email-agent/core/config` is where `UNLOCK_REQUIRED_CODE` and the real
 * `exchangeUnlockToken()`/`UnlockExchangeFailure` type actually live, and the
 * exchange ROUTE (server-side) imports those directly — it has no reason not
 * to. This file exists for the code that CANNOT import them: the unlock page
 * and `apiFetch` are client components/modules, and the config barrel pulls
 * `node:fs`/`node:crypto` at module load, which does not bundle for the
 * browser. `MODULE.md`'s rule that this directory's contract files stay free
 * of `@email-agent/core` imports is exactly this — `approvals-contract.ts`'s
 * `VerificationResidualReason` is the existing precedent for a core-free
 * duplicate rather than an import.
 *
 * A DUPLICATE STRING IS ONLY SAFE IF SOMETHING PROVES IT CANNOT DRIFT.
 * `auth-contract.test.ts` imports both this file's `UNLOCK_REQUIRED_CODE` and
 * core's and asserts they are equal — so "the client and the guard agree" is a
 * test result, not a comment two people have to remember to keep in sync.
 */

/**
 * The `code` a 401 carries when the caller simply has no session. Matches
 * `UNLOCK_REQUIRED_CODE` in `packages/core/src/config/session.ts` — see
 * `auth-contract.test.ts` for the equality that keeps it that way.
 */
export const UNLOCK_REQUIRED_CODE = "unlock-required";

/**
 * The `code` a 401 carries when the cookie IS a live session but the
 * origin-scoped second factor is absent or wrong. Matches
 * `BINDING_REQUIRED_CODE` in `packages/core/src/config/session.ts`; pinned
 * equal by `auth-contract.test.ts` for the same anti-drift reason as above.
 */
export const BINDING_REQUIRED_CODE = "binding-required";

/**
 * The request header the second factor travels in. Matches
 * `SESSION_BINDING_HEADER` in core — also pinned by `auth-contract.test.ts`,
 * and a drift here is not a cosmetic bug: the client would send a header the
 * guard never reads, and every request would 401.
 */
export const SESSION_BINDING_HEADER = "x-email-agent-session-binding";

/**
 * Where the browser keeps the second factor.
 *
 * `localStorage`, NOT `sessionStorage`, and the reason is written out at
 * length on `SESSION_BINDING_HEADER` in `packages/core/src/config/session.ts`.
 * The short version: both are scoped by ORIGIN — which includes the PORT, and
 * that is the property that defeats a sibling loopback port — but
 * `sessionStorage` is additionally per-TAB, which buys nothing against an
 * attacker who is a different origin rather than a different tab, and would
 * cost the user a fresh unlock link for every new tab and every browser
 * restart while the cookie beside it survives both.
 *
 * This key is CLIENT-ONLY and has no core counterpart, so unlike the two
 * constants above there is nothing for it to drift against.
 */
export const SESSION_BINDING_STORAGE_KEY = "email-agent.session-binding";

/**
 * The query parameter `apiFetch` adds when it sends the tab to `/unlock`
 * because of a missing/wrong second factor rather than a missing session, so
 * the unlock screen can explain the ACTUAL situation. Design point: a request
 * with a valid cookie and no factor must lead somewhere recoverable and
 * distinguishable from "no session at all".
 */
export const UNLOCK_REASON_PARAM = "reason";
export const UNLOCK_REASON_BINDING = "binding";

/**
 * The NON-SECRET marker the printed unlock link carries
 * (`/unlock?exchange=1#token=…`), and the fragment key the token itself is in.
 *
 * The token travels in the FRAGMENT because a fragment is never sent to a
 * server — see `packages/cli/src/unlock-url.ts` for the full argument and for
 * what a fragment does NOT fix. The consequence is that the server-rendered
 * `/unlock` page cannot see whether this navigation carries a token, so it
 * would have to render the lock screen and let the client swap it out, which
 * flashes the wrong screen at somebody who is unlocking correctly. This
 * parameter is that missing bit of information, and it is safe in a request log
 * because it says only that somebody is unlocking, never what with.
 */
export const UNLOCK_EXCHANGE_PARAM = "exchange";
export const UNLOCK_EXCHANGE_MARKER = "1";
export const UNLOCK_TOKEN_FRAGMENT_KEY = "token";

/** The `code` field on every failure response from `POST /api/auth/unlock`. */
export type UnlockExchangeErrorCode =
  | "invalid-token"
  | "token-expired"
  | "token-already-used"
  | "rate-limited"
  /**
   * Another Email Agent process held the session store's lock for the whole
   * acquisition budget, so the token was never even compared.
   *
   * It is a separate code rather than folded into `invalid-token` because the
   * user's link is UNTOUCHED on this branch — "not valid, mint a fresh one" is
   * the wrong instruction, and a retry is the right one.
   */
  | "store-busy";

/**
 * Structurally the same union as core's `UnlockExchangeFailure`
 * (`packages/core/src/config/session.ts`) — not imported, for the reason in
 * the module header above. TypeScript's structural typing is what keeps
 * `unlockExchangeErrorCode(result.reason)` in the route type-checking against
 * the real value without a runtime import: if core's union ever changes shape,
 * passing a value of the old type here stops compiling.
 */
export type UnlockExchangeFailureReason =
  | "invalid"
  | "expired"
  | "used"
  | "rate-limited"
  | "busy";

/** Maps core's failure reason onto the wire code the client branches on. */
export function unlockExchangeErrorCode(
  reason: UnlockExchangeFailureReason,
): UnlockExchangeErrorCode {
  switch (reason) {
    case "expired":
      return "token-expired";
    case "used":
      return "token-already-used";
    case "rate-limited":
      return "rate-limited";
    case "busy":
      return "store-busy";
    case "invalid":
      return "invalid-token";
  }
}

/**
 * The message shown for an unlock-exchange failure. Shared by the route (so
 * the JSON `error` field and the page's copy for the same code never say two
 * different things) and the unlock page's own recovery text.
 */
export function describeUnlockExchangeError(code: UnlockExchangeErrorCode): string {
  switch (code) {
    case "token-already-used":
      return "This link was already used. Run `npx email-agent unlock` for a fresh one.";
    case "token-expired":
      return "This link has expired — it was only good for ten minutes. Run `npx email-agent unlock` for a fresh one.";
    case "rate-limited":
      // This used to say only "wait a moment and try again", on the reasoning
      // that a fresh token could not help while the window was hot. That was
      // true and it was the bug: `mintUnlockToken()` now CLEARS the failure
      // window (`packages/core/src/config/session.ts`), precisely because the
      // old behaviour left the recovery command this app recommends everywhere
      // else unable to recover from a lockout a couple of stale-link
      // double-clicks could cause. Naming the command is now the fastest way
      // out, not an invitation to another doomed attempt.
      return "Too many attempts. Run `npx email-agent unlock` for a fresh link — minting one clears the limit.";
    case "store-busy":
      // Deliberately does NOT recommend minting a fresh link: this link still
      // works. Telling the user to replace a credential that was never spent is
      // how a transient condition turns into a support question.
      return "Another Email Agent process is using the session file. Nothing was used up — try this link again in a moment.";
    case "invalid-token":
      return "That link or token is not valid. Run `npx email-agent unlock` for a fresh one.";
  }
}

/**
 * Pulls a redeemable token out of a full unlock URL or a bare pasted value, so
 * a user who copied a link out of a terminal does not have to trim it by hand.
 *
 * BOTH SHAPES ARE ACCEPTED, and the query one is not vestigial: the printed
 * link carries the token in the FRAGMENT since 2026-08-22
 * (`/unlock?exchange=1#token=…`, see `packages/cli/src/unlock-url.ts`), but a
 * link minted by an older build has it in the query string, and this box is
 * exactly where such a link should still work. Parsing a pasted string happens
 * entirely in the browser — nothing is logged either way — so accepting the old
 * shape here costs nothing and closes the one gap removing the old `?token=`
 * route left.
 *
 * IT LIVES HERE, NOT BESIDE THE PASTE BOX IT SERVES, for the same reason the
 * rest of this file does: `unlock-screen.test.tsx` renders the box and can
 * exercise the whole submit flow, but the wording and wire-format parsing
 * still belong in one place each caller can compute expectations from,
 * rather than duplicated inline where a copy edit would break silently. This
 * is the documented fallback for every link a terminal or a mail client
 * mangles, which is too load-bearing to leave untested.
 */
export function extractUnlockToken(raw: string): string {
  const trimmed = raw.trim();
  try {
    const url = new URL(trimmed);
    // The fragment first: that is where a current link carries it.
    const hash = url.hash.startsWith("#") ? url.hash.slice(1) : url.hash;
    const fromFragment = new URLSearchParams(hash).get(UNLOCK_TOKEN_FRAGMENT_KEY);
    if (fromFragment) return fromFragment;
    const fromQuery = url.searchParams.get(UNLOCK_TOKEN_FRAGMENT_KEY);
    if (fromQuery) return fromQuery;
  } catch {
    // Not parseable as a URL — treat the whole trimmed string as the token.
  }
  return trimmed;
}

export interface UnlockScreenCopy {
  /** The `<h1>` on the unlock screen. */
  headline: string;
  /**
   * The extra explanatory paragraph shown only for `reason === "binding"`,
   * or `null` for a plain lockout — there is nothing extra to say there.
   */
  recoveryContext: string | null;
}

/**
 * The unlock screen's headline and (for the `binding` case) its extra
 * paragraph, keyed on WHY the screen is showing rather than left as inline
 * JSX ternaries — so a component test can assert the screen picked the RIGHT
 * copy for its `reason` by calling this, instead of re-pinning the strings a
 * second place.
 *
 * `reason === "binding"` is the RECOVERY case and is deliberately a different
 * sentence: that user's session cookie is fine — what is missing is the
 * origin-scoped second factor `apiFetch` sends alongside it — so "Email Agent
 * is locked" would contradict what they can plainly see. See
 * `unlock-screen.tsx`'s header for the full argument, including why this must
 * never read as a dead end: both cases render the same paste-box/redeem
 * instructions below the headline, because the recovery action is identical
 * (redeem a link) even though the SITUATION is not.
 */
export function describeUnlockScreenCopy(reason?: "binding"): UnlockScreenCopy {
  if (reason === "binding") {
    return {
      headline: "This browser needs unlocking again",
      recoveryContext:
        "You are still signed in, but this browser is missing the key that " +
        "ties that session to this exact address. That happens after " +
        "clearing site data, or if the browser is blocking storage for " +
        "this site. Redeeming a link below issues a fresh one.",
    };
  }
  return { headline: "Email Agent is locked", recoveryContext: null };
}

/**
 * Shown when `fetch` itself throws — no response to read a code from at all.
 * A single constant because `UnlockScreen` and `UnlockExchange` both hit this
 * branch and must not drift into saying it two different ways.
 */
export const UNLOCK_NETWORK_ERROR_MESSAGE =
  "Could not reach the server. Check your connection and try again.";

