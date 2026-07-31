import { NextResponse, type NextRequest } from "next/server";
import {
  listAccounts,
  removeAccount,
  setDefaultAccount,
  getOAuthCredentials,
  generateAuthUrl,
} from "@email-agent/core/gmail";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseAccountDeleteRequest,
  parseAccountPostRequest,
  validationResponse,
} from "@/modules/api/validation";
import {
  getOAuthRedirectUri,
  generateOAuthState,
  setOAuthStateCookie,
} from "@/modules/api/oauth-state";

export async function GET() {
  try {
    const accounts = await listAccounts();
    return NextResponse.json(accounts);
  } catch (err) {
    return internalErrorResponse(err, "Failed to load accounts");
  }
}

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseAccountPostRequest(await request.json());

    if (body.action === "add") {
      const creds = await getOAuthCredentials();
      if (!creds) {
        return NextResponse.json(
          { error: "OAuth credentials not configured. Run setup first." },
          { status: 400 },
        );
      }

      const state = generateOAuthState();
      const authUrl = generateAuthUrl(creds, getOAuthRedirectUri(request), state);
      const response = NextResponse.json({ authUrl });
      setOAuthStateCookie(response, state);
      return response;
    }

    if (body.action === "setDefault") {
      await setDefaultAccount(body.email);
      return NextResponse.json({ ok: true });
    }

    return NextResponse.json({ error: "Unknown action" }, { status: 400 });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to update account");
  }
}

export async function DELETE(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const body = parseAccountDeleteRequest(await request.json());

    await removeAccount(body.email);
    return NextResponse.json({ ok: true });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to remove account");
  }
}
