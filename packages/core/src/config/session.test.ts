/**
 * The unlock-token and session store, against a real `~/.email-agent/session
 * .json` inside a throwaway `$HOME`.
 *
 * Every case here failed before `config/session.ts` existed, because there was
 * no session concept at all: anything that could open the loopback port got the
 * whole mailbox.
 *
 * NOT COVERED, and deliberately not faked:
 *  - the idle-renewal write FAILING. The renewal is wrapped in a try/catch so a
 *    write error can never flip a demonstrably-valid session to `false`, but the
 *    failure cannot be injected in-process: `writePrivateFileSync` chmods the
 *    parent directory back to `0700` before writing, so removing the write bit
 *    does not stick, and the other realistic causes (ENOSPC, a read-only mount)
 *    are not reproducible from a test. What IS pinned below is that the renewal
 *    write happens and that the return value does not depend on it.
 *  - a second OS user reading a `0600` file. That is a kernel property; no test
 *    in this repo creates another user.
 */

import assert from "node:assert/strict";
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { beforeEach, describe, it } from "node:test";

import { useTempHome } from "../testing/index.js";

const home = await useTempHome("session-store");

const { SESSION_PATH } = await import("./defaults.js");
const { filePermissions, PRIVATE_DIR_MODE, PRIVATE_FILE_MODE } = await import(
  "../shared/private-files.js"
);
const {
  RATE_LIMIT_MAX_FAILURES,
  RATE_LIMIT_WINDOW_MS,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_OPTIONS,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  UNLOCK_REQUIRED_CODE,
  BINDING_REQUIRED_CODE,
  SESSION_BINDING_HEADER,
  SESSION_TTL_MS,
  UNLOCK_TOKEN_TTL_MS,
  checkSessionRequest,
  exchangeUnlockToken,
  hasValidSession,
  isUnlockGateEnabled,
  mintUnlockToken,
  revokeAllSessions,
} = await import("./session.js");

const T0 = 1_770_000_000_000;

function storeBytes(): string {
  return readFileSync(SESSION_PATH, "utf-8");
}

function unlockedAt(nowMs: number): string {
  return unlockedPairAt(nowMs).sessionToken;
}

/** Both halves of an unlocked browser: the cookie value and the second factor. */
function unlockedPairAt(nowMs: number): { sessionToken: string; bindingToken: string } {
  const { token } = mintUnlockToken(nowMs);
  const result = exchangeUnlockToken(token, nowMs);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  return { sessionToken: result.sessionToken, bindingToken: result.bindingToken };
}

beforeEach(() => {
  rmSync(SESSION_PATH, { force: true });
});

