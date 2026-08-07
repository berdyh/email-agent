import { NextResponse, type NextRequest } from "next/server";
import {
  listSnapshots,
  restoreSnapshot,
  UnsafeActionSourceError,
} from "@email-agent/core/actions";
import {
  internalErrorResponse,
  mutationGuardResponse,
  parseSnapshotRestoreRequest,
  parseUserActionDeleteRequest,
  validationResponse,
} from "@/modules/api/validation";

export async function GET(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  try {
    const filename = parseUserActionDeleteRequest({
      filename: request.nextUrl.searchParams.get("filename"),
    }).filename;

    const snapshots = await listSnapshots(filename);
    return NextResponse.json(snapshots);
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    return internalErrorResponse(err, "Failed to list action snapshots");
  }
}

export async function POST(request: NextRequest) {
  const guard = mutationGuardResponse(request);
  if (guard) return guard;

  let snapshotFilename = "That version";
  try {
    const body = parseSnapshotRestoreRequest(await request.json());
    snapshotFilename = body.snapshotFilename;

    await restoreSnapshot(body.snapshotFilename, body.originalFilename);
    return NextResponse.json({ success: true });
  } catch (err) {
    const validation = validationResponse(err);
    if (validation) return validation;

    // A SOURCE-GUARD REFUSAL IS NOT A SERVER ERROR. `restoreSnapshot` writes
    // through `saveUserAction`, which re-validates, so a snapshot taken before
    // the guard existed — or hand-edited since — is refused with the exact
    // rules it broke. Reporting that as a 500 "Failed to restore action
    // snapshot" leaves the user with an unrecoverable action and no idea why,
    // while the CLI prints the rules. Same information, same status class as
    // the save route's 422.
    if (err instanceof UnsafeActionSourceError) {
      return NextResponse.json(
        {
          error: `${snapshotFilename} does not pass the action source guard.`,
          violations: err.violations,
        },
        { status: 422 },
      );
    }

    return internalErrorResponse(err, "Failed to restore action snapshot");
  }
}
