import { NextResponse, type NextRequest } from "next/server";
import {
  exchangeCode,
  getOAuthCredentials,
  addAccount,
} from "@email-agent/core/gmail";

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code");

  if (!code) {
    return NextResponse.json(
      { error: "Missing authorization code" },
      { status: 400 },
    );
  }

  try {
    const creds = await getOAuthCredentials();
    if (!creds) {
      return NextResponse.json(
        { error: "OAuth credentials not configured" },
        { status: 500 },
      );
    }

    const redirectUri = "http://localhost:3847/api/auth/callback";
    const { email } = await exchangeCode(creds, code, redirectUri);

    await addAccount({ email, isDefault: true });

    return NextResponse.redirect(
      new URL("/?account_added=true", request.nextUrl.origin),
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