describe("minting and exchanging an unlock token", () => {
  it("exchanges a freshly printed token for a session", () => {
    const { token, expiresAt } = mintUnlockToken(T0);

    assert.equal(expiresAt, T0 + UNLOCK_TOKEN_TTL_MS);
    const result = exchangeUnlockToken(token, T0);

    assert.ok(result.ok);
    assert.notEqual(result.sessionToken, token);
    assert.ok(result.sessionToken.length >= 43);
    assert.equal(result.expiresAt, T0 + SESSION_TTL_MS);
    assert.equal(hasValidSession(result.sessionToken, T0), true);
  });

  it("never writes a plaintext token or cookie value to disk", () => {
    const { token } = mintUnlockToken(T0);
    const afterMint = storeBytes();
    assert.equal(afterMint.includes(token), false);

    const result = exchangeUnlockToken(token, T0);
    assert.ok(result.ok);
    const afterExchange = storeBytes();
    assert.equal(afterExchange.includes(token), false);
    assert.equal(afterExchange.includes(result.sessionToken), false);
    // What IS there is the digest — so a reader of this file learns nothing it
    // can present, which is the whole reason a file is an acceptable channel.
    assert.match(afterExchange, /"tokenHash": "[0-9a-f]{64}"/);
  });

  it("burns the token: the same link cannot be used twice", () => {
    const { token } = mintUnlockToken(T0);
    assert.ok(exchangeUnlockToken(token, T0).ok);

    const replay = exchangeUnlockToken(token, T0 + 1);

    assert.deepEqual(replay, { ok: false, reason: "used", retryAfterMs: 0 });
  });

  it("refuses a wrong guess without burning the real token", () => {
    const { token } = mintUnlockToken(T0);

    const wrong = exchangeUnlockToken("not-the-token", T0);
    assert.deepEqual(wrong, { ok: false, reason: "invalid", retryAfterMs: 0 });

    assert.ok(exchangeUnlockToken(token, T0).ok, "the real token must still work");
  });

  it("refuses a token past its ten-minute window", () => {
    const { token } = mintUnlockToken(T0);

    const late = exchangeUnlockToken(token, T0 + UNLOCK_TOKEN_TTL_MS + 1);

    assert.deepEqual(late, { ok: false, reason: "expired", retryAfterMs: 0 });
  });

  it("answers invalid, not a crash, when nothing has ever been minted", () => {
    assert.deepEqual(exchangeUnlockToken("anything", T0), {
      ok: false,
      reason: "invalid",
      retryAfterMs: 0,
    });
  });

  it("keeps live sessions when a new token is minted", () => {
    // Restarting `serve`, or running `email-agent unlock` after losing a link,
    // must not log out a browser that is already unlocked.
    const session = unlockedAt(T0);

    mintUnlockToken(T0 + 1000);

    assert.equal(hasValidSession(session, T0 + 1000), true);
  });

  it("does the whole check-and-burn without an await", () => {
    // The route handler's protection against a double exchange is that this
    // function yields to nothing: on one event loop, two concurrent callers
    // cannot both observe the token unburned. An `await` anywhere inside it
    // would silently reopen that window.
    const source = readFileSync(new URL("./session.ts", import.meta.url), "utf-8");
    const start = source.indexOf("export function exchangeUnlockToken(");
    assert.ok(start > 0);
    const body = source.slice(start, source.indexOf("\n}", start));
    assert.doesNotMatch(body, /\bawait\b/);
  });
});

describe("rate limiting the exchange", () => {
  it("refuses even the CORRECT token once the failure cap is reached", () => {
    const { token } = mintUnlockToken(T0);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i += 1) {
      assert.equal(exchangeUnlockToken(`guess-${i}`, T0 + i).ok, false);
    }

    const blocked = exchangeUnlockToken(token, T0 + RATE_LIMIT_MAX_FAILURES);

    assert.ok(!blocked.ok);
    assert.equal(blocked.reason, "rate-limited");
    assert.ok(blocked.retryAfterMs > 0);
    assert.ok(blocked.retryAfterMs <= RATE_LIMIT_WINDOW_MS);
  });

  it("stops refusing once the window has rolled past, without needing a mint", () => {
    mintUnlockToken(T0);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i += 1) {
      exchangeUnlockToken(`guess-${i}`, T0 + i);
    }
    const blocked = exchangeUnlockToken("guess-again", T0 + 100);
    assert.ok(!blocked.ok);
    assert.equal(blocked.reason, "rate-limited");

    // Deliberately NOT re-minting to prove this: minting now clears the window
    // (see below), which would make this test pass whether or not the rolling
    // window works at all. A bare attempt past the window is the only probe
    // that isolates the roll.
    const rolled = exchangeUnlockToken("guess-again", T0 + RATE_LIMIT_WINDOW_MS + 1);

    assert.ok(!rolled.ok);
    assert.equal(rolled.reason, "invalid");
  });

  it("does not count a successful exchange against the window", () => {
    const first = mintUnlockToken(T0);
    assert.ok(exchangeUnlockToken(first.token, T0).ok);
    const parsed = JSON.parse(storeBytes()) as { failures: number[] };

    assert.deepEqual(parsed.failures, []);
  });

  it("clears prior failures on a successful exchange", () => {
    mintUnlockToken(T0);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES - 1; i += 1) {
      exchangeUnlockToken(`guess-${i}`, T0 + i);
    }
    // Minting clears the window, so mint FIRST and fail after it — otherwise
    // this would be testing the mint path again rather than the success path.
    const fresh = mintUnlockToken(T0 + 1);
    exchangeUnlockToken("one-more-guess", T0 + 2);
    assert.equal(
      (JSON.parse(storeBytes()) as { failures: number[] }).failures.length,
      1,
    );

    assert.ok(exchangeUnlockToken(fresh.token, T0 + 3).ok);

    assert.deepEqual((JSON.parse(storeBytes()) as { failures: number[] }).failures, []);
  });
});

