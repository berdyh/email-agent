import { NextResponse, type NextRequest } from "next/server";
import { getEmailById, initDb, updateEmailReadStatus } from "@email-agent/core/db";
// Deep path on purpose: the gmail barrel no longer exports write operations
// (approval-gate bypass hardening). This specifier only resolves here because
// webpack bundles core source via tsconfig paths; Node's package exports map
// refuses it, so no by-name import from outside this bundle can reach the write
// ops. User action files are not among the callers either way — they are parsed
// as pure data and never imported, so nothing in `ACTIONS_DIR` executes.
import { markAsRead, markAsUnread } from "@email-agent/core/gmail/operations";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseEmailIdentityQuery,
  parseEmailReadStatusRequest,
  readGuardResponse,
  validationResponse,
} from "@/modules/api/validation";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Returns the full message body; guard it like the other mail reads.
  const guard = readGuardResponse(request);
  if (guard) return guard;

  const { id } = await params;

  try {
    const { accountId } = parseEmailIdentityQuery(request.nextUrl.searchParams);
    await initDb();
    const email = await getEmailById(id, accountId);
    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    return NextResponse.json(email);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

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
    const { accountId } = parseEmailIdentityQuery(request.nextUrl.searchParams);
    const { isUnread } = parseEmailReadStatusRequest(await request.json());

    await initDb();
    const email = await getEmailById(id, accountId);
    if (!email) {
      return NextResponse.json({ error: "Email not found" }, { status: 404 });
    }

    if (isUnread) {
      await markAsUnread(id, email.accountId);
    } else {
      await markAsRead(id, email.accountId);
    }
    await updateEmailReadStatus(id, isUnread, email.accountId);

    return NextResponse.json({ id, accountId: email.accountId, isUnread });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to update read status");
  }
}
