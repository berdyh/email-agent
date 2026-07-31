import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCode,
  getOAuthCredentials,
  addAccount,
} from "@email-agent/core/gmail";
import {
  getOAuthRedirectUri,
  clearOAuthStateCookie,
  isValidOAuthState,
} from "@/modules/api/oauth-state";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");
  const state = request.nextUrl.searchParams.get("state");

  // Login-CSRF guard: only complete the flow when the state parameter matches
  // the value this app issued alongside the auth URL.
  if (!isValidOAuthState(request, state)) {
    const response = NextResponse.json(
      { error: "Missing or invalid OAuth state" },
      { status: 403 },
    );
    clearOAuthStateCookie(response);
    return response;
  }

  if (!code) {
    const response = NextResponse.json(
      { error: "Missing authorization code" },
      { status: 400 },
    );
    clearOAuthStateCookie(response);
    return response;
  }

  try {
    const creds = await getOAuthCredentials();
    if (!creds) {
      const response = NextResponse.json(
        { error: "OAuth credentials not configured" },
        { status: 500 },
      );
      clearOAuthStateCookie(response);
      return response;
    }

    const { email } = await exchangeCode(creds, code, getOAuthRedirectUri(request));

    await addAccount({ email, isDefault: false });

    const response = NextResponse.redirect(new URL("/", request.nextUrl.origin));
    clearOAuthStateCookie(response);
    return response;
  } catch (err) {
    // Mirror internalErrorResponse's shape/logging, but clear the one-time state
    // cookie too so a failed exchange doesn't leave a stale state behind.
    console.error(err);
    const response = NextResponse.json(
      { error: "OAuth callback failed" },
      { status: 500 },
    );
    clearOAuthStateCookie(response);
    return response;
  }
}