describe("recovering from an exhausted rate-limit window", () => {
  it("lets `email-agent unlock` back in immediately after a lockout", () => {
    // The exact sequence measured live against a running server: exhaust the
    // budget, run `npx email-agent unlock` (which is `mintUnlockToken`), open
    // the fresh link. It used to answer `rate-limited` with a retryAfterMs of
    // ~14 minutes — from the one command the "this link was already used"
    // message tells the user to run.
    mintUnlockToken(T0);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i += 1) {
      exchangeUnlockToken(`guess-${i}`, T0 + i);
    }
    const stillBlocked = exchangeUnlockToken("anything", T0 + RATE_LIMIT_MAX_FAILURES);
    assert.ok(!stillBlocked.ok);
    assert.equal(stillBlocked.reason, "rate-limited");

    const fresh = mintUnlockToken(T0 + RATE_LIMIT_MAX_FAILURES + 1);
    const allowed = exchangeUnlockToken(fresh.token, T0 + RATE_LIMIT_MAX_FAILURES + 2);

    assert.ok(allowed.ok);
    assert.deepEqual((JSON.parse(storeBytes()) as { failures: number[] }).failures, []);
  });

  it("keeps throttling an attacker hammering tokens that never matched", () => {
    // The property the limiter exists for, and the one this must not weaken:
    // something that can reach the port but has no token gets exactly
    // RATE_LIMIT_MAX_FAILURES guesses per window, and the cap is enforced
    // before any comparison happens.
    mintUnlockToken(T0);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i += 1) {
      const attempt = exchangeUnlockToken(`brute-${i}`, T0 + i);
      assert.ok(!attempt.ok);
      assert.equal(attempt.reason, "invalid");
    }

    const throttled = exchangeUnlockToken("brute-20", T0 + RATE_LIMIT_MAX_FAILURES);

    assert.ok(!throttled.ok);
    assert.equal(throttled.reason, "rate-limited");
    assert.ok(throttled.retryAfterMs > 0);
  });

  it("does not spend the budget on replays of an already-used link", () => {
    // 19 concurrent replays of one stale link is what made accidental
    // self-lockout cheap — a double-click plus a browser prefetch will do it.
    // A replay proves possession of the real token; it is not a guess.
    const { token } = mintUnlockToken(T0);
    assert.ok(exchangeUnlockToken(token, T0).ok);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES * 2; i += 1) {
      const replay = exchangeUnlockToken(token, T0 + 10 + i);
      assert.ok(!replay.ok);
      assert.equal(replay.reason, "used");
    }

    // If replays had counted, this would come back `rate-limited`.
    const guess = exchangeUnlockToken("a-real-guess", T0 + 1000);

    assert.ok(!guess.ok);
    assert.equal(guess.reason, "invalid");
    assert.deepEqual((JSON.parse(storeBytes()) as { failures: number[] }).failures, [
      T0 + 1000,
    ]);
  });

  it("does not spend the budget on a matched-but-expired link either", () => {
    const { token } = mintUnlockToken(T0);
    const past = T0 + UNLOCK_TOKEN_TTL_MS + 1;
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES * 2; i += 1) {
      const attempt = exchangeUnlockToken(token, past + i);
      assert.ok(!attempt.ok);
      assert.equal(attempt.reason, "expired");
    }

    const guess = exchangeUnlockToken("a-real-guess", past + 1000);

    assert.ok(!guess.ok);
    assert.equal(guess.reason, "invalid");
  });

  it("writes nothing at all for a matched-but-dead token", () => {
    // No record to make, and an unauthenticated caller must not be able to
    // drive a disk write per request by re-clicking a stale link.
    const { token } = mintUnlockToken(T0);
    assert.ok(exchangeUnlockToken(token, T0).ok);
    const before = storeBytes();

    assert.equal(exchangeUnlockToken(token, T0 + 1).ok, false);

    assert.equal(storeBytes(), before);
  });

  it("counts a replay again once the link it matched has been replaced", () => {
    // What keeps "uncounted" from being a permanently free probe: after a
    // re-mint the old value no longer matches the record on file, so it is an
    // ordinary wrong guess and is charged like one.
    const { token } = mintUnlockToken(T0);
    assert.ok(exchangeUnlockToken(token, T0).ok);
    mintUnlockToken(T0 + 1);

    const replay = exchangeUnlockToken(token, T0 + 2);

    assert.ok(!replay.ok);
    assert.equal(replay.reason, "invalid");
    assert.deepEqual((JSON.parse(storeBytes()) as { failures: number[] }).failures, [
      T0 + 2,
    ]);
  });
});

