import { NextResponse, type NextRequest } from "next/server";
import { getEmailById, initDb, updateEmailReadStatus } from "@email-agent/core/db";
import { markAsRead, markAsUnread } from "@email-agent/core/gmail";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseEmailReadStatusRequest,
  validationResponse,
} from "@/modules/api/validation";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params;

  try {
    await initDb();
    const email = await getEmailById(id);
    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    // Fire-and-forget: mark as read in Gmail + local DB
    if (email.isUnread) {
      const guard = mutationGuardResponse(request);
      if (guard) return guard;

      void Promise.all([
        markAsRead(id, email.accountId || undefined),
        updateEmailReadStatus(id, false),
      ]).catch(() => {});
    }

    return NextResponse.json({ ...email, isUnread: false });
  } catch (err) {
    return internalErrorResponse(err, "Failed to load email");
  }
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  const { id } = await params;

  try {
    const { isUnread } = parseEmailReadStatusRequest(await request.json());

    await initDb();
    const email = await getEmailById(id);
    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    if (isUnread) {
      await markAsUnread(id, email.accountId || undefined);
    } else {
      await markAsRead(id, email.accountId || undefined);
    }
    await updateEmailReadStatus(id, isUnread);

    return NextResponse.json({ id, isUnread });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to update read status");
  }
}
