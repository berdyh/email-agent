// THE LOGIN-CSRF GUARD ON ACCOUNT LINKING, exercised through the real handlers.
//
// `/api/auth/callback` is the ONE route with no `readGuardResponse` — Google
// redirects the browser to it as a top-level cross-site navigation, which the
// shared guard refuses by design. Its entire CSRF protection is the one-time
// `state` value: issued in an httpOnly SameSite=Lax cookie by
// `POST /api/accounts {action:"add"}`, echoed back by Google, and compared with
// `timingSafeEqual`. Nothing exercised it. It was verified by reading.
//
// These drive both real route handlers against a real temp `$HOME`, with
// fabricated request/cookie pairs.
//
// HOW "403 BEFORE addAccount" IS ESTABLISHED WITHOUT A MOCKING LAYER. The
// callback's happy path runs four steps in a fixed order, and each has a
// DIFFERENT observable outcome in a temp home with no OAuth credentials:
//
//   1. state check            -> 403 "Missing or invalid OAuth state"
//   2. authorization code     -> 400 "Missing authorization code"
//   3. getOAuthCredentials()  -> 500 "OAuth credentials not configured"
//   4. exchangeCode + addAccount
//
// So the status code says exactly how far execution got, and a 403 proves it
// stopped at step 1 — before the credential read, before the token exchange and
// therefore before `addAccount`. That is corroborated directly: `addAccount`
// writes `~/.email-agent/settings.json` through `saveSettings`, and after every
// rejected callback the file is asserted still absent. Both together are
// stronger than a mock's call count, because they observe the real side effect.
//
// NO LIVE GOOGLE FLOW IS INCLUDED, and TODOS.md says so rather than implying
// coverage. There are no OAuth credentials and no linked account on this
// machine, so the consent screen, Google's own `state` echo and the browser's
// cookie handling are still verified by reading only.

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, it } from "node:test";
import {
  buildRequest,
  callHandler,
  cookieAttributes,
  cookieValue,
  startRouteHarness,
} from "./testing/route-harness.js";

const harness = await startRouteHarness("oauth-csrf");

type Handler = (
  request: import("next/server").NextRequest,
) => Promise<Response>;

const callback = await harness.load<{ GET: Handler }>(
  "app/api/auth/callback/route.js",
);
const accounts = await harness.load<{ GET: Handler; POST: Handler }>(
  "app/api/accounts/route.js",
);
const { OAUTH_STATE_COOKIE } = await import("./oauth-state.js");

const SETTINGS_PATH = join(harness.home, ".email-agent", "settings.json");
const OAUTH_PATH = join(harness.home, ".email-agent", "oauth.json");

/** True when `addAccount` has written a settings file (it always does). */
async function accountWasWritten(): Promise<boolean> {
  try {
    const raw = await readFile(SETTINGS_PATH, "utf8");
    const parsed = JSON.parse(raw) as { accounts?: unknown[] };
    return (parsed.accounts?.length ?? 0) > 0;
  } catch {
    return false;
  }
}

async function settingsFileExists(): Promise<boolean> {
  try {
    await readFile(SETTINGS_PATH, "utf8");
    return true;
  } catch {
    return false;
  }
}