describe("validating a session cookie", () => {
  it("rejects an absent, empty or unrecognised cookie value", () => {
    unlockedAt(T0);

    assert.equal(hasValidSession(undefined, T0), false);
    assert.equal(hasValidSession("", T0), false);
    assert.equal(hasValidSession("forged-value", T0), false);
  });

  it("rejects a session past its idle window", () => {
    const session = unlockedAt(T0);

    assert.equal(hasValidSession(session, T0 + SESSION_TTL_MS + 1), false);
  });

  it("extends a session that is more than half expired", () => {
    const session = unlockedAt(T0);
    const later = T0 + SESSION_TTL_MS / 2 + 1000;

    assert.equal(hasValidSession(session, later), true);

    const parsed = JSON.parse(storeBytes()) as { sessions: { expiresAt: number }[] };
    assert.equal(parsed.sessions[0]?.expiresAt, later + SESSION_TTL_MS);
  });

  it("does not rewrite the store for a session that is still fresh", () => {
    const session = unlockedAt(T0);
    const before = storeBytes();

    assert.equal(hasValidSession(session, T0 + 1000), true);

    assert.equal(storeBytes(), before);
  });

  it("drops expired sessions from the file rather than accumulating them", () => {
    unlockedAt(T0);
    const survivor = unlockedAt(T0 + SESSION_TTL_MS - 1000);
    assert.equal((JSON.parse(storeBytes()) as { sessions: unknown[] }).sessions.length, 2);

    // Any write past the first session's expiry prunes it, so the file cannot
    // grow one dead record per unlock forever.
    mintUnlockToken(T0 + SESSION_TTL_MS + 1);

    const parsed = JSON.parse(storeBytes()) as { sessions: unknown[] };
    assert.equal(parsed.sessions.length, 1);
    assert.equal(hasValidSession(survivor, T0 + SESSION_TTL_MS + 1), true);
  });

  it("revokes every session and any unredeemed token", () => {
    const session = unlockedAt(T0);
    mintUnlockToken(T0);

    revokeAllSessions(T0);

    assert.equal(hasValidSession(session, T0), false);
    const parsed = JSON.parse(storeBytes()) as { unlock: unknown };
    assert.equal(parsed.unlock, null);
  });
});

describe("a store that cannot be used", () => {
  it("fails CLOSED on both read paths", () => {
    unlockedAt(T0);
    const session = unlockedAt(T0);
    writeFileSync(SESSION_PATH, "{ not json");

    assert.equal(hasValidSession(session, T0), false);
    assert.deepEqual(exchangeUnlockToken("anything", T0), {
      ok: false,
      reason: "invalid",
      retryAfterMs: 0,
    });
  });

  it("fails CLOSED on a store that parses but carries a nonsense unlock record", () => {
    // Valid JSON is not a valid store. Before the record was validated, an
    // `unlock` of the wrong shape reached the digest compare and THREW, which
    // would surface as a 500 from the exchange route instead of the documented
    // "invalid" — a corrupt store must lock people out, never crash at them.
    const session = unlockedAt(T0);
    writeFileSync(
      SESSION_PATH,
      JSON.stringify({ version: 1, unlock: "garbage", sessions: [], failures: [] }),
    );

    assert.deepEqual(exchangeUnlockToken("anything", T0), {
      ok: false,
      reason: "invalid",
      retryAfterMs: 0,
    });
    assert.equal(hasValidSession(session, T0), false);

    writeFileSync(
      SESSION_PATH,
      JSON.stringify({ version: 1, unlock: { expiresAt: T0 }, sessions: [], failures: [] }),
    );
    assert.equal(exchangeUnlockToken("anything", T0).ok, false);
  });

  it("fails OPEN when minting, so the recovery command still works", () => {
    // `email-agent unlock` is what a user runs when they are locked out.
    // Throwing here would mean a corrupt file leaves them with no way back in.
    writeFileSync(SESSION_PATH, "{ not json");

    const { token } = mintUnlockToken(T0);

    assert.ok(exchangeUnlockToken(token, T0).ok);
  });
});

