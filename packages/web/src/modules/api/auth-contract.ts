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

/** The `code` field on every failure response from `POST /api/auth/unlock`. */
export type UnlockExchangeErrorCode =
  | "invalid-token"
  | "token-expired"
  | "token-already-used"
  | "rate-limited";

/**
 * Structurally the same union as core's `UnlockExchangeFailure`
 * (`packages/core/src/config/session.ts`) — not imported, for the reason in
 * the module header above. TypeScript's structural typing is what keeps
 * `unlockExchangeErrorCode(result.reason)` in the route type-checking against
 * the real value without a runtime import: if core's union ever changes shape,
 * passing a value of the old type here stops compiling.
 */
export type UnlockExchangeFailureReason = "invalid" | "expired" | "used" | "rate-limited";

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
    case "invalid-token":
      return "That link or token is not valid. Run `npx email-agent unlock` for a fresh one.";
  }
}
