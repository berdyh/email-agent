import { NextResponse, type NextRequest } from "next/server";
import { getEmailById, updateEmailReadStatus } from "@email-agent/core/db";
import { markAsRead, markAsUnread } from "@email-agent/core/gmail";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const email = await getEmailById(id);
    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    // Fire-and-forget: mark as read in Gmail + local DB
    if (email.isUnread) {
      void Promise.all([
        markAsRead(id),
        updateEmailReadStatus(id, false),
      ]).catch(() => {});
    }

    return NextResponse.json({ ...email, isUnread: false });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    const body = (await request.json()) as { isUnread: boolean };
    const { isUnread } = body;

    const email = await getEmailById(id);
    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    if (isUnread) {
      await markAsUnread(id);
    } else {
      await markAsRead(id);
    }
    await updateEmailReadStatus(id, isUnread);

    return NextResponse.json({ id, isUnread });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
