/**
 * `apiFetch` is a plain function over the standard `fetch`/`Response`
 * globals plus `window.location`, so it is testable in Node without a DOM —
 * `window` simply does not exist here by default, which is exactly what lets
 * the `typeof window !== "undefined"` guard be exercised by stubbing it in
 * for one test and leaving it absent for the rest.
 */

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { registerWebModuleAliases } from "../modules/api/testing/route-harness.js";

// `api-fetch.ts` imports `@/modules/api/auth-contract` with the `@/` alias
// webpack resolves for the real app — register the same alias hook the route
// tests use before importing anything that pulls it in transitively.
registerWebModuleAliases();

const { apiFetch, UnlockRequiredError } = (await import(
  "./api-fetch.js"
)) as typeof import("./api-fetch.js");
const {
  BINDING_REQUIRED_CODE,
  SESSION_BINDING_HEADER,
  SESSION_BINDING_STORAGE_KEY,
  UNLOCK_REQUIRED_CODE,
} = (await import("../modules/api/auth-contract.js")) as typeof import(
  "../modules/api/auth-contract.js"
);

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/**
 * Stands a minimal `window` in, with an optional `localStorage`.
 *
 * `apiFetch` reads the second factor through `lib/session-binding.ts`, which
 * touches `window.localStorage` — so the two states that matter to test here
 * are "the browser has a factor" and "it does not", plus the throwing
 * `localStorage` a browser with site storage blocked really presents.
 */
function stubWindow(options: { binding?: string; storageThrows?: boolean } = {}): string[] {
  const assigned: string[] = [];
  const storage = options.storageThrows
    ? {
        getItem: () => {
          throw new Error("storage is blocked for this site");
        },
        setItem: () => {
          throw new Error("storage is blocked for this site");
        },
      }
    : {
        getItem: (key: string) =>
          key === SESSION_BINDING_STORAGE_KEY && options.binding !== undefined
            ? options.binding
            : null,
        setItem: () => {},
      };
  (globalThis as { window?: unknown }).window = {
    location: { assign: (url: string) => assigned.push(url) },
    localStorage: storage,
  };
  return assigned;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  Reflect.deleteProperty(globalThis, "window");
});

describe("apiFetch", () => {
  it("passes a 200 straight through, unread and unmodified", async () => {
    globalThis.fetch = (async () => jsonResponse(200, { ok: true })) as typeof fetch;
    const response = await apiFetch("/api/whatever");
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  });

  it("passes a 401 with a DIFFERENT code straight through — the caller handles it", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(401, { error: "nope", code: "some-other-code" })) as typeof fetch;
    const response = await apiFetch("/api/whatever");
    assert.equal(response.status, 401);
    // Still readable by the caller — apiFetch only ever reads a CLONE.
    assert.deepEqual(await response.json(), { error: "nope", code: "some-other-code" });
  });

  it("passes a 401 with no JSON body straight through rather than throwing", async () => {
    globalThis.fetch = (async () => new Response("not json", { status: 401 })) as typeof fetch;
    const response = await apiFetch("/api/whatever");
    assert.equal(response.status, 401);
  });

  it("redirects to /unlock and throws on the unlock-required code", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(401, { error: "locked", code: UNLOCK_REQUIRED_CODE })) as typeof fetch;

    const assigned = stubWindow();

    await assert.rejects(() => apiFetch("/api/whatever"), UnlockRequiredError);
    assert.deepEqual(assigned, ["/unlock"]);
  });

  it("attaches the second factor when the browser has one", async () => {
    // THIS IS THE ONLY PLACE THE HEADER IS ADDED. If it stops being attached,
    // every guarded route in the app answers 401 — so this is not a cosmetic
    // assertion about a header name.
    let seen: Headers | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    stubWindow({ binding: "the-second-factor" });

    await apiFetch("/api/whatever");
    assert.equal(seen?.get(SESSION_BINDING_HEADER), "the-second-factor");
  });

  it("does not clobber the caller's own headers when it attaches the factor", async () => {
    // The streaming chat call and every JSON POST set `content-type`; an
    // `init.headers` replacement rather than a merge would silently break them.
    let seen: Headers | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    stubWindow({ binding: "the-second-factor" });

    await apiFetch("/api/whatever", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(seen?.get("content-type"), "application/json");
    assert.equal(seen?.get(SESSION_BINDING_HEADER), "the-second-factor");
  });

  it("omits the header entirely when the browser has no factor, rather than sending an empty one", async () => {
    let seen: Headers | undefined;
    globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
      seen = new Headers(init?.headers);
      return jsonResponse(200, { ok: true });
    }) as unknown as typeof fetch;
    stubWindow();

    await apiFetch("/api/whatever");
    assert.equal(seen?.has(SESSION_BINDING_HEADER), false);
  });

  it("survives a localStorage that throws, instead of taking out the fetch layer", async () => {
    // Real browsers throw here: Safari private mode historically, and any
    // browser configured to block storage for a site. Degrading to "no
    // factor" gives the user a 401 they can act on; a throw would give them a
    // blank page.
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return jsonResponse(200, { ok: true });
    }) as typeof fetch;
    stubWindow({ storageThrows: true });

    const response = await apiFetch("/api/whatever");
    assert.equal(called, true);
    assert.equal(response.status, 200);
  });

  it("sends a binding-required 401 to /unlock?reason=binding, not the bare page", async () => {
    // A user whose cookie is fine but whose factor is missing is in a
    // DIFFERENT situation from one with no session, and needs different copy —
    // telling them they are locked out when they can see the app shell reads
    // as a broken app. The reason param is what lets the unlock screen say so.
    globalThis.fetch = (async () =>
      jsonResponse(401, { error: "wrong browser", code: BINDING_REQUIRED_CODE })) as typeof fetch;
    const assigned = stubWindow({ binding: "stale-factor" });

    await assert.rejects(() => apiFetch("/api/whatever"), UnlockRequiredError);
    assert.deepEqual(assigned, ["/unlock?reason=binding"]);
  });

  it("does not redirect for the unlock-required code without a window (no DOM to redirect)", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(401, { error: "locked", code: UNLOCK_REQUIRED_CODE })) as typeof fetch;
    // No `window` stubbed — matches this file's default Node environment.
    const response = await apiFetch("/api/whatever");
    assert.equal(response.status, 401);
  });
});
