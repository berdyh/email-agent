/**
 * A real unlocked session for tests that need to get PAST the unlock gate in
 * order to test something else.
 *
 * WHY THIS EXISTS. Once the API guards require a session, roughly 150 existing
 * web route tests meet it. The fix belongs in one shared fixture rather than in
 * 150 files — but the fixture must not become a way to SKIP the gate, or the
 * tests would be passing against a door nobody checks. So this mints and
 * redeems through the REAL `mintUnlockToken()`/`exchangeUnlockToken()` against
 * the temp `$HOME`'s `SESSION_PATH`: the token is burned, the store is written,
 * and the cookie handed back is one `hasValidSession` accepts for the ordinary
 * reason. There is deliberately NO test-only branch anywhere in
 * `config/session.ts`.
 *
 * NO STATIC CORE IMPORT, for the reason `lancedb-fixture.ts`'s header explains
 * at length: `config/defaults.ts` resolves `SESSION_PATH` from `homedir()` at
 * module load, and this file is re-exported from `testing/index.ts`, which
 * tests import statically. The core import therefore has to happen at CALL
 * time, after `useTempHome()` has redirected `$HOME`.
 */

/** Everything a test needs to present an unlocked browser. */
export interface TestSession {
  /** The one-time unlock token, already spent. Useful for replay assertions. */
  unlockToken: string;
  /** The plaintext session value — what the cookie carries. */
  cookieValue: string;
  /** A ready-made `Cookie:` header value. */
  cookieHeader: string;
}

/**
 * Mints an unlock token and redeems it, returning a live session.
 *
 * Call it AFTER `useTempHome()`. Each call burns its own token, so calling it
 * twice yields two independent sessions rather than reusing one.
 */
export async function mintTestSession(): Promise<TestSession> {
  const { SESSION_COOKIE_NAME, exchangeUnlockToken, mintUnlockToken } =
    await import("../config/session.js");

  const { token } = mintUnlockToken();
  const result = exchangeUnlockToken(token);
  if (!result.ok) {
    throw new Error(
      `mintTestSession could not redeem a token it had just minted (${result.reason}). ` +
        `That usually means $HOME was not redirected before the store was written, ` +
        `or a previous test exhausted the failure rate limit against this store.`,
    );
  }

  return {
    unlockToken: token,
    cookieValue: result.sessionToken,
    cookieHeader: `${SESSION_COOKIE_NAME}=${result.sessionToken}`,
  };
}