describe("the shape the web package has to agree with", () => {
  it("names the cookie once, with the attributes and TTL both halves use", () => {
    assert.equal(SESSION_COOKIE_NAME, "email_agent_session");
    assert.deepEqual(SESSION_COOKIE_OPTIONS, {
      httpOnly: true,
      sameSite: "lax",
      // `secure` stays OFF: the app is plain http on loopback, and a Secure
      // cookie the browser stores and never returns is a permanent lockout.
      secure: false,
      path: "/",
    });
    // DELIBERATELY far longer than the 24h idle window. `Max-Age` is enforced
    // by the browser from the moment the cookie is set and nothing re-sets it,
    // so matching it to the idle window would delete the cookie after a day
    // however heavily the browser was used — and the idle renewal would be dead
    // code, because the browser would stop sending a value to renew. The store
    // is the sole authority: a cookie whose record has expired matches nothing.
    assert.ok(SESSION_COOKIE_MAX_AGE_SECONDS > (SESSION_TTL_MS / 1000) * 30);
    assert.equal(SESSION_COOKIE_MAX_AGE_SECONDS, 365 * 24 * 60 * 60);
    assert.equal(UNLOCK_REQUIRED_CODE, "unlock-required");
  });

  it("treats the existing remote-mutations flag as the one and only off switch", () => {
    assert.equal(isUnlockGateEnabled({}), true);
    assert.equal(isUnlockGateEnabled({ EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "1" }), false);
    assert.equal(isUnlockGateEnabled({ EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "0" }), true);
  });

  it("reads no environment variable at all — the store is a file", () => {
    // The .env foot-gun, closed by construction in the ARMING direction:
    // next.config.ts loads the repo-root .env into the web process, so any
    // unlock variable this module read could be armed by a stale committed
    // value. There is no such variable. Since the gate's off-switch moved to
    // `../unlock-gate/index.ts` this file reads NONE, and the one variable that
    // module does read is asserted there — the two halves together are what
    // used to be one assertion here.
    const source = readFileSync(new URL("./session.ts", import.meta.url), "utf-8");
    const reads = [...source.matchAll(/env\["([A-Z_]+)"\]/g)].map((m) => m[1]);

    assert.deepEqual(reads, []);
  });
});

describe("where the store lives", () => {
  it("is a 0600 file in a 0700 directory inside ~/.email-agent", () => {
    mintUnlockToken(T0);

    assert.equal(SESSION_PATH, `${home.path}/.email-agent/session.json`);
    assert.equal(filePermissions(SESSION_PATH), PRIVATE_FILE_MODE);
    assert.equal(filePermissions(`${home.path}/.email-agent`), PRIVATE_DIR_MODE);
  });
});