function callbackRequest(options: {
  state?: string;
  cookie?: string;
  code?: string;
}) {
  const query: Record<string, string> = {};
  if (options.code !== undefined) query["code"] = options.code;
  if (options.state !== undefined) query["state"] = options.state;
  return buildRequest("/api/auth/callback", {
    query,
    ...(options.cookie === undefined
      ? {}
      : { cookies: { [OAUTH_STATE_COOKIE]: options.cookie } }),
    // Google's redirect really is a cross-site top-level navigation. Sending
    // the same headers the browser would makes the point that this route's
    // protection is the cookie and nothing else.
    sameOrigin: false,
    headers: { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" },
  });
}

const GOOD_STATE = "Zm9vYmFyLXN0YXRlLXZhbHVlLTMyLWJ5dGVzLWxvbmc";

describe("the OAuth callback's state check", () => {
  it("refuses a mismatched state with 403, before anything is written", async () => {
    const result = await callHandler(
      callback.GET,
      callbackRequest({ state: "attacker-chosen", cookie: GOOD_STATE, code: "abc" }),
    );

    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { error: "Missing or invalid OAuth state" });
    // Step 1 of 4. A 400 would mean it had reached the code check and a 500 the
    // credential read; either would mean the guard let a forged callback in.
    assert.equal(await settingsFileExists(), false, "addAccount must not have run");
    assert.equal(result.location, null, "a refused callback must not redirect");
  });

  it("refuses an absent cookie with 403 even when the query state is present", async () => {
    // The CSRF case proper: the attacker's browser has never visited the app's
    // add-account flow, so it holds no state cookie at all.
    const result = await callHandler(
      callback.GET,
      callbackRequest({ state: GOOD_STATE, code: "abc" }),
    );
    assert.equal(result.status, 403);
    assert.equal(await settingsFileExists(), false);
  });

  it("refuses an absent query parameter with 403 even when the cookie is present", async () => {
    const result = await callHandler(
      callback.GET,
      callbackRequest({ cookie: GOOD_STATE, code: "abc" }),
    );
    assert.equal(result.status, 403);
    assert.equal(await settingsFileExists(), false);
  });

  it("refuses an empty state on both sides rather than matching two blanks", async () => {
    // `"" === ""` would be a match under a naive compare, and an attacker can
    // send `?state=` freely.
    const result = await callHandler(
      callback.GET,
      callbackRequest({ state: "", cookie: "", code: "abc" }),
    );
    assert.equal(result.status, 403);
    assert.equal(await settingsFileExists(), false);
  });

  it("refuses a state that is a prefix of the cookie", async () => {
    // `timingSafeEqual` throws on unequal lengths, so the length check has to
    // come first; if it did not, this case would 500 instead of 403.
    const result = await callHandler(
      callback.GET,
      callbackRequest({
        state: GOOD_STATE.slice(0, 8),
        cookie: GOOD_STATE,
        code: "abc",
      }),
    );
    assert.equal(result.status, 403);
    assert.deepEqual(result.body, { error: "Missing or invalid OAuth state" });
  });

  it("clears the state cookie on refusal, so a leaked value cannot be replayed", async () => {
    const result = await callHandler(
      callback.GET,
      callbackRequest({ state: "nope", cookie: GOOD_STATE, code: "abc" }),
    );
    assert.equal(cookieValue(result.setCookies, OAUTH_STATE_COOKIE), "");
    assert.ok(
      cookieAttributes(result.setCookies, OAUTH_STATE_COOKIE).some((attr) =>
        attr.startsWith("max-age=0"),
      ),
      `expected the cookie to be expired, saw ${result.setCookies.join(" | ")}`,
    );
  });

  it("PASSES a matching state — and only then reaches the next step", async () => {
    // The other half of the contract. Without this, a guard that refused
    // everything would pass every test above.
    const result = await callHandler(
      callback.GET,
      callbackRequest({ state: GOOD_STATE, cookie: GOOD_STATE }),
    );

    // Step 2: no `code`. Reaching this status is the proof the state matched.
    assert.equal(result.status, 400);
    assert.deepEqual(result.body, { error: "Missing authorization code" });
    assert.equal(await settingsFileExists(), false);
  });

  it("with a matching state AND a code, gets as far as the credential read", async () => {
    // Step 3. This is the last observable step before `exchangeCode` and
    // `addAccount`, and it is where the ordering argument bottoms out: the
    // rejected cases above never produce this status.
    const result = await callHandler(
      callback.GET,
      callbackRequest({ state: GOOD_STATE, cookie: GOOD_STATE, code: "abc" }),
    );
    assert.equal(result.status, 500);
    assert.deepEqual(result.body, { error: "OAuth credentials not configured" });
    assert.equal(await accountWasWritten(), false);
  });
});

