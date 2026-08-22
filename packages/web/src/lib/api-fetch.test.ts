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
const { UNLOCK_REQUIRED_CODE } = (await import(
  "../modules/api/auth-contract.js"
)) as typeof import("../modules/api/auth-contract.js");

const originalFetch = globalThis.fetch;

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
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

    const assigned: string[] = [];
    (globalThis as { window?: unknown }).window = {
      location: { assign: (url: string) => assigned.push(url) },
    };

    await assert.rejects(() => apiFetch("/api/whatever"), UnlockRequiredError);
    assert.deepEqual(assigned, ["/unlock"]);
  });

  it("does not redirect for the unlock-required code without a window (no DOM to redirect)", async () => {
    globalThis.fetch = (async () =>
      jsonResponse(401, { error: "locked", code: UNLOCK_REQUIRED_CODE })) as typeof fetch;
    // No `window` stubbed — matches this file's default Node environment.
    const response = await apiFetch("/api/whatever");
    assert.equal(response.status, 401);
  });
});
