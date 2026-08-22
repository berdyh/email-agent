import { UNLOCK_REQUIRED_CODE } from "@/modules/api/auth-contract";

/**
 * Thrown by `apiFetch` when it redirects the tab instead of returning a
 * response. The caller never has to handle it directly — the navigation is
 * already under way by the time it is thrown — but it exists as a distinct
 * type so it is never mistaken for an ordinary "failed to fetch" error a
 * caller might otherwise try to render inline.
 */
export class UnlockRequiredError extends Error {
  constructor() {
    super("This browser's session has expired. Redirecting to the unlock page.");
    this.name = "UnlockRequiredError";
  }
}

/**
 * `fetch()`, plus ONE thing this app's ~12 call sites otherwise each have to
 * remember by hand: when a 401 carries `{ code: UNLOCK_REQUIRED_CODE }`, send
 * the TAB to `/unlock` instead of leaving the caller to render an
 * indistinguishable "failed to fetch" error for a session that simply
 * expired mid-use.
 *
 * WHY THIS MATTERS ON TOP OF THE PAGE GATE. `(app)/layout.tsx` only runs on a
 * cold load/full navigation — every page under it is `"use client"` with its
 * own client-side data fetching (AGENTS.md's H6), so a session that lapses
 * while the SPA is already mounted is invisible to that layout until the
 * user reloads. This is what covers the gap: the API guard already answers
 * 401 the moment the cookie stops validating, and this is what a client
 * caller does about seeing one.
 *
 * DELIBERATELY NARROW. This is the interceptor, not a retry/backoff layer or
 * a general HTTP client. Every status other than a session-expired 401, and
 * every network error, passes straight through unchanged — a caller's
 * existing `if (!res.ok) throw ...` keeps working exactly as it did against
 * bare `fetch()`. `response.clone()` is what makes reading the body to check
 * for the code safe: the ORIGINAL response, with its body stream intact, is
 * what every other caller gets back, so a streaming caller (`use-action-chat
 * .ts`'s `res.body.getReader()`) is unaffected on any status other than a
 * session-expired 401 — which a stream never is, since that response has no
 * body to stream in the first place.
 */
export async function apiFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const response = await fetch(input, init);
  if (response.status === 401) {
    let code: unknown;
    try {
      code = ((await response.clone().json()) as { code?: unknown } | null)?.code;
    } catch {
      // Not JSON, or the body was empty — fall through and let the caller
      // handle this 401 as an ordinary failed response.
    }
    if (code === UNLOCK_REQUIRED_CODE && typeof window !== "undefined") {
      window.location.assign("/unlock");
      throw new UnlockRequiredError();
    }
  }
  return response;
}