describe("the origin-scoped second factor", () => {
  it("issues one alongside the cookie, distinct from it and never persisted in the clear", () => {
    const { sessionToken, bindingToken } = unlockedPairAt(T0);

    assert.equal(typeof bindingToken, "string");
    assert.notEqual(bindingToken, sessionToken);
    // 32 random bytes, base64url — same strength as the cookie and the token.
    assert.ok(bindingToken.length >= 40);

    const bytes = storeBytes();
    assert.ok(!bytes.includes(bindingToken), "the plaintext second factor must never be written");
    assert.ok(!bytes.includes(sessionToken), "the plaintext cookie value must never be written");
    assert.ok(bytes.includes("bindingHash"));
  });

  it("REFUSES A COOKIE PRESENTED WITHOUT IT — the sibling-port replay", () => {
    // THE CASE THIS WHOLE FEATURE EXISTS FOR. Cookies are not scoped by port
    // (RFC 6265 §8.5), so another process binding 127.0.0.1:<anything> can be
    // handed this exact cookie by a top-level navigation and replay it here.
    // What it cannot obtain is the second factor: that lives in localStorage,
    // which IS scoped by origin including the port.
    const { sessionToken } = unlockedPairAt(T0);

    assert.equal(checkSessionRequest(sessionToken, undefined, T0), "binding-required");
    assert.equal(checkSessionRequest(sessionToken, "", T0), "binding-required");
  });

  it("refuses a cookie presented with the WRONG second factor", () => {
    const { sessionToken } = unlockedPairAt(T0);
    const other = unlockedPairAt(T0);

    assert.equal(checkSessionRequest(sessionToken, "not-the-binding", T0), "binding-required");
    // Another live session's factor is not a skeleton key either.
    assert.equal(checkSessionRequest(sessionToken, other.bindingToken, T0), "binding-required");
  });

  it("accepts the cookie and its own second factor together", () => {
    const { sessionToken, bindingToken } = unlockedPairAt(T0);

    assert.equal(checkSessionRequest(sessionToken, bindingToken, T0), "ok");
  });

  it("distinguishes 'no session at all' from 'session, wrong browser origin'", () => {
    // The two need different copy on the unlock screen: same fix, very
    // different explanation. Collapsing them tells a user with a working
    // session that they have none, which reads as a broken app.
    const { sessionToken, bindingToken } = unlockedPairAt(T0);

    assert.equal(checkSessionRequest(undefined, bindingToken, T0), "no-session");
    assert.equal(checkSessionRequest("not-a-session", bindingToken, T0), "no-session");
    assert.equal(checkSessionRequest(sessionToken, undefined, T0), "binding-required");
    assert.equal(BINDING_REQUIRED_CODE, "binding-required");
    assert.notEqual(BINDING_REQUIRED_CODE, UNLOCK_REQUIRED_CODE);
    assert.equal(SESSION_BINDING_HEADER, "x-email-agent-session-binding");
  });

  it("does NOT renew the session on the DATA surface for a cookie with no factor", () => {
    // Narrower than it looks, and the narrower claim is the true one: the API
    // guard never extends a session for a caller that has not proved
    // same-origin possession. It does NOT make an unaccompanied cookie decay
    // on schedule — `hasValidSession` still renews and the PAGE gate calls it,
    // so bare top-level GETs keep the record fresh. What that keeps alive is
    // half a credential; the assertion below is about this surface only.
    const { sessionToken, bindingToken } = unlockedPairAt(T0);
    const late = T0 + SESSION_TTL_MS - 1000;

    assert.equal(checkSessionRequest(sessionToken, undefined, late), "binding-required");
    assert.ok(
      !storeBytes().includes(String(late + SESSION_TTL_MS)),
      "an unaccompanied cookie must not push the expiry back",
    );

    assert.equal(checkSessionRequest(sessionToken, bindingToken, late), "ok");
    assert.ok(
      storeBytes().includes(String(late + SESSION_TTL_MS)),
      "a complete request renews exactly as before",
    );
  });

  it("keeps the page gate working on the cookie ALONE", () => {
    // A top-level navigation carries no custom header, so the page gate cannot
    // see the second factor. Requiring it there would mean nobody could ever
    // load the app. Safe only because every page under (app)/ is a client
    // component with zero server-side data fetching.
    const { sessionToken } = unlockedPairAt(T0);

    assert.equal(hasValidSession(sessionToken, T0), true);
  });

  it("drops a pre-upgrade session record rather than half-honouring it", () => {
    // A session written before this landed has no `bindingHash`, so it could
    // never satisfy `checkSessionRequest`. It is dropped at parse time, which
    // makes it a clean "you have no session, click the link" instead of a
    // third state that claims a session and then refuses every request.
    const { sessionToken } = unlockedPairAt(T0);
    const store = JSON.parse(storeBytes()) as {
      sessions: { tokenHash: string; bindingHash?: string; expiresAt: number }[];
    };
    for (const session of store.sessions) delete session.bindingHash;
    writeFileSync(SESSION_PATH, JSON.stringify(store));

    assert.equal(hasValidSession(sessionToken, T0), false);
    assert.equal(checkSessionRequest(sessionToken, undefined, T0), "no-session");
  });
});
