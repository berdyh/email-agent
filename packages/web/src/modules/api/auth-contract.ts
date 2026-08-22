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
      return "Too many attempts. Wait a moment and try again.";
    case "invalid-token":
      return "That link or token is not valid. Run `npx email-agent unlock` for a fresh one.";
  }
}
