import { NextResponse, type NextRequest } from "next/server";
import {
  listAccounts,
  addAccount,
  removeAccount,
  setDefaultAccount,
  getOAuthCredentials,
  generateAuthUrl,
} from "@email-agent/core/gmail";

export async function GET() {
  try {
    const accounts = await listAccounts();
    return NextResponse.json(accounts);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      action: string;
      email?: string;
    };

    if (body.action === "add") {
      const creds = await getOAuthCredentials();
      if (!creds) {
        return NextResponse.json(
          { error: "OAuth credentials not configured. Run setup first." },
          { status: 400 },
        );
      }

      const authUrl = generateAuthUrl(
        creds,
        "http://localhost:3847/api/auth/callback",
      );
      return NextResponse.json({ authUrl });
    }

    if (body.action === "setDefault") {
      if (!body.email) {
        return NextResponse.json(
          { error: "email is required" },
          { status: 400 },
        );
      }
      await setDefaultAccount(body.email);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json(
      { error: `Unknown action: ${body.action}` },
      { status: 400 },
    );
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  try {
    const body = (await request.json()) as { email: string };

    if (!body.email) {
      return NextResponse.json(
        { error: "email is required" },
        { status: 400 },
      );
    }

    await removeAccount(body.email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
