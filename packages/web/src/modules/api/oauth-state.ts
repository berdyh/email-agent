import { randomBytes, timingSafeEqual } from "node:crypto";
import type { NextRequest, NextResponse } from "next/server";

export const OAUTH_STATE_COOKIE = "email_agent_oauth_state";

const STATE_TTL_SECONDS = 600;

// Derive the OAuth redirect URI from the request origin so the callback comes
// back to THIS server, whatever port it is on (the CLI supports
// `serve --port N`). Both auth-url generation and code exchange must call this
// with the same request-derived origin so a single flow stays self-consistent.
// NOTE: this exact origin + path (e.g. http://localhost:3847/api/auth/callback)
// must be registered as an authorized redirect URI in the Google Cloud console,
// or Google rejects the flow.
export function getOAuthRedirectUri(request: NextRequest): string {
  return new URL("/api/auth/callback", request.nextUrl.origin).toString();
}

// The app runs on a plain-http localhost origin, so `secure` must stay off or
// browsers would drop the cookie. Path-scoping to the callback keeps the state
// value out of every other request.
const COOKIE_OPTIONS = {
  httpOnly: true,
  sameSite: "lax",
  secure: false,
  path: "/api/auth/callback",
} as const;

export function generateOAuthState(): string {
  return randomBytes(32).toString("base64url");
}

export function setOAuthStateCookie(response: NextResponse, state: string): void {
  response.cookies.set(OAUTH_STATE_COOKIE, state, {
    ...COOKIE_OPTIONS,
    maxAge: STATE_TTL_SECONDS,
  });
}

export function clearOAuthStateCookie(response: NextResponse): void {
  response.cookies.set(OAUTH_STATE_COOKIE, "", {
    ...COOKIE_OPTIONS,
    maxAge: 0,
  });
}

export function isValidOAuthState(
  request: NextRequest,
  state: string | null,
): boolean {
  const expected = request.cookies.get(OAUTH_STATE_COOKIE)?.value;
  if (!expected || !state) return false;

  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(state);
  return (
    expectedBuffer.length === receivedBuffer.length &&
    timingSafeEqual(expectedBuffer, receivedBuffer)
  );
}
