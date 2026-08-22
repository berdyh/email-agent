/**
 * The fixture that lets ~150 web route tests past the unlock gate has to hand
 * back a session the PRODUCT accepts — not a plausible-looking string.
 *
 * A fixture that fabricated a cookie value would leave every one of those tests
 * green while the gate they walk through was broken, which is strictly worse
 * than having no gate: it manufactures confidence. So the assertion here is
 * `hasValidSession`, the same function the API guard and the page gate call.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { mintTestSession, useTempHome } from "./index.js";

await useTempHome("session-fixture");

const { SESSION_COOKIE_NAME, exchangeUnlockToken, hasValidSession } = await import(
  "../config/session.js"
);

describe("mintTestSession", () => {
  it("hands back a cookie the real validator accepts", async () => {
    const session = await mintTestSession();

    assert.equal(hasValidSession(session.cookieValue), true);
    assert.equal(session.cookieHeader, `${SESSION_COOKIE_NAME}=${session.cookieValue}`);
  });

  it("goes through the real exchange, so its token is genuinely burned", async () => {
    const session = await mintTestSession();

    const replay = exchangeUnlockToken(session.unlockToken);

    assert.equal(replay.ok, false);
    assert.ok(!replay.ok);
    assert.equal(replay.reason, "used");
  });

  it("mints independent sessions, so one test cannot invalidate another's", async () => {
    const first = await mintTestSession();
    const second = await mintTestSession();

    assert.notEqual(first.cookieValue, second.cookieValue);
    assert.equal(hasValidSession(first.cookieValue), true);
    assert.equal(hasValidSession(second.cookieValue), true);
  });
});