describe("the accounts route that issues the state", () => {
  it("issues an httpOnly, SameSite=Lax, callback-scoped cookie whose value is in the auth URL", async () => {
    // `generateAuthUrl` builds a URL locally, so this needs credentials on disk
    // but no network.
    const { writeFile, mkdir } = await import("node:fs/promises");
    await mkdir(join(harness.home, ".email-agent"), { recursive: true });
    await writeFile(
      OAUTH_PATH,
      JSON.stringify({ clientId: "test-client", clientSecret: "test-secret" }),
    );

    const result = await callHandler<{ authUrl: string }>(
      accounts.POST,
      buildRequest("/api/accounts", { method: "POST", body: { action: "add" } }),
    );
    assert.equal(result.status, 200);

    const issued = cookieValue(result.setCookies, OAUTH_STATE_COOKIE);
    assert.ok(issued, `no ${OAUTH_STATE_COOKIE} cookie was set`);
    assert.ok(
      issued.length >= 32,
      `state must be unguessable, saw ${String(issued.length)} chars`,
    );

    const attributes = cookieAttributes(result.setCookies, OAUTH_STATE_COOKIE);
    assert.ok(attributes.includes("httponly"), "script must not be able to read it");
    assert.ok(attributes.includes("samesite=lax"), "Lax so Google's redirect carries it");
    assert.ok(
      attributes.includes("path=/api/auth/callback"),
      "scoped to the callback, so it is not attached to every other request",
    );
    assert.ok(
      !attributes.includes("secure"),
      "the app is served over plain http on localhost; Secure would drop the cookie",
    );

    // The value Google is asked to echo back is the value in the cookie.
    const sent = new URL(result.body.authUrl).searchParams.get("state");
    assert.equal(sent, issued);
    // And the redirect Google is given is this server's own callback.
    assert.equal(
      new URL(result.body.authUrl).searchParams.get("redirect_uri"),
      "http://localhost:3847/api/auth/callback",
    );
  });

  it("issues a different state every time, so one cannot be replayed", async () => {
    const first = await callHandler(
      accounts.POST,
      buildRequest("/api/accounts", { method: "POST", body: { action: "add" } }),
    );
    const second = await callHandler(
      accounts.POST,
      buildRequest("/api/accounts", { method: "POST", body: { action: "add" } }),
    );
    assert.notEqual(
      cookieValue(first.setCookies, OAUTH_STATE_COOKIE),
      cookieValue(second.setCookies, OAUTH_STATE_COOKIE),
    );
  });

  it("round-trips a freshly issued state through the callback", async () => {
    // THE WHOLE FLOW, minus Google. The state the accounts route put in the
    // cookie is handed back exactly as Google would hand it back, and the
    // callback accepts it — reaching the missing-code step rather than 403.
    const issue = await callHandler(
      accounts.POST,
      buildRequest("/api/accounts", { method: "POST", body: { action: "add" } }),
    );
    const state = cookieValue(issue.setCookies, OAUTH_STATE_COOKIE);
    assert.ok(state);

    const accepted = await callHandler(
      callback.GET,
      callbackRequest({ state, cookie: state }),
    );
    assert.equal(accepted.status, 400, "a matching state must get past the guard");

    // And the same cookie with somebody else's state does not.
    const refused = await callHandler(
      callback.GET,
      callbackRequest({ state: `${state}x`, cookie: state }),
    );
    assert.equal(refused.status, 403);
  });

  it("still refuses a cross-site POST to the accounts route itself", async () => {
    // The callback is exempt from the shared guard; the route that ISSUES the
    // state is not, so a hostile page cannot mint one.
    const result = await callHandler(
      accounts.POST,
      buildRequest("/api/accounts", {
        method: "POST",
        body: { action: "add" },
        sameOrigin: false,
        headers: { origin: "http://evil.example", "sec-fetch-site": "cross-site" },
      }),
    );
    assert.equal(result.status, 403);
    assert.equal(cookieValue(result.setCookies, OAUTH_STATE_COOKIE), null);
  });

  it("refuses a bare POST with no Origin and no Sec-Fetch-Site", async () => {
    const result = await callHandler(
      accounts.POST,
      buildRequest("/api/accounts", {
        method: "POST",
        body: { action: "add" },
        sameOrigin: false,
      }),
    );
    assert.equal(result.status, 403);
    assert.match(String((result.body as { error: string }).error), /Origin/);
  });
});
