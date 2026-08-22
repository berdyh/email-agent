import {
  BINDING_REQUIRED_CODE,
  SESSION_BINDING_HEADER,
  UNLOCK_REASON_BINDING,
  UNLOCK_REASON_PARAM,
  UNLOCK_REQUIRED_CODE,
} from "@/modules/api/auth-contract";
import { readSessionBinding } from "@/lib/session-binding";

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
 * `fetch()`, plus TWO things this app's call sites otherwise each have to
 * remember by hand.
 *
 * ONE — IT ATTACHES THE SECOND FACTOR. The session cookie is not sufficient on
 * its own: cookies are not scoped by port, so a sibling loopback port can be
 * handed this app's cookie and replay it. `SESSION_BINDING_HEADER` carries an
 * opaque value out of ORIGIN-scoped `localStorage` (an origin includes the
 * port), and the API guard requires it alongside the cookie. THIS IS THE ONLY
 * PLACE THE HEADER IS ADDED, which is precisely why every API call in this app
 * has to come through here — a bare `fetch()` to a guarded route now 401s.
 * See `lib/session-binding.ts` and core's `SESSION_BINDING_HEADER`.
 *
 * TWO — IT ROUTES A LAPSED SESSION SOMEWHERE RECOVERABLE. When a 401 carries
 * `{ code: UNLOCK_REQUIRED_CODE }`, send the TAB to `/unlock` instead of
 * leaving the caller to render an indistinguishable "failed to fetch" error
 * for a session that simply expired mid-use. A 401 carrying
 * `BINDING_REQUIRED_CODE` goes to the same page with
 * `?reason=binding`, because that user is in a DIFFERENT situation — a live
 * session whose second factor this browser does not have — and telling them
 * they are not unlocked, when they can see they are, reads as a broken app.
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
  // Merged onto the caller's own headers rather than replacing them: the
  // streaming chat call and every JSON POST set `content-type` here.
  const headers = new Headers(init?.headers);
  const binding = readSessionBinding();
  if (binding !== undefined) headers.set(SESSION_BINDING_HEADER, binding);

  const response = await fetch(input, { ...init, headers });
  if (response.status === 401) {
    let code: unknown;
    try {
      code = ((await response.clone().json()) as { code?: unknown } | null)?.code;
    } catch {
      // Not JSON, or the body was empty — fall through and let the caller
      // handle this 401 as an ordinary failed response.
    }
    if (typeof window !== "undefined") {
      if (code === BINDING_REQUIRED_CODE) {
        window.location.assign(`/unlock?${UNLOCK_REASON_PARAM}=${UNLOCK_REASON_BINDING}`);
        throw new UnlockRequiredError();
      }
      if (code === UNLOCK_REQUIRED_CODE) {
        window.location.assign("/unlock");
        throw new UnlockRequiredError();
      }
    }
  }
  return response;
}
