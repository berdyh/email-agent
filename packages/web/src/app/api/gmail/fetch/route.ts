import { NextResponse, type NextRequest } from "next/server";
import { syncEmails } from "@email-agent/core/gmail";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseFetchEmailsRequest,
  validationResponse,
} from "@/modules/api/validation";

export const dynamic = "force-dynamic";

let fetching = false;

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  if (fetching) {
    return NextResponse.json(
      { error: "Fetch already in progress" },
      { status: 409 },
    );
  }

  try {
    fetching = true;

    const options = parseFetchEmailsRequest(await request.json());

    const result = await syncEmails(options);
    return NextResponse.json(result);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    const message = err instanceof Error ? err.message : "Unknown error";

    if (message.includes("auth") || message.includes("token")) {
      // `code` is the typed classification clients branch on, so the UI never
      // has to re-parse this human-readable message to detect an auth failure.
      return NextResponse.json(
        {
          error: "Gmail authentication failed. Reconnect the account or rerun setup.",
          code: "auth",
        },
        { status: 401 },
      );
    }

    return internalErrorResponse(err, "Failed to fetch emails");
  } finally {
    fetching = false;
  }
}
