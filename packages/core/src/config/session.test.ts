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
  SESSION_MAX_AGE_SECONDS,
  SESSION_TTL_MS,
  UNLOCK_TOKEN_TTL_MS,
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
  const { token } = mintUnlockToken(nowMs);
  const result = exchangeUnlockToken(token, nowMs);
  assert.equal(result.ok, true);
  assert.ok(result.ok);
  return result.sessionToken;
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

  it("lets the correct token through once the window has rolled past", () => {
    const { token } = mintUnlockToken(T0);
    for (let i = 0; i < RATE_LIMIT_MAX_FAILURES; i += 1) {
      exchangeUnlockToken(`guess-${i}`, T0 + i);
    }
    assert.equal(exchangeUnlockToken(token, T0 + 100).ok, false);

    // The token itself is long dead by then, so re-mint: what is being pinned
    // is that the LIMITER stops refusing, not that a stale token revives.
    const fresh = mintUnlockToken(T0 + RATE_LIMIT_WINDOW_MS + 1);
    const allowed = exchangeUnlockToken(fresh.token, T0 + RATE_LIMIT_WINDOW_MS + 1);

    assert.ok(allowed.ok);
  });

  it("does not count a successful exchange against the window", () => {
    const first = mintUnlockToken(T0);
    assert.ok(exchangeUnlockToken(first.token, T0).ok);
    const parsed = JSON.parse(storeBytes()) as { failures: number[] };

    assert.deepEqual(parsed.failures, []);
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
    assert.equal(SESSION_MAX_AGE_SECONDS, 86_400);
  });

  it("treats the existing remote-mutations flag as the one and only off switch", () => {
    assert.equal(isUnlockGateEnabled({}), true);
    assert.equal(isUnlockGateEnabled({ EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "1" }), false);
    assert.equal(isUnlockGateEnabled({ EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS: "0" }), true);
  });

  it("reads no other environment variable anywhere in the module", () => {
    // The .env foot-gun, closed by construction: next.config.ts loads the repo
    // root .env into the web process, so any unlock variable this module read
    // could be armed by a stale committed value. There is no such variable.
    const source = readFileSync(new URL("./session.ts", import.meta.url), "utf-8");
    const reads = [...source.matchAll(/env\["([A-Z_]+)"\]/g)].map((m) => m[1]);

    assert.deepEqual([...new Set(reads)], ["EMAIL_AGENT_ALLOW_REMOTE_MUTATIONS"]);
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
