import { NextResponse, type NextRequest } from "next/server";
import { syncEmails, type FetchOptions } from "@email-agent/core/gmail";

export const dynamic = "force-dynamic";

let fetching = false;

export async function POST(request: NextRequest) {
  if (fetching) {
    return NextResponse.json(
      { error: "Fetch already in progress" },
      { status: 409 },
    );
  }

  try {
    fetching = true;

    const body = (await request.json()) as Partial<FetchOptions>;
    const options: FetchOptions = {
      scope: body.scope === "all" ? "all" : "unread",
      maxResults: body.maxResults ?? 50,
    };

    const result = await syncEmails(options);
    return NextResponse.json(result);
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";

    if (message.includes("auth") || message.includes("token")) {
      return NextResponse.json({ error: message }, { status: 401 });
    }

    return NextResponse.json({ error: message }, { status: 500 });
  } finally {
    fetching = false;
  }
}
