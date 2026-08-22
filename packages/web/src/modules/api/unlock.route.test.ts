// POST /api/auth/unlock — the ONE route every other guarded route's session
// requirement depends on, exercised through the real handler over a real
// temp `$HOME`.
//
// `session: false` on every request built here: this route is what a
// genuinely unauthenticated browser hits FIRST, and folding in the harness's
// default session cookie (real, but for a DIFFERENT already-redeemed token)
// would test nothing about the exchange itself.

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRequest,
  callHandler,
  cookieAttributes,
  cookieValue,
  startRouteHarness,
} from "./testing/route-harness.js";

const harness = await startRouteHarness("auth-unlock");

const {
  mintUnlockToken,
  RATE_LIMIT_MAX_FAILURES,
  SESSION_COOKIE_NAME,
  SESSION_COOKIE_MAX_AGE_SECONDS,
} = (await import("@email-agent/core/config")) as typeof import("@email-agent/core/config");

type Handler = (request: import("next/server").NextRequest) => Promise<Response>;
const unlock = await harness.load<{ POST: Handler }>("app/api/auth/unlock/route.js");

const SESSION_PATH = join(harness.home, ".email-agent", "session.json");

function storeFailureCount(): number {
  const raw = readFileSync(SESSION_PATH, "utf-8");
  return (JSON.parse(raw) as { failures: unknown[] }).failures.length;
}

describe("POST /api/auth/unlock", () => {
  it("exchanges a freshly minted token for a session cookie with the documented attributes", async () => {
    const { token } = mintUnlockToken();
    const request = buildRequest("/api/auth/unlock", {
      method: "POST",
      body: { token },
      session: false,
    });
    const result = await callHandler(unlock.POST, request);

    assert.equal(result.status, 200);

    const value = cookieValue(result.setCookies, SESSION_COOKIE_NAME);
    assert.ok(value, "expected a Set-Cookie for the session");
    // The cookie carries a SESSION token, not the raw unlock token.
    assert.notEqual(value, token);

    const attrs = cookieAttributes(result.setCookies, SESSION_COOKIE_NAME);
    assert.ok(attrs.includes("httponly"));
    assert.ok(attrs.includes("samesite=lax"));
    assert.ok(!attrs.some((a) => a === "secure"));
    assert.ok(attrs.some((a) => a === `max-age=${SESSION_COOKIE_MAX_AGE_SECONDS}`));
  });

  it("returns the origin-scoped second factor in the BODY, and never as a cookie", async () => {
    // The whole point of the second factor is that it must land somewhere a
    // sibling loopback port cannot read. A cookie is scoped by HOST with no
    // port component, so shipping it as one would hand it straight to the
    // attacker this closes — it goes in the body, and the client writes it to
    // localStorage on the origin the user actually opened.
    const { token } = mintUnlockToken();
    const result = await callHandler<{ ok: boolean; binding: string }>(
      unlock.POST,
      buildRequest("/api/auth/unlock", { method: "POST", body: { token }, session: false }),
    );

    assert.equal(result.status, 200);
    assert.equal(result.body.ok, true);
    assert.equal(typeof result.body.binding, "string");
    assert.ok(result.body.binding.length >= 40);

    const sessionCookie = cookieValue(result.setCookies, SESSION_COOKIE_NAME);
    assert.notEqual(result.body.binding, sessionCookie);
    for (const line of result.setCookies) {
      assert.ok(
        !line.includes(result.body.binding),
        `the second factor must not appear in any Set-Cookie: ${line}`,
      );
    }
  });

  it("burns the token: the same link cannot be used twice", async () => {
    const { token } = mintUnlockToken();
    const first = buildRequest("/api/auth/unlock", {
      method: "POST",
      body: { token },
      session: false,
    });
    const firstResult = await callHandler(unlock.POST, first);
    assert.equal(firstResult.status, 200);

    const second = buildRequest("/api/auth/unlock", {
      method: "POST",
      body: { token },
      session: false,
    });
    const secondResult = await callHandler(unlock.POST, second);
    assert.equal(secondResult.status, 401);
    assert.equal((secondResult.body as { code: string }).code, "token-already-used");
  });

  it("refuses a token that was never minted", async () => {
    const request = buildRequest("/api/auth/unlock", {
      method: "POST",
      body: { token: "not-a-real-token" },
      session: false,
    });
    const result = await callHandler(unlock.POST, request);
    assert.equal(result.status, 401);
    assert.equal((result.body as { code: string }).code, "invalid-token");
  });

  it("refuses a token past its ten-minute window", async () => {
    // Minted twenty minutes ago, so its expiry (mint time + 10 minutes) is
    // already ten minutes in the past by the time the route exchanges it.
    const { token } = mintUnlockToken(Date.now() - 20 * 60 * 1000);
    const request = buildRequest("/api/auth/unlock", {
      method: "POST",
      body: { token },
      session: false,
    });
    const result = await callHandler(unlock.POST, request);
    assert.equal(result.status, 401);
    assert.equal((result.body as { code: string }).code, "token-expired");
  });

  it("rate-limits after enough failed attempts, without ever reaching the real token", async () => {
    const { token } = mintUnlockToken();

    // The store is shared across every `it()` in this file (one harness, one
    // temp `$HOME`), so earlier tests already left a few failures on the
    // window — top up to the cap rather than assuming a fresh count.
    const alreadyFailed = storeFailureCount();
    for (let i = alreadyFailed; i < RATE_LIMIT_MAX_FAILURES; i++) {
      const request = buildRequest("/api/auth/unlock", {
        method: "POST",
        body: { token: `wrong-${i}` },
        session: false,
      });
      const result = await callHandler(unlock.POST, request);
      assert.equal(result.status, 401);
    }

    // The 21st attempt is rate-limited even with the CORRECT token — proving
    // the limiter gates before the compare, not after it.
    const limited = buildRequest("/api/auth/unlock", {
      method: "POST",
      body: { token },
      session: false,
    });
    const limitedResult = await callHandler(unlock.POST, limited);
    assert.equal(limitedResult.status, 429);
    assert.equal((limitedResult.body as { code: string }).code, "rate-limited");
    assert.ok(limitedResult.headers.get("retry-after"));
  });

  it("refuses a bad-Host request before the store is ever touched", async () => {
    const before = storeFailureCount();
    const request = buildRequest("/api/auth/unlock", {
      method: "POST",
      body: { token: "irrelevant" },
      headers: { host: "evil.example:3847" },
      session: false,
    });
    const result = await callHandler(unlock.POST, request);
    assert.equal(result.status, 403);
    // The header guard ran and stopped BEFORE exchangeUnlockToken — proven by
    // the store's own failure count, not just the status code.
    assert.equal(storeFailureCount(), before);
  });

  it("refuses a malformed body as 400, distinct from an invalid token", async () => {
    const request = buildRequest("/api/auth/unlock", {
      method: "POST",
      body: {},
      session: false,
    });
    const result = await callHandler(unlock.POST, request);
    assert.equal(result.status, 400);
  });
});
